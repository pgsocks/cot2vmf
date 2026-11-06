#!/usr/bin/env python3
"""Black-box service workflows using synthetic, non-operational schemas."""
import copy
import http.client
import json
import os
from pathlib import Path
import select
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request


EVENT = (b'<event version="2.0" uid="synthetic-service" type="a-f-G" '
         b'time="2026-01-01T00:00:00Z" start="2026-01-01T00:00:00Z" '
         b'stale="2026-01-01T00:01:00Z" how="m-g">'
         b'<point lat="1.25" lon="-2.5" hae="0" ce="0" le="0"/>'
         b'<detail><contact callsign="synthetic"/></detail></event>')

ENTRYPOINT = Path(__file__).resolve().parents[2] / "entrypoint.sh"
ENTRYPOINT_RUNTIME_ENV = ("COT_VMF_WORKSPACE", "COT_VMF_WEB_LISTEN",
                         "COT_VMF_LOG_FORMAT", "COT_VMF_COT_LISTEN",
                         "COT_VMF_VMF_TARGET")
ENTRYPOINT_ENV = ENTRYPOINT_RUNTIME_ENV + (
    "COT_VMF_CONFIG_FILE", "COT_VMF_SCHEMAS", "COT_VMF_MAPPINGS", "COT_VMF_SET")


def fixture():
    elements = [
        {"key": "latitude", "number_of_bits": 32,
         "type": "twos_complement",
         "scale": {"factor": {"numerator": 1, "denominator": 100000},
                   "bias": {"numerator": 0, "denominator": 1}}},
        {"key": "longitude", "number_of_bits": 32,
         "type": "twos_complement",
         "scale": {"factor": {"numerator": 1, "denominator": 100000},
                   "bias": {"numerator": 0, "denominator": 1}}},
        {"key": "identifier", "number_of_bits": 224,
         "type": "literal"},
    ]
    schema = {"format": "vmf-schema/1",
              "message_standard": "MIL-STD-6017B", "messages": [
                  {"message_number": f"K01.{n}", "elements": elements}
                  for n in (1, 2)]}
    outputs = []
    for n in (1, 2):
        outputs.append({"id": f"position-{n}", "enabled": True, "mapping": {
            "format": "cot-vmf-mapping-config/1", "schema": "synthetic",
            "message": n - 1, "envelope": "C",
            "fields": [
                {"cot": "point.latitude", "vmf": {"key": "latitude"}},
                {"cot": "point.longitude", "vmf": {"key": "longitude"}},
                {"cot": "uid", "vmf": {"key": "identifier"}}]}})
    return {"format": "cot-vmf-workspace/1",
            "schemas": [{"id": "synthetic", "document": schema}],
            "outputs": outputs}


def unused_port(kind):
    with socket.socket(socket.AF_INET, kind) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def command(binary, *arguments, status=0, environment=None):
    result = subprocess.run([binary, *map(str, arguments)],
                            capture_output=True, timeout=10, env=environment)
    assert result.returncode == status, (
        f"{arguments[0]} returned {result.returncode}, expected {status}: " +
        result.stderr.decode())
    return result


def configure(binary, root, *arguments, status=0):
    return command(binary, "config", "--workspace", root,
                   *arguments, status=status)


def exported(binary, root, active=False):
    arguments = ["export", "--workspace", root]
    if active:
        arguments.append("--active")
    return json.loads(command(binary, *arguments).stdout)


def saved_files(root):
    return {name: (root / name).read_bytes()
            for name in ("active.json", "draft.json")
            if (root / name).exists()}


def configuration(binary, root):
    source = root.parent / "initial.json"
    source.write_text(json.dumps(fixture()))
    command(binary, "validate", source)
    configure(binary, root, "--config", source)
    assert exported(binary, root) == fixture()
    assert exported(binary, root, active=True) == fixture()
    environment = dict(os.environ, COT_VMF_WORKSPACE=str(root))
    assert json.loads(command(binary, "export", environment=environment).stdout) == fixture()
    before = saved_files(root)
    command(binary, "validate", "--workspace", root)
    configure(binary, root, "--if-uninitialized", "--config", "missing.json",
              "--set", "not a valid assignment")
    assert saved_files(root) == before

    configure(binary, root, "--set", "outputs[0].enabled=false",
              "--config", source)
    expected = fixture()
    expected["outputs"][0]["enabled"] = False
    assert exported(binary, root) == expected, "base import must precede edits"

    schema = root.parent / "schema.json"
    definition = fixture()["schemas"][0]["document"]
    definition["messages"][0]["elements"][0]["number_of_bits"] = 33
    schema.write_text(json.dumps(definition))
    mapping = root.parent / "mapping.json"
    mapping.write_text(json.dumps(fixture()["outputs"][0]["mapping"]))
    configure(binary, root, "--schema", "synthetic=" + str(schema),
              "--mapping", "extra=" + str(mapping))
    assert len(exported(binary, root)["schemas"]) == 1
    assert exported(binary, root)["schemas"][0]["document"] == definition
    assert exported(binary, root)["outputs"][-1]["enabled"]
    definition = fixture()["outputs"][0]["mapping"]
    definition["fields"][0]["factor"] = 2
    mapping.write_text(json.dumps(definition))
    configure(binary, root, "--set", "outputs[2].enabled=false",
              "--mapping", "extra=" + str(mapping),
              "--set", 'outputs[2].mapping.notes.rows[0]={"n":18446744073709551615}',
              "--set", 'outputs[2].mapping.notes.rows[1]={"n":-9223372036854775808}')
    current = exported(binary, root)
    assert not current["outputs"][2]["enabled"], "upsert enabled a disabled mapping"
    assert current["outputs"][2]["mapping"]["fields"][0]["factor"] == 2
    assert current["outputs"][2]["mapping"]["notes"]["rows"] == [
        {"n": 18446744073709551615}, {"n": -9223372036854775808}]
    before = saved_files(root)
    for assignment in ("outputs[2].mapping.notes.rows[3]=0",
                       "outputs[2].mapping.notes.rows[0].n.child=0",
                       "outputs[2].enabled=invalid-json", "outputs[-1]=0"):
        configure(binary, root, "--set", assignment, status=2)
        assert saved_files(root) == before
    malformed = root.parent / "malformed.json"
    malformed.write_text('{"format":')
    for path in (malformed, root.parent / "missing.json"):
        configure(binary, root, "--config", path, status=2)
        assert saved_files(root) == before

    active = exported(binary, root, active=True)
    configure(binary, root, "--set",
              'schemas[0].document.format="invalid"', status=3)
    assert exported(binary, root)["schemas"][0]["document"]["format"] == "invalid"
    assert exported(binary, root, active=True) == active
    command(binary, "validate", "--workspace", root, status=2)
    before = saved_files(root)
    configure(binary, root, "--if-uninitialized", "--config", "missing.json")
    assert saved_files(root) == before, "invalid saved draft was reinitialized"
    configure(binary, root, "--set",
              'schemas[0].document.format="vmf-schema/1"')

    configure(binary, root, "--schema", "second=" + str(schema))
    definition = fixture()["outputs"][0]["mapping"]
    definition["schema"] = "second"
    mapping.write_text(json.dumps(definition))
    configure(binary, root, "--mapping", "second-out=" + str(mapping),
              "--remove-schema", "synthetic")
    current = exported(binary, root)
    assert [row["id"] for row in current["schemas"]] == ["second"]
    assert [row["id"] for row in current["outputs"]] == ["second-out"]
    configure(binary, root, "--remove-mapping", "second-out")
    assert exported(binary, root)["outputs"] == []

    empty_root = root.parent / "empty"
    configure(binary, empty_root, "--if-uninitialized")
    assert exported(binary, empty_root) == {
        "format": "cot-vmf-workspace/1", "schemas": [], "outputs": []}
    invalid_root = root.parent / "first-invalid"
    malformed.write_text('{"format":"invalid","schemas":[],"outputs":[]}')
    configure(binary, invalid_root, "--config", malformed, status=3)
    assert not (invalid_root / "active.json").exists()
    assert exported(binary, invalid_root)["format"] == "invalid"
    service = Service(binary, invalid_root)
    try:
        service.send()
        service.output.settimeout(.2)
        try:
            service.output.recv(65535)
            raise AssertionError("invalid first draft emitted VMF")
        except socket.timeout:
            pass
        assert service.proc.poll() is None
    finally:
        service.close()
    before = saved_files(invalid_root)
    configure(binary, invalid_root, "--if-uninitialized", "--set", "bad")
    assert saved_files(invalid_root) == before

    (invalid_root / "draft.json").write_text('{"corrupt":true}')
    before = saved_files(invalid_root)
    configure(binary, invalid_root, "--if-uninitialized", status=2)
    assert saved_files(invalid_root) == before


class Service:
    def __init__(self, binary, root, config=None, web=False,
                 web_bind="127.0.0.1", launch=None):
        if config:
            configure(binary, root, "--config", config)
        self.input = unused_port(socket.SOCK_DGRAM)
        self.http = unused_port(socket.SOCK_STREAM) if web else None
        self.output = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.output.bind(("127.0.0.1", 0))
        self.output.settimeout(2)
        args = [binary, "run", "--workspace", str(root), "--cot-listen",
                f"127.0.0.1:{self.input}", "--vmf-target",
                f"127.0.0.1:{self.output.getsockname()[1]}",
                "--log-format", "json"]
        if web:
            args += ["--web", f"{web_bind}:{self.http}"]
        environment = None
        if launch:
            args, environment = launch(self, args)
        # Debug HTTP logging can exceed a pipe's capacity during a workflow.
        # Keep diagnostics without blocking the service's worker threads.
        self.errors = tempfile.TemporaryFile()
        self.proc = subprocess.Popen(args, stdout=subprocess.PIPE,
                                     stderr=self.errors, env=environment)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            ready, _, _ = select.select([self.proc.stdout], [], [], .1)
            if ready:
                line = self.proc.stdout.readline()
                if b'"ready"' in line:
                    return
            if self.proc.poll() is not None:
                self.errors.seek(0)
                error = self.errors.read().decode()
                self.errors.close()
                raise AssertionError("service exited before readiness: " +
                                     error)
        self.close()
        raise AssertionError("service did not report readiness")

    def send(self, data=EVENT):
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.sendto(data, ("127.0.0.1", self.input))

    def packets(self, count=2):
        self.send()
        return [self.output.recv(65535) for _ in range(count)]

    def state(self):
        return self.request("GET", "/api/state")

    def request(self, method, path, body=None):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.http}{path}", data=data, method=method,
            headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=5) as response:
            return json.load(response)

    def reload(self):
        self.proc.send_signal(signal.SIGHUP)
        logs = b""
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if select.select([self.proc.stdout], [], [], .1)[0]:
                chunk = os.read(self.proc.stdout.fileno(), 4096)
                assert chunk, "service exited during reload"
                logs += chunk
                assert b'"reload_rejected"' not in logs, logs.decode()
                if b'"reloaded"' in logs:
                    return
        raise AssertionError("saved configuration reload did not finish")

    def close(self):
        if self.proc.poll() is None:
            self.proc.send_signal(signal.SIGTERM)
        try:
            self.proc.communicate(timeout=8)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.communicate()
            raise AssertionError("service failed to stop")
        finally:
            self.errors.seek(0)
            err = self.errors.read()
            self.errors.close()
            self.output.close()
        assert self.proc.returncode == 0, err.decode()


def entrypoint_environment(directory):
    environment = os.environ.copy()
    for name in ENTRYPOINT_ENV:
        environment.pop(name, None)
    environment["PATH"] = str(directory) + os.pathsep + environment["PATH"]
    return environment


def entrypoint_arguments(binary, root):
    directory = root.parent / "bin"
    directory.mkdir()
    capture = directory / "cot-to-vmf"
    capture.write_text("#!" + sys.executable + "\n"
                       "import json, os, sys\n"
                       "with open(os.environ['CAPTURE_CALLS'], 'a') as output:\n"
                       "    output.write(json.dumps(sys.argv[1:]) + '\\n')\n"
                       "key = 'CONFIG_STATUS' if sys.argv[1] == 'config' else 'RUN_STATUS'\n"
                       "sys.exit(int(os.environ.get(key, 0)))\n")
    capture.chmod(0o755)
    environment = entrypoint_environment(directory)
    calls_file = root.parent / "calls.jsonl"
    environment.update(CAPTURE_CALLS=str(calls_file), CONFIG_STATUS="0",
                       RUN_STATUS="0")
    defaults = {"--workspace": "/var/lib/cot-to-vmf",
                "--web": "0.0.0.0:8080", "--log-format": "json",
                "--cot-listen": "0.0.0.0:9001",
                "--vmf-target": "127.0.0.1:9002"}

    def invoke(arguments=(), variables=None, status=0):
        calls_file.write_text("")
        result = subprocess.run(
            [str(ENTRYPOINT), *arguments],
            env=dict(environment, **(variables or {})),
            capture_output=True, text=True, timeout=5)
        assert result.returncode == status, result.stderr
        return [json.loads(line) for line in calls_file.read_text().splitlines()]

    def options(arguments):
        assert arguments[0] == "run", arguments
        pairs = []
        index = 1
        while index < len(arguments):
            key = arguments[index]
            if key == "--no-web":
                pairs.append((key, None))
                index += 1
            elif key == "--web" and (index + 1 == len(arguments) or
                                      arguments[index + 1].startswith("--")):
                pairs.append((key, None))
                index += 1
            else:
                assert index + 1 < len(arguments), arguments
                pairs.append((key, arguments[index + 1]))
                index += 2
        assert len(dict(pairs)) == len(pairs), arguments
        return dict(pairs)

    def initialized(arguments=(), variables=None):
        calls = invoke(arguments, variables)
        assert len(calls) == 2, calls
        runtime = options(calls[1])
        assert calls[0][:4] == ["config", "--if-uninitialized", "--workspace",
                               runtime["--workspace"]], calls
        return runtime, calls[0][4:]

    for arguments in ((), ("run",)):
        runtime, seeds = initialized(arguments)
        assert runtime == defaults and not seeds
    empty = dict.fromkeys(ENTRYPOINT_ENV, "")
    runtime, seeds = initialized(variables=empty)
    expected = {key: value for key, value in defaults.items() if key != "--web"}
    expected["--no-web"] = None
    assert runtime == expected and not seeds
    values = ("a workspace ; $literal", "127.0.0.1:18080", "human",
              "127.0.0.1:19001", "receiver:19002")
    variables = dict(zip(ENTRYPOINT_RUNTIME_ENV, values))
    expected = dict(zip(("--workspace", "--web", "--log-format",
                         "--cot-listen", "--vmf-target"), values))
    assert initialized(variables=variables)[0] == expected
    explicit = [item for pair in defaults.items() for item in pair]
    assert initialized(explicit, variables)[0] == defaults
    assert initialized(["run", *explicit], variables)[0] == defaults
    assert initialized(["run", "--workspace", "--web"])[0] == dict(
        defaults, **{"--workspace": "--web"})
    assert initialized(["run", "--web"])[0] == dict(defaults, **{"--web": None})

    seeds = {"COT_VMF_CONFIG_FILE": "a config ; $literal.json",
             "COT_VMF_SCHEMAS": "one=a schema.json\n\ntwo=other.json",
             "COT_VMF_MAPPINGS": "mapped=map.json\n",
             "COT_VMF_SET": 'outputs[0].enabled=false\noutputs[1].mapping.note="$;"'}
    assert initialized(variables=seeds)[1] == [
        "--config", seeds["COT_VMF_CONFIG_FILE"], "--schema", "one=a schema.json",
        "--schema", "two=other.json", "--mapping", "mapped=map.json",
        "--set", "outputs[0].enabled=false",
        "--set", 'outputs[1].mapping.note="$;"']
    assert len(invoke(variables={"CONFIG_STATUS": "3"})) == 2
    assert len(invoke(variables={"CONFIG_STATUS": "2"}, status=2)) == 1
    assert len(invoke(variables={"CONFIG_STATUS": "1"}, status=1)) == 1
    for arguments in (["--help"], ["--version"], ["help"], ["unknown-command"],
                      ["config", "--config", "a file.json"], ["export", "--active"],
                      ["validate", "a config ; $literal.json"],
                      ["run", "--help"], ["run", "--web", "--help"],
                      ["run", "--workspace"], ["run", "--unknown", "x"],
                      ["run", "--web", "--no-web"],
                      ["run", "--log-format", "json", "--log-format", "human"]):
        assert invoke(arguments, seeds) == [arguments]
    assert invoke(["--version"], {"RUN_STATUS": "7"}, status=7) == [["--version"]]

    capture.unlink()
    capture.symlink_to(binary)
    for arguments in (["run", "--workspace"], ["run", "--unknown", "x"],
                      ["run", "--web", "--no-web"],
                      ["run", "--log-format", "json", "--log-format", "human"]):
        command(str(ENTRYPOINT), *arguments, status=2, environment=environment)


def entrypoint_service(binary, root):
    directory = root.parent / "bin"
    directory.mkdir()
    (directory / "cot-to-vmf").symlink_to(binary)
    initial = root.parent / "initial.json"
    initial.write_text(json.dumps(fixture()))

    def launcher(mode, workspace):
        def launch(service, arguments):
            environment = entrypoint_environment(directory)
            environment.update({
                "COT_VMF_WORKSPACE": str(workspace),
                "COT_VMF_WEB_LISTEN": f"127.0.0.1:{service.http}",
                "COT_VMF_LOG_FORMAT": "json",
                "COT_VMF_COT_LISTEN": f"127.0.0.1:{service.input}",
                "COT_VMF_VMF_TARGET":
                    f"127.0.0.1:{service.output.getsockname()[1]}"})
            if mode == "cli":
                environment.update(dict.fromkeys(ENTRYPOINT_RUNTIME_ENV, "invalid"))
                return [str(ENTRYPOINT), *arguments[1:]], environment
            if mode in ("seed", "invalid"):
                environment["COT_VMF_CONFIG_FILE"] = str(initial)
            if mode == "saved":
                environment.update({"COT_VMF_CONFIG_FILE": str(initial),
                                    "COT_VMF_SCHEMAS": "bad seed",
                                    "COT_VMF_MAPPINGS": "bad seed",
                                    "COT_VMF_SET": "bad seed"})
            if mode == "headless":
                environment["COT_VMF_WEB_LISTEN"] = ""
            return [str(ENTRYPOINT)], environment
        return launch

    for mode in ("empty", "cli", "headless"):
        workspace = root / mode
        service = Service(binary, workspace, web=True,
                          launch=launcher(mode, workspace))
        try:
            if mode == "headless":
                try:
                    connection = socket.create_connection(
                        ("127.0.0.1", service.http), timeout=.2)
                except OSError:
                    pass
                else:
                    connection.close()
                    raise AssertionError("empty web environment enabled HTTP")
            else:
                assert service.request("GET", "/health")["ready"]
                with urllib.request.urlopen(
                        f"http://127.0.0.1:{service.http}/", timeout=5) as response:
                    assert b"<html" in response.read()
                assert service.state()["draft"]["schemas"] == []
                assert service.state()["draft"]["outputs"] == []
            service.send()
            if mode != "headless":
                assert feedback_state(service, 1)["activity"]["decoded"] == 1
            service.output.settimeout(.2)
            try:
                service.output.recv(65535)
                raise AssertionError("entrypoint emitted VMF without mappings")
            except socket.timeout:
                pass
        finally:
            service.close()

    workspace = root / "seeded"
    service = Service(binary, workspace, web=True,
                      launch=launcher("seed", workspace))
    try:
        assert len(service.packets()) == 2
        before = service.state()
        document = before["draft"]
        document["outputs"][1]["enabled"] = False
        applied = service.request("POST", "/api/state", {
            "revision": before["draft_revision"], "workspace": document})
        assert applied["valid"]
    finally:
        service.close()
    initial.unlink()
    saved = saved_files(workspace)
    service = Service(binary, workspace, web=True,
                      launch=launcher("saved", workspace))
    try:
        assert service.state()["draft"] == document
        assert service.state()["active_revision"] == applied["active_revision"]
        assert saved_files(workspace) == saved, "startup reapplied environment seeds"
        assert len(service.packets(1)) == 1
    finally:
        service.close()

    initial.write_text('{"format":"invalid","schemas":[],"outputs":[]}')
    workspace = root / "invalid"
    service = Service(binary, workspace, web=True,
                      launch=launcher("invalid", workspace))
    try:
        state = service.state()
        assert not state["valid"] and state["active_revision"] == 0
        repaired = service.request("POST", "/api/state", {
            "revision": state["draft_revision"], "workspace": fixture()})
        assert repaired["valid"]
        assert len(service.packets()) == 2
    finally:
        service.close()


def monitor(binary, root):
    service = Service(binary, root)
    try:
        service.send(b"not xml")
        service.send()
        second = subprocess.run(
            [binary, "run", "--workspace", str(root)],
            capture_output=True, timeout=5)
        assert second.returncode == 2, "workspace allowed two writers"
        service.output.settimeout(.3)
        try:
            service.output.recv(65535)
            raise AssertionError("monitor-only service emitted VMF")
        except socket.timeout:
            pass
        assert service.proc.poll() is None
    finally:
        service.close()
    validation(binary, root.parent)
    large_saved_workspace(binary, root.parent)


def validation(binary, root):
    config = root / "validate.json"
    empty = {"format": "cot-vmf-workspace/1", "schemas": [], "outputs": []}
    invalid = {
        "cot_listen": ["127.0.0.1:0", "999.1.1.1:9001",
                       "127.0.0.1:65536", "localhost:bad", "[::1]:9001"],
        "vmf_target": ["host name:9002", "127.0.0.1:9002junk"],
        "web_listen": ["localhost:8080", "127.0.0.1:8080s",
                       "127.0.0.1:8080,0.0.0.0:9999"],
        "log_format": ["structured", ""],
    }
    runtime = {"cot_listen": "--cot-listen", "vmf_target": "--vmf-target",
               "web_listen": "--web", "log_format": "--log-format"}
    for key, values in invalid.items():
        for value in values:
            document = dict(empty, service={key: value})
            config.write_text(json.dumps(document))
            command(binary, "validate", config, status=2)
            command(binary, "run", "--workspace", root / "invalid-runtime",
                    runtime[key], value, status=2)
    config.write_text(json.dumps(empty))
    command(binary, "validate", config)
    for settings in ({}, {"cot_listen": "0.0.0.0:9001"},
                     {"web_listen": None}, {"log_format": "json"}):
        config.write_text(json.dumps(dict(empty, service=settings)))
        command(binary, "validate", config, status=2)
    command(binary, "run", "--workspace", root / "rejected",
            "--config", config, status=2)
    command(binary, "run", "--workspace", root / "rejected",
            "--web", "127.0.0.1:8080", "--no-web", status=2)


def large_saved_workspace(binary, root):
    document = {"format": "cot-vmf-workspace/1", "schemas": [], "outputs": [
        {"id": "draft", "enabled": False, "mapping": {"name": ""}}]}
    padding = (16 * 1024 * 1024 -
               len(json.dumps(document, separators=(",", ":"))))
    document["outputs"][0]["mapping"]["name"] = "x" * padding
    config = root / "large.json"
    config.write_text(json.dumps(document, separators=(",", ":")))
    state = root / "large-state"
    service = Service(binary, state, config)
    service.close()
    assert (state / "active.json").stat().st_size > 16 * 1024 * 1024
    recovered = Service(binary, state)
    recovered.close()


def persistence_size(binary, root):
    row = '[' + ','.join(['1e19'] * 65536) + ']'
    document = ('{"format":"cot-vmf-workspace/1","schemas":[],"outputs":['
                '{"id":"draft","enabled":false,"mapping":{"rows":[' +
                ','.join([row] * 13) + ']}}]}')
    config = root.parent / 'expanding.json'
    config.write_text(document)
    assert config.stat().st_size < 16 * 1024 * 1024
    validation = subprocess.run([binary, 'validate', str(config)],
                                capture_output=True, timeout=5)
    assert validation.returncode == 0, validation.stderr.decode()
    configure(binary, root / 'rejected', '--config', config, status=2)
    assert not (root / 'rejected' / 'active.json').exists()
    assert not (root / 'rejected' / 'draft.json').exists()

    live_config = root.parent / 'live.json'
    live_config.write_text(json.dumps(fixture()))
    workspace = root / 'live'
    service = Service(binary, workspace, live_config)
    try:
        original = service.packets()
        saved = {name: (workspace / name).read_bytes()
                 for name in ('active.json', 'draft.json')}
        live_config.write_text(document)
        assert service.packets() == original
        assert all((workspace / name).read_bytes() == data
                   for name, data in saved.items())
    finally:
        service.close()
    configure(binary, workspace, '--config', live_config, status=2)
    assert all((workspace / name).read_bytes() == data
               for name, data in saved.items())
    recovered = Service(binary, workspace)
    try:
        assert recovered.packets() == original
    finally:
        recovered.close()


def translation(binary, root):
    config = root.parent / "config.json"
    config.write_text(json.dumps(fixture()))
    result = subprocess.run([binary, "validate", str(config)],
                            capture_output=True)
    assert result.returncode == 0, result.stderr.decode()
    service = Service(binary, root, config)
    try:
        original = service.packets()
        assert all(original) and original[0] != original[1]
        for _ in range(20):
            assert service.packets() == original
        service.send(b"bad")
        assert service.packets() == original
        before = saved_files(root)
        configure(binary, root, "--set", "outputs[0].enabled=false", status=2)
        assert exported(binary, root, active=True) == fixture()
        command(binary, "validate", "--workspace", root)
        assert saved_files(root) == before, "offline edit bypassed the run lock"
        config.write_text('{"malformed":')
        service.reload()
        assert service.packets() == original
        assert saved_files(root) == before
        config.unlink()
        service.reload()
        assert service.packets() == original
    finally:
        service.close()
    configure(binary, root, "--set", "outputs[0].mapping.fields[0].factor=2")
    service = Service(binary, root)
    try:
        changed = service.packets()
        assert changed[0] != original[0] and changed[1] == original[1]
    finally:
        service.close()


def portable_envelopes(binary, root):
    document = fixture()
    document["schemas"][0]["document"]["messages"] = [
        document["schemas"][0]["document"]["messages"][0]]
    original_schema = copy.deepcopy(document["schemas"])
    base = document["outputs"][0]["mapping"]
    document["outputs"] = [
        {"id": "position-" + profile, "enabled": True,
         "mapping": dict(copy.deepcopy(base), message=0, envelope=profile)}
        for profile in ("B", "C", "D", "D1")]
    config = root.parent / "portable.json"
    config.write_text(json.dumps(document))
    command(binary, "validate", config)

    bits = []
    for value, width in [(125000, 32), ((-250000) & 0xffffffff, 32)]:
        bits.extend((value >> i) & 1 for i in range(width))
    for value in b"synthetic-service\x7f":
        bits.extend((value >> i) & 1 for i in range(7))
    bits.extend([0] * ((-len(bits)) % 8))
    payload = bytes(sum(bits[i + j] << j for j in range(8))
                    for i in range(0, len(bits), 8))
    service = Service(binary, root, config)
    try:
        wires = service.packets(4)
        assert [wire[0] & 15 for wire in wires] == [1, 2, 3, 4]
        assert all(wire.endswith(payload) for wire in wires), (
            "envelope selection changed the shared payload")
        assert exported(binary, root, active=True)["schemas"] == original_schema
        assert service.packets(4) == wires
    finally:
        service.close()


def editing(binary, root):
    service = Service(binary, root, web=True)
    try:
        assert service.request("GET", "/health")["ready"]
        state = service.state()
        initial = service.request("POST", "/api/state", {
            "revision": state["draft_revision"], "workspace": fixture()})
        assert initial["valid"], initial
        original = service.packets()
        draft = copy.deepcopy(fixture())
        draft["schemas"][0]["document"]["format"] = "invalid"
        invalid = service.request("POST", "/api/state", {
            "revision": initial["draft_revision"], "workspace": draft})
        assert not invalid["valid"]
        assert invalid["active_revision"] == initial["active_revision"]
        assert service.packets() == original
        before_reload = saved_files(root)
        service.reload()
        assert saved_files(root) == before_reload
        assert service.state()["draft_revision"] == invalid["draft_revision"]
        assert not service.state()["valid"], "reload discarded the invalid draft"
        assert service.packets() == original
        try:
            service.request("POST", "/api/state", {
                "revision": initial["draft_revision"], "workspace": fixture()})
        except urllib.error.HTTPError as error:
            assert error.code == 409
        else:
            raise AssertionError("stale edit was accepted")
        req = urllib.request.urlopen(
            f"http://127.0.0.1:{service.http}/api/events", timeout=5)
        try:
            activity = None
            for _ in range(12):
                line = req.readline()
                if line.startswith(b"data:"):
                    activity = json.loads(line[5:])
                    break
            assert activity and activity["fields"]
            assert activity["active_revision"] == initial["active_revision"]
            assert activity["received"] >= 2
        finally:
            req.close()
        raw = (b'{"revision":' + str(invalid["draft_revision"]).encode() +
               b',"revision":' + str(invalid["draft_revision"]).encode() +
               b',"workspace":' + json.dumps(fixture()).encode() + b'}')
        malformed = urllib.request.Request(
            f"http://127.0.0.1:{service.http}/api/state", data=raw,
            method="POST", headers={"Content-Type": "application/json"})
        try:
            urllib.request.urlopen(malformed, timeout=5)
        except urllib.error.HTTPError as error:
            assert error.code == 400
        else:
            raise AssertionError("duplicate request keys were accepted")
        assert service.state()["draft_revision"] == invalid["draft_revision"]
    finally:
        service.close()
    recovered = Service(binary, root, web=True)
    try:
        state = recovered.state()
        assert not state["valid"]
        assert state["active_revision"] == initial["active_revision"]
        assert recovered.packets() == original
    finally:
        recovered.close()
    override = fixture()
    override["outputs"][0]["mapping"]["fields"][0]["factor"] = 2
    config = root.parent / "override.json"
    config.write_text(json.dumps(override))
    service = Service(binary, root, config, web=True)
    try:
        assert service.state()["draft"] == override
        changed = service.packets()
    finally:
        service.close()
    service = Service(binary, root, web=True)
    try:
        assert service.state()["draft"] == override, "stale draft restored"
        assert service.packets() == changed
        broken = copy.deepcopy(override)
        broken["service"] = {"cot_listen": "invalid-endpoint"}
        state = service.request("POST", "/api/state", {
            "revision": service.state()["draft_revision"],
            "workspace": broken})
        assert not state["valid"], "runtime options activated in saved workspace"
        assert service.packets() == changed
        persistence_failures(service, root, changed)
    finally:
        service.close()
    (root / "active.json").write_text('{"corrupt":true}')
    refused = subprocess.run([binary, "run", "--workspace", str(root)],
                             capture_output=True, timeout=5)
    assert refused.returncode == 2, "corrupt active state fell back to draft"


def schema_restoration(binary, root):
    service = Service(binary, root, web=True)
    try:
        initial = service.request("POST", "/api/state", {
            "revision": service.state()["draft_revision"],
            "workspace": fixture()})
        original = service.packets()
        snapshot = copy.deepcopy(initial["draft"]["schemas"])
        draft = copy.deepcopy(initial["draft"])
        field = draft["schemas"][0]["document"]["messages"][0]["elements"][0]
        field["number_of_bits"] = 0
        del field["scale"]
        invalid = service.request("POST", "/api/state", {
            "revision": initial["draft_revision"], "workspace": draft})
        assert not invalid["valid"]
        assert service.packets() == original
        draft["outputs"][0]["mapping"]["fields"][0]["factor"] = 2
        edited = service.request("POST", "/api/state", {
            "revision": invalid["draft_revision"], "workspace": draft})
        assert not edited["valid"]
        draft["schemas"] = snapshot
        restored = service.request("POST", "/api/state", {
            "revision": edited["draft_revision"], "workspace": draft})
        assert restored["valid"], restored
        changed = service.packets()
        assert changed[0] != original[0] and changed[1] == original[1]
        removed = copy.deepcopy(draft)
        removed["schemas"] = []
        removed["outputs"] = []
        deleted = service.request("POST", "/api/state", {
            "revision": restored["draft_revision"], "workspace": removed})
        assert deleted["valid"]
        restored = service.request("POST", "/api/state", {
            "revision": deleted["draft_revision"], "workspace": draft})
        assert restored["valid"]
        assert service.packets() == changed
    finally:
        service.close()
    service = Service(binary, root, web=True)
    try:
        assert service.state()["draft"] == draft
        assert service.packets() == changed
    finally:
        service.close()


def mapping_import(binary, root):
    service = Service(binary, root, web=True)
    try:
        initial = service.request("POST", "/api/state", {
            "revision": service.state()["draft_revision"],
            "workspace": fixture()})
        original = service.packets()
        replacement = copy.deepcopy(initial["draft"])
        mapping = copy.deepcopy(replacement["outputs"][0]["mapping"])
        mapping["name"] = "Imported position"
        mapping["fields"][0]["factor"] = 2
        replacement["outputs"][0]["mapping"] = mapping
        replacement["outputs"][0]["enabled"] = False
        saved = service.request("POST", "/api/state", {
            "revision": initial["draft_revision"], "workspace": replacement})
        assert saved["valid"], saved
        assert saved["draft"] == replacement
        assert saved["active_revision"] == saved["draft_revision"]
        assert service.packets(1) == [original[1]]
        assert not select.select([service.output], [], [], .1)[0]
    finally:
        service.close()

    service = Service(binary, root, web=True)
    try:
        restored = service.state()
        assert restored["draft"] == replacement
        assert restored["draft_revision"] == saved["draft_revision"]
        assert service.packets(1) == [original[1]]
        replacement["outputs"][0]["enabled"] = True
        enabled = service.request("POST", "/api/state", {
            "revision": restored["draft_revision"], "workspace": replacement})
        assert enabled["valid"], enabled
        changed = service.packets()
        assert changed[0] != original[0] and changed[1] == original[1]

        imported = fixture()
        imported["schemas"][0]["id"] = "imported-schema"
        document = imported["schemas"][0]["document"]
        document["messages"] = document["messages"][:1]
        document["messages"][0]["elements"].append({
            "key": "large", "number_of_bits": 64})
        imported["outputs"] = imported["outputs"][:1]
        output = imported["outputs"][0]
        output["id"] = "imported-output"
        output["enabled"] = False
        output["mapping"]["schema"] = "imported-schema"
        output["mapping"]["envelope"] = "D1"
        output["mapping"]["vmf_constants"] = [{
            "vmf": {"key": "large"}, "value": 18446744073709551615}]
        saved = service.request("POST", "/api/state", {
            "revision": enabled["draft_revision"], "workspace": imported})
        assert saved["valid"], saved
        assert saved["draft"] == imported
        assert saved["active_revision"] == saved["draft_revision"]
        service.send()
        assert not select.select([service.output], [], [], .2)[0]
        assert exported(binary, root) == imported
        assert exported(binary, root, active=True) == imported
    finally:
        service.close()

    service = Service(binary, root, web=True)
    try:
        restored = service.state()
        assert restored["draft"] == imported
        assert restored["draft_revision"] == saved["draft_revision"]
        service.send()
        assert not select.select([service.output], [], [], .2)[0]
        imported["outputs"][0]["enabled"] = True
        enabled = service.request("POST", "/api/state", {
            "revision": restored["draft_revision"], "workspace": imported})
        assert enabled["valid"], enabled
        translated = service.packets(1)
        assert translated[0] != original[0]
        assert not select.select([service.output], [], [], .1)[0]
    finally:
        service.close()

    service = Service(binary, root, web=True)
    try:
        assert service.state()["draft"] == imported
        assert service.packets(1) == translated
    finally:
        service.close()


def feedback_fixture():
    document = fixture()
    definition = document["schemas"][0]["document"]
    definition["messages"] = [{"message_number": "K01.1", "elements": [
        {"key": "sent", "number_of_bits": 64},
        {"key": "mode", "number_of_bits": 8},
        {"key": "conditional", "number_of_bits": 8,
         "when": {"all": [
             {"field": "mode", "values": [{"first": 1, "last": 1}]}]}},
        {"optional": {"key": "optional", "number_of_bits": 32}},
    ]}]
    partial = document["outputs"][0]
    partial["id"] = "authoring"
    partial["mapping"]["fields"] = []
    partial["mapping"]["vmf_constants"] = [
        {"vmf": {"key": "mode"}, "value": 0}]
    subset = copy.deepcopy(partial)
    subset["id"] = "subset"
    subset["mapping"]["fields"] = [
        {"cot": "send_time_ms", "vmf": {"key": "sent"}}]
    document["outputs"] = [partial, subset,
                           {"id": "paused", "enabled": False,
                            "mapping": {}}]
    return document


def feedback_state(service, received):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        state = service.state()
        if state["activity"]["received"] == received:
            return state
        time.sleep(.01)
    raise AssertionError("feedback did not reach the expected event")


def feedback_stream(service):
    with urllib.request.urlopen(
            f"http://127.0.0.1:{service.http}/api/events", timeout=5) as stream:
        for _ in range(12):
            line = stream.readline()
            if line.startswith(b"data:"):
                return json.loads(line[5:])
    raise AssertionError("SSE did not provide a feedback snapshot")


def feedback(binary, root):
    service = Service(binary, root, web=True)
    try:
        assert service.state()["activity"]["outputs"] == []
        document = feedback_fixture()

        def apply(draft):
            return service.request("POST", "/api/state", {
                "revision": service.state()["draft_revision"],
                "workspace": draft})

        saved = apply(document)
        assert saved["valid"], saved.get("error")
        active = saved["active_revision"]
        rows = saved["activity"]["outputs"]
        assert [r["id"] for r in rows] == ["authoring", "subset", "paused"]
        assert [r["status"] for r in rows] == ["waiting", "waiting", "paused"]
        assert all(r["event"] == 0 and r["revision"] == active for r in rows)
        assert all(not r["message"] and not r["code"] for r in rows)
        service.send(b"malformed-source-marker")
        invalid_input = feedback_state(service, 1)
        assert invalid_input["activity"]["outputs"] == rows

        service.send(EVENT.replace(b"synthetic-service", b"secret-sample-value"))
        assert service.output.recv(65535)
        tested = feedback_state(service, 2)
        activity = tested["activity"]
        rows = activity["outputs"]
        assert [r["status"] for r in rows] == ["not_encoded", "sent", "paused"]
        assert rows[0]["code"] and rows[0]["message"]
        assert rows[0]["event"] == rows[1]["event"] == 2
        assert rows[0]["event"] != activity["sequence"]
        assert rows[2]["event"] == 0
        assert not rows[1]["code"] and not rows[1]["message"]
        assert not rows[1]["target_index"] and not rows[1]["config_path"]
        assert rows[1]["cot_field_id"] == 0
        assert "secret-sample-value" not in json.dumps(activity)
        assert "unmapped_source" not in json.dumps(rows)
        assert "inactive_target" not in json.dumps(rows)
        assert feedback_stream(service)["outputs"] == rows
        assert feedback_stream(service)["outputs"] == rows

        broken = copy.deepcopy(document)
        broken["schemas"][0]["document"]["envelope"] = "invalid"
        rejected = apply(broken)
        assert not rejected["valid"]
        assert rejected["active_revision"] == active
        assert rejected["draft_revision"] > active
        assert rejected["activity"]["outputs"] == rows

        document["outputs"][0]["mapping"]["fields"] = copy.deepcopy(
            document["outputs"][1]["mapping"]["fields"])
        repaired = apply(document)
        assert repaired["valid"]
        assert repaired["active_revision"] > active
        rows = repaired["activity"]["outputs"]
        assert [r["status"] for r in rows] == ["waiting", "waiting", "paused"]
        assert all(r["event"] == 0 for r in rows)
        assert feedback_stream(service)["outputs"] == rows
        service.send()
        assert service.output.recv(65535) and service.output.recv(65535)
        repaired = feedback_state(service, 3)
        assert [r["status"] for r in repaired["activity"]["outputs"]] == [
            "sent", "sent", "paused"]
        assert repaired["activity"]["outputs_failed"] == 1

        document["outputs"] = document["outputs"][:2]
        document["outputs"][1]["enabled"] = False
        disabled = apply(document)
        assert [r["status"] for r in disabled["activity"]["outputs"]] == [
            "waiting", "paused"]
        service.send()
        assert service.output.recv(65535)
        disabled = feedback_state(service, 4)
        rows = disabled["activity"]["outputs"]
        assert rows[0]["status"] == "sent" and rows[0]["event"] == 4
        assert rows[1]["status"] == "paused" and rows[1]["event"] == 0
        assert feedback_stream(service)["outputs"] == rows

        document["outputs"] = document["outputs"][:1]
        document["outputs"][0]["mapping"]["fields"][0]["cot"] = "point.longitude"
        conversion = apply(document)
        assert conversion["valid"]
        assert len(conversion["activity"]["outputs"]) == 1
        service.send()
        conversion = feedback_state(service, 5)["activity"]["outputs"][0]
        assert conversion["status"] == "not_encoded"
        assert conversion["target_index"] == "1"
        assert conversion["config_path"] == "/fields/0"
        assert conversion["cot_field_id"] > 0
        assert "-2.5" not in conversion["message"]

        large = fixture()
        large["schemas"][0]["document"]["messages"] = [{
            "message_number": "K01.1", "elements": [{
                "key": "large", "number_of_bits": 524064,
                "type": "text", "text_encoding": "ascii_8"}]}]
        large["outputs"] = large["outputs"][:1]
        large["outputs"][0]["mapping"]["fields"] = []
        large["outputs"][0]["mapping"]["vmf_constants"] = [
            {"vmf": {"key": "large"}, "value": "A" * 65508}]
        oversized = apply(large)
        assert oversized["valid"], oversized.get("error")
        service.send()
        oversized = feedback_state(service, 6)["activity"]["outputs"][0]
        assert oversized["status"] == "not_encoded" and "UDP" in oversized["message"]
        assert not oversized["target_index"] and not oversized["config_path"]
        assert oversized["cot_field_id"] == 0
        assert "A" * 20 not in json.dumps(oversized)

        paused = {"format": "cot-vmf-workspace/1", "schemas": [], "outputs": [
            {"id": f"paused-{i}", "enabled": False, "mapping": {}}
            for i in range(128)]}
        boundary = apply(paused)
        assert boundary["valid"]
        rows = boundary["activity"]["outputs"]
        assert len(rows) == 128 and all(r["status"] == "paused" for r in rows)
        assert all(r["event"] == 0 and not r["message"] for r in rows)
        assert feedback_stream(service)["outputs"] == rows

        # Exercise metadata reads while the engine publishes new revisions.
        stopping = threading.Event()

        def stimulate():
            while not stopping.is_set():
                service.send()
                stopping.wait(.01)

        worker = threading.Thread(target=stimulate)
        worker.start()
        try:
            for index in range(15):
                current = copy.deepcopy(document)
                current["outputs"][0]["id"] = f"revision-{index}"
                current["outputs"][0]["enabled"] = bool(index % 2)
                current["outputs"][0]["mapping"]["fields"][0]["cot"] = "send_time_ms"
                observed = apply(current)
                assert observed["valid"]
                observed = service.state()
                rows = observed["activity"]["outputs"]
                assert len(rows) == 1 and rows[0]["id"] == f"revision-{index}"
                row = rows[0]
                assert row["revision"] == observed["active_revision"]
                assert row["enabled"] == bool(index % 2)
                assert row["event"] <= observed["activity"]["received"]
                if row["status"] in ("waiting", "paused"):
                    assert row["event"] == 0
                else:
                    assert row["status"] == "sent" and row["event"] > 0
                assert not row["code"] and not row["message"]
        finally:
            stopping.set()
            worker.join()
    finally:
        service.close()


def revisions(binary, root):
    config = root.parent / "config.json"
    config.write_text(json.dumps(fixture()))
    service = Service(binary, root, config, web=True)
    try:
        stale = service.state()["draft_revision"]
        assert stale == 1
    finally:
        service.close()
    service = Service(binary, root, config, web=True)
    try:
        assert service.state()["draft_revision"] == stale + 1
        try:
            service.request("POST", "/api/state", {
                "revision": stale, "workspace": fixture()})
        except urllib.error.HTTPError as error:
            assert error.code == 409
        else:
            raise AssertionError("pre-restart edit was accepted")
    finally:
        service.close()
    draft = {"revision": 73, "workspace": {"format": "invalid"}}
    (root / "draft.json").write_text(json.dumps(draft))
    service = Service(binary, root, config, web=True)
    try:
        state = service.state()
        assert state["draft_revision"] == 74
        assert state["active_revision"] == 74
    finally:
        service.close()
    good = (root / "active.json").read_bytes()
    damaged = [b'{"revision":', b'{"workspace":{}}',
               b'{"revision":-1,"workspace":{}}',
               b'{"revision":1.5,"workspace":{}}',
               b'{"revision":"75","workspace":{}}',
               b'{"revision":75,"workspace":[]}',
               b'{"revision":75,"workspace":{},"extra":0}',
               b'{"revision":18446744073709551616,"workspace":{}}',
               b'{"revision":18446744073709551615,"workspace":{}}']
    for name in ("active", "draft"):
        for content in damaged:
            (root / "active.json").write_bytes(good)
            (root / "draft.json").write_bytes(good)
            (root / (name + ".json")).write_bytes(content)
            before = {p: p.read_bytes() for p in root.glob("*.json")}
            if name == "draft" and content == damaged[-1]:
                service = Service(binary, root, web=True)
                try:
                    state = service.state()
                    assert state["draft_revision"] == 18446744073709551615
                    assert state["draft"] == {} and not state["valid"]
                    assert state["active_revision"] == json.loads(good)["revision"]
                    assert all(service.packets()), "last active configuration lost"
                    try:
                        service.request("POST", "/api/state", {
                            "revision": state["draft_revision"],
                            "workspace": fixture()})
                    except urllib.error.HTTPError as error:
                        assert error.code == 500
                    else:
                        raise AssertionError("exhausted draft revision wrapped")
                    assert service.state()["draft_revision"] == state["draft_revision"]
                    assert service.state()["active_revision"] == state["active_revision"]
                    assert all(p.read_bytes() == data
                               for p, data in before.items())
                finally:
                    service.close()
            else:
                command(binary, "run", "--workspace", root, status=2)
            configure(binary, root, "--config", config, status=2)
            assert all(p.read_bytes() == data for p, data in before.items())


def authorities(binary, root):
    for public in (False, True):
        service = Service(binary, root, web=True,
                          web_bind="0.0.0.0" if public else "127.0.0.1")
        try:
            accepted = [
                ("localhost", "http://LOCALHOST:80"),
                ("LOCALHOST:80", "http://localhost"),
                ("127.0.0.1", "http://127.0.0.1:80"),
                ("localhost:18080", "http://LOCALHOST:18080"),
                ("localhost:080", "HTTP://localhost"),
                ("localhost", None),
            ]
            if public:
                accepted += [("Example.test:18080",
                              "http://example.TEST:18080")]
            rejected = [
                ("localhost", "http://localhost:81"),
                ("localhost:18080", "http://localhost"),
                ("localhost", "https://localhost"),
                ("localhost", "http://localhost/"),
                ("localhost", "http://other.test"),
                ("localhost", "null"),
                ("localhost:", None), ("localhost:0", None),
                ("localhost:65536", None), ("localhost:+80", None),
                ("localhost:80junk", None), ("localhost:80:80", None),
                ("user@localhost", None), ("localhost/path", None),
                ("localhost?query", None), ("[::1]:80", None),
                ("bad..host", None), ("-bad.test", None),
                ("localhost", "http://localhost:80#fragment"),
            ]
            if not public:
                rejected += [("example.test", None)]
            for host, origin in accepted + rejected:
                connection = http.client.HTTPConnection(
                    "127.0.0.1", service.http, timeout=5)
                headers = {"Host": host, "Sec-Fetch-Site": "same-origin"}
                if origin is not None:
                    headers["Origin"] = origin
                connection.request("GET", "/health", headers=headers)
                response = connection.getresponse()
                expected = 200 if (host, origin) in accepted else 403
                assert response.status == expected, (host, origin,
                                                     response.status)
                response.read()
                connection.close()
            connection = http.client.HTTPConnection(
                "127.0.0.1", service.http, timeout=5)
            connection.request("GET", "/health", headers={
                "Host": "localhost", "Sec-Fetch-Site": "cross-site"})
            response = connection.getresponse()
            assert response.status == 403
            response.read()
            connection.close()
        finally:
            service.close()


def large_lookup(binary, root):
    workspace = fixture()
    workspace["outputs"] = workspace["outputs"][:1]
    workspace["schemas"][0]["document"]["messages"][0]["elements"] = [
        {"key": "code", "number_of_bits": 8,
         "type": "unsigned"}]
    workspace["outputs"][0]["mapping"]["fields"] = [{
        "cot": "uid", "vmf": {"key": "code"}, "values": [
            {"cot": "key" + str(i), "vmf": 7}
            for i in range(65535, 0, -1)] + [
                {"cot": "synthetic-service", "vmf": 9}]}]
    config = root.parent / "large.json"
    config.write_text(json.dumps(workspace))
    service = Service(binary, root, config)
    try:
        assert service.packets(1)[0]
        for _ in range(20):
            assert service.packets(1)[0]
    finally:
        service.close()


def publication(binary, root):
    config = root.parent / "publication.json"
    config.write_text(json.dumps(fixture()))
    service = Service(binary, root, config, web=True)
    try:
        original = service.packets()
        before = service.state()
        candidate = fixture()
        candidate["outputs"][0]["mapping"]["fields"][0]["factor"] = 4
        active_file = root / "active.json"
        backup = root / "active.saved"
        active_file.rename(backup)
        active_file.mkdir()
        try:
            try:
                service.request("POST", "/api/state", {
                    "revision": before["draft_revision"],
                    "workspace": candidate})
            except urllib.error.HTTPError as error:
                assert error.code == 500
                failed = json.load(error)
            else:
                raise AssertionError("failed active save reported success")
            assert "persist active" in failed["error"]
            assert failed["draft_revision"] == before["draft_revision"] + 1
            assert failed["draft"] == candidate
            after = service.state()
            assert not after["valid"]
            assert after["draft_revision"] == failed["draft_revision"]
            assert after["active_revision"] == before["active_revision"]
            assert after["activity"]["outputs"] == before["activity"]["outputs"]
            assert json.loads((root / "draft.json").read_text()) == {
                "revision": after["draft_revision"], "workspace": candidate}
            assert service.packets() == original
        finally:
            active_file.rmdir()
            backup.rename(active_file)
    finally:
        service.close()

    service = Service(binary, root, web=True)
    try:
        restored = service.state()
        assert not restored["valid"], "unpublished draft reported active"
        assert "not been activated" in restored["error"]
        assert restored["draft"] == candidate
        assert restored["draft_revision"] == after["draft_revision"]
        assert restored["active_revision"] == before["active_revision"]
        assert service.packets() == original
        applied = service.request("POST", "/api/state", {
            "revision": restored["draft_revision"], "workspace": candidate})
        assert applied["valid"] and not applied["error"]
        assert applied["active_revision"] == applied["draft_revision"]
        translated = service.packets()
        assert translated[0] != original[0]
        assert translated[1] == original[1]

        invalid = copy.deepcopy(candidate)
        invalid["schemas"][0]["document"]["envelope"] = "INVALID"
        active_file.rename(backup)
        active_file.mkdir()
        try:
            rejected = service.request("POST", "/api/state", {
                "revision": applied["draft_revision"], "workspace": invalid})
            assert not rejected["valid"]
            assert rejected["active_revision"] == applied["active_revision"]
            assert "persist active" not in rejected["error"]
            assert service.packets() == translated
        finally:
            active_file.rmdir()
            backup.rename(active_file)
    finally:
        service.close()
    service = Service(binary, root, web=True)
    try:
        restored = service.state()
        assert not restored["valid"]
        assert restored["error"] == rejected["error"]
        assert restored["draft"] == invalid
        assert service.packets() == translated
    finally:
        service.close()


def persistence_failures(service, root, original):
    before = service.state()
    draft = fixture()
    draft["outputs"][0]["mapping"]["fields"][0]["factor"] = 4
    draft_file = root / "draft.json"
    backup = root / "draft.saved"
    draft_file.rename(backup)
    draft_file.mkdir()
    try:
        try:
            service.request("POST", "/api/state", {
                "revision": before["draft_revision"], "workspace": fixture()})
        except urllib.error.HTTPError as error:
            assert error.code == 500
        else:
            raise AssertionError("failed draft save reported success")
        after = service.state()
        assert after["draft_revision"] == before["draft_revision"]
        assert after["active_revision"] == before["active_revision"]
        assert after["draft"] == before["draft"]
        assert service.packets() == original
    finally:
        draft_file.rmdir()
        backup.rename(draft_file)


if __name__ == "__main__":
    with tempfile.TemporaryDirectory(prefix="cot-vmf-service-") as directory:
        root = Path(directory) / "workspace"
        {"monitor": monitor, "translation": translation,
         "portable-envelopes": portable_envelopes,
         "configuration": configuration,
         "entrypoint-arguments": entrypoint_arguments,
         "entrypoint": entrypoint_service,
         "editing": editing, "publication": publication,
         "persistence-size": persistence_size,
         "revisions": revisions, "authorities": authorities,
         "large-lookup": large_lookup, "feedback": feedback,
         "schema-restoration": schema_restoration,
         "mapping-import": mapping_import}[
             sys.argv[2]](os.path.abspath(sys.argv[1]), root)
