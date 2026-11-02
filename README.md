# CoT to VMF service

`cot-to-vmf` receives XML Cursor on Target events from
[TAK Gateway](https://github.com/pgsocks/tak-gateway) over UDP and translates
one way into VMF UDP datagrams using
[CoT](https://github.com/pgsocks/cot) and [VMF](https://github.com/pgsocks/vmf).
Run it in the foreground, as a service, or in Docker. Its optional embedded
browser interface authors payload schemas and draws live field mappings.

Operational payload schemas and mappings are supplied by the user at runtime.
The executable and Docker image contain no operational message definitions.
Examples and test traffic are synthetic. Without configuration, the service
reports CoT reception and sends no VMF.

## Build and run

Linux, CMake 3.24+, Git, and a C11/C++17 GCC or Clang toolchain are required.
Initial builds fetch pinned dependencies through CPM.

```sh
cmake --preset default
cmake --build --preset default
ctest --preset default
build/src/cot-to-vmf run --workspace ./workspace \
  --cot-listen 0.0.0.0:9001 --vmf-target 127.0.0.1:9002 \
  --web 127.0.0.1:8080
```

Open `http://127.0.0.1:8080`. Create or import schemas in **Schemas**, then
connect standard CoT fields to VMF fields in **Mapping**. Enable the desired
outputs. Valid edits activate immediately; invalid drafts retain the previous
active configuration. The workspace preserves both across restart.

To start with the synthetic two-output example:

```sh
build/src/cot-to-vmf validate examples/synthetic.workspace.json
build/src/cot-to-vmf config --workspace ./workspace \
  --config examples/synthetic.workspace.json
build/src/cot-to-vmf run --workspace ./workspace --web 127.0.0.1:8080
```

Configure Gateway's UDP output host and port to reach the translator. Gateway
sends one complete XML event per datagram. The translator does not connect
directly to TAK Server. Each enabled output attempts one VMF message per event;
each successful PDU is sent in its own datagram.

`config` edits schemas and mappings while the service is stopped. `export`
writes the saved draft as JSON; `validate` checks it without changing state.
Invalid edits remain saved as drafts while the last valid configuration stays
active. Network endpoints, the optional GUI, and logging are run options and
are never stored in the workspace.

`SIGINT` and `SIGTERM` stop gracefully. `SIGHUP` reloads saved active state;
it does not reread imported files, change saved configuration, or change run
options. Restart uses the saved active workspace. `--help` lists commands and
startup options. The `headless` preset omits web support; the `release` preset
builds production
artifacts without test tooling.

## Docker and background operation

```sh
docker compose -f deploy/compose.yaml up --build -d
```

Compose starts the translator and TAK Gateway, building Gateway from a pinned
remote Git revision. The first build needs Git network access. Open:

- `http://127.0.0.1:8080` to author translator schemas and mappings.
- `http://127.0.0.1:8081` to add existing TAK connections in Gateway.

Gateway starts without inputs and forwards received XML events over UDP to
`translator:9001`. Both GUIs and the translator's published UDP port bind to
host loopback by default. Saved mappings, Gateway settings, and uploaded
credentials survive restart. See [deployment](docs/deployment.md) for network
settings, seed inputs, persistent storage, and offline commands.

Stop with `docker compose -f deploy/compose.yaml down`; both named volumes are
retained.

## Verification and contracts

[Testing](docs/testing.md) covers native and browser checks.
[API](docs/api.md), [mapping](docs/mapping.md), and
[design](docs/design.md) define behavior and ownership.
[CONTRIBUTING.md](CONTRIBUTING.md) governs implementation and review.

Only standard fields exposed by the CoT inspection catalog are individually
mappable. Arbitrary detail XML and opaque extensions have presence indicators.
UDP delivery is best effort. Schema correctness and synthetic tests do not
establish operational semantic equivalence for a user-provided definition.
