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

Ports need no special privileges. Send Gateway output to the configured CoT
bind address/port. Send VMF to the receiving process's address/port. The service
never connects to TAK Server itself.

## Docker

`Dockerfile` has a non-root `production` target. Build stages fetch pinned
sources; the runtime contains the executable and its runtime libraries, without
build credentials, source caches, operational schemas, or browser test tools.
Docker Engine with Buildx and Compose v2 is needed for the supplied builds.

```sh
docker compose -f deploy/compose.yaml up --build -d
docker compose -f deploy/compose.yaml logs -f translator
```

The example publishes UDP 9001 and HTTP 8080 on host loopback and retains state
in a named volume. Set `COT_BIND` to a reachable host address for Gateway
access from another host, `WEB_BIND` to choose the published browser address,
and `VMF_TARGET` to the receiver's address and port. The VMF destination must
resolve from inside the translator container; its loopback refers to that
container.

Mount a user configuration read-only and pass `--config /path/config.json`
to import it at startup, or author/import it through the GUI. Mount a writable
workspace for persistent edits. The image runs as uid/gid 10001; bind mounts
must permit that identity to write. The provided named volume starts with the
image's ownership. Runtime needs no network downloads.

Private state files are `active.json`, `draft.json`, and the workspace lock.
Keep the workspace on a filesystem supporting same-directory atomic rename.
See the [API contract](api.md) for state envelopes, publication guarantees,
and restart recovery.

Published HTTP access belongs on the deployment's operator-controlled network;
use the existing deployment boundary when remote access is required. Runtime
needs no external browser resources. Keep operational definitions and traffic
outside repository fixtures.
