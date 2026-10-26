#!/usr/bin/env python3
"""Run Chromium browser contracts against the actual translator container."""
import argparse
import os
from pathlib import Path
import subprocess
import tempfile
import uuid


ROOT = Path(__file__).resolve().parent
REPOSITORY = ROOT.parent.parent


def command(arguments, timeout=900):
    environment = os.environ.copy()
    for key in ('DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS',
                'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'):
        environment.pop(key, None)
    return subprocess.run(['docker', '--host=unix:///var/run/docker.sock',
                           *arguments], env=environment, timeout=timeout,
                          check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--skip-build', action='store_true')
    arguments = parser.parse_args()
    project = 'cot-vmf-browser-' + uuid.uuid4().hex[:12]
    compose = ['compose', '--project-name', project, '-f',
               str(ROOT / 'compose.yaml')]
    try:
        if not arguments.skip_build:
            secret = 'id=proxy_ca,src=' + os.environ.get(
                'TAK_BUILD_CA_BUNDLE', '/etc/ssl/certs/ca-certificates.crt')
            command(['build', '--secret', secret, '--target', 'production',
                     '-t', 'cot-to-vmf:local', str(REPOSITORY)])
            command(['build', '--secret', secret, '-f',
                     str(ROOT / 'Dockerfile'), '-t', 'cot-vmf-browser:local',
                     str(REPOSITORY)])
        command(compose + ['up', '--abort-on-container-exit', '--exit-code-from',
                           'browser'], timeout=180)
        return 0
    except (OSError, subprocess.SubprocessError):
        return 1
    finally:
        artifacts = Path(tempfile.mkdtemp(prefix='cot-vmf-browser-'))
        try:
            command(compose + ['cp', 'browser:/tests/test-results/.',
                               str(artifacts)], timeout=30)
            print('Browser artifacts:', artifacts, flush=True)
        except (OSError, subprocess.SubprocessError):
            pass
        command(compose + ['down', '--volumes', '--remove-orphans',
                           '--timeout', '5'], timeout=60)


if __name__ == '__main__':
    raise SystemExit(main())
