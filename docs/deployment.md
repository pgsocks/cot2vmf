# Deployment

The Linux CLI runs in the foreground. Supervisors and Docker supply background
operation; it does not fork or daemonize itself. The [API contract](api.md#cli)
describes command options, signals, and startup settings.

## Native service

```sh
cmake --preset release
cmake --build --preset release
cmake --install build/release --prefix /usr/local
```

Installation includes the CLI, public headers, and separate static libraries
for the translator and its native dependencies. CPM still builds the exact
pinned sources; consumers use the installed CMake packages without CPM:

```cmake
cmake_minimum_required(VERSION 3.24)
project(my_translator LANGUAGES C CXX)
find_package(cot2vmf CONFIG REQUIRED)
add_executable(my_translator main.c)
set_property(TARGET my_translator PROPERTY C_STANDARD 11)
target_link_libraries(my_translator PRIVATE cot2vmf::cot2vmf)
```

Configure the consumer with `-DCMAKE_PREFIX_PATH=/path/to/prefix`. The exported
target supplies CoT, VMF's `schema_json` and `header_json` components, yyjson,
and Expat transitively. C callers include `<cot2vmf/core.h>`; C++17 callers
can include `<cot2vmf/core.hpp>`. Enable C++ in the consumer project so CMake
links the C++ runtime for the static libraries. The complete installation
prefix can be moved before configuring a consumer. GNUInstallDirs controls
the library, header, executable, and data destinations.

For unattended operation, run the foreground CLI under your service manager
with a writable persistent workspace. A headless service omits `--web`; the
`headless` preset also excludes the web dependency and assets from the binary.
`--web` with no address listens on `0.0.0.0:8080`; pass an explicit loopback
address when that is the intended deployment boundary. Runtime endpoints,
GUI selection, and logging come from the run command, not the workspace.

Configure schemas and mappings before starting the service:

```sh
cot-to-vmf config --workspace ./workspace --config /path/workspace.json
cot-to-vmf validate --workspace ./workspace
cot-to-vmf export --workspace ./workspace > workspace-backup.json
cot-to-vmf run --workspace ./workspace --web 127.0.0.1:8080
```

Configuration edits require the service to be stopped. Export and validation
can read saved state while it runs. The GUI can edit the draft live. A saved
invalid CLI draft returns status 3 and remains available for repair; the last
valid active configuration continues to be used on subsequent runs.

Ports need no special privileges. Send Gateway output to the configured CoT
bind address/port. Send VMF to the receiving process's address/port. The service
never connects to TAK Server itself.

## Docker

`Dockerfile` has a non-root `production` target. Build stages fetch pinned
sources; the runtime contains the executable and its runtime libraries, without
build credentials, source caches, operational schemas, or browser test tools.
Docker Engine with Buildx and Compose v2 is needed for the supplied builds.
Compose also builds TAK Gateway from its remote Git repository at
[`534e225587a3e91289303160e2c209bd68da03b3`](https://github.com/pgsocks/tak-gateway/tree/534e225587a3e91289303160e2c209bd68da03b3),
using upstream `docker/Dockerfile` and its `runtime` target. The first build
needs Git network access as well as access to the dependency sources.

```sh
docker compose -f deploy/compose.yaml up --build -d
docker compose -f deploy/compose.yaml logs -f translator gateway
```

Open `http://127.0.0.1:8080` for translator schemas and mappings, and
`http://127.0.0.1:8081` to configure existing TAK connections in Gateway.
Gateway starts without inputs; add them manually or upload an ATAK package
through its GUI. Its initial UDP output is
`translator=udp://translator:9001`, delivering one unframed XML event per
datagram over the Compose network. No TAK Server is bundled.

Both GUIs publish on host loopback. `WEB_BIND` selects the published host
address for both; `COT_BIND` selects the translator's published UDP 9001 address
for external senders. `VMF_TARGET` selects the receiving process's address and
port. The VMF destination must resolve from inside the translator container;
its loopback refers to that container. Gateway listens on container port 8081
and publishes host port 8081 so its HTTP Host validation accepts browser
requests. Access its GUI by numeric IP or `localhost`.

The `workspace` volume preserves translator drafts and active mappings. The
separate `gateway-state` volume preserves Gateway settings and uploaded
credentials, inheriting the upstream image's uid/gid 1000 ownership when first
created. Gateway uses private `/run/tak-gateway` tmpfs for temporary imports
and status. Its environment values seed the initial store only; subsequent
starts retain GUI edits instead of applying those seed settings again.
`docker compose -f deploy/compose.yaml down` retains both named volumes.

The translator entrypoint starts UDP reception on `0.0.0.0:9001`, sends
configured outputs to `127.0.0.1:9002`, enables the GUI on `0.0.0.0:8080`, and
uses JSON logging.
Without schemas or mappings it remains receive-only. Explicit run arguments
override these environment settings:

| Variable | Container default |
| --- | --- |
| `COT_VMF_WORKSPACE` | `/var/lib/cot-to-vmf` |
| `COT_VMF_COT_LISTEN` | `0.0.0.0:9001` |
| `COT_VMF_VMF_TARGET` | `127.0.0.1:9002` |
| `COT_VMF_WEB_LISTEN` | `0.0.0.0:8080`; empty disables the GUI |
| `COT_VMF_LOG_FORMAT` | `json` |

Empty values use the listed defaults except for `COT_VMF_WEB_LISTEN`.
Use `docker run ... cot-to-vmf:local run --no-web` to disable the GUI explicitly.
These options apply on every start and do not change persisted schemas or
mappings.

Mount user input files read-only and set optional seed variables:

| Variable | First-start input |
| --- | --- |
| `COT_VMF_CONFIG_FILE` | One bare workspace JSON file path |
| `COT_VMF_SCHEMAS` | Newline-separated `ID=FILE` schema imports |
| `COT_VMF_MAPPINGS` | Newline-separated `ID=FILE` mapping imports |
| `COT_VMF_SET` | Newline-separated `PATH=JSON` edits |

Each nonempty line is one literal argument; spaces and shell characters are
preserved without shell evaluation. Blank lines are ignored. The workspace
file is the base, followed by schemas, mappings, and set operations in listed
order. Files must resolve inside the container. Imported mappings are bare
`cot-vmf-mapping-config/1` documents. For example:

```sh
docker run --rm -p 127.0.0.1:8080:8080 -p 127.0.0.1:9001:9001/udp \
  --mount type=volume,src=cot-vmf-workspace,dst=/var/lib/cot-to-vmf \
  --mount type=bind,src="$(pwd)/examples",dst=/inputs,readonly \
  -e COT_VMF_CONFIG_FILE=/inputs/synthetic.workspace.json cot-to-vmf:local
```

The native `config --if-uninitialized` guard seeds under the workspace lock
only when neither saved active nor draft state exists. Even an empty first
start records initialization. Restart skips seed inputs entirely, preserving
GUI edits even if original input files have disappeared. An invalid seed is
saved as an inactive draft and the service starts so the GUI can repair it;
malformed input, I/O errors, and corrupt saved state stop startup. Administrative
commands and help bypass seeding. To change saved configuration from the CLI,
stop the service and invoke `config` against its mounted workspace.

Mount a writable workspace for persistent edits. The translator image runs as
uid/gid 10001; bind mounts must permit that identity to write. The provided
named volume starts with the image's ownership. Runtime needs no network
downloads.

Private state files are `active.json`, `draft.json`, and the workspace lock.
Keep the workspace on a filesystem supporting same-directory atomic rename.
See the [API contract](api.md) for state envelopes, publication guarantees,
and restart recovery.

Published HTTP access belongs on the deployment's operator-controlled network;
use the existing deployment boundary when remote access is required. Runtime
needs no external browser resources. Keep operational definitions and traffic
outside repository fixtures.
