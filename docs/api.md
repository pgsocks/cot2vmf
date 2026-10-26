# Service and native API

The supported runtime is Linux with GCC or Clang, C11 public headers and
procedural C++17 implementation. Version 0.1 does not freeze a binary ABI.
The complete native declarations and ownership rules are in
`include/cot2vmf/core.h`; `core.hpp` exposes the same procedural interface.

## CLI

`cot-to-vmf run` receives continuously. Omitting the command also selects
`run`. Options accept separate values; duplicate and unknown options fail.

| Option | Behavior |
| --- | --- |
| `--config FILE` | Load a bare `cot-vmf-workspace/1` document on startup |
| `--workspace DIR` | Store active state and editable drafts |
| `--cot-listen HOST:PORT` | IPv4 UDP bind; default `0.0.0.0:9001` |
| `--vmf-target HOST:PORT` | IPv4 UDP destination; default `127.0.0.1:9002` |
| `--web HOST:PORT` | Enable HTTP GUI on a numeric IPv4 bind address |
| `--log-format human\|json` | Reception/status output; default human |

Workspace `service` settings use `cot_listen`, `vmf_target`, `web_listen`, and
`log_format`. CLI values override them. Null or absent `web_listen` disables
the GUI. Transport/log settings are startup settings; live edits and SIGHUP
do not rebind sockets. Without an explicit directory, use
`$XDG_STATE_HOME/cot-to-vmf`, or `$HOME/.local/state/cot-to-vmf`.

`validate FILE` loads configuration without receiving or writing state.
It returns 0 on success and 2 for unreadable or invalid configuration.
`--help` and `--version` return 0. Runtime setup/configuration errors return 2,
socket or web startup/runtime I/O errors return 1, and orderly shutdown 0.

SIGINT/SIGTERM stop intake and join web workers. SIGHUP reloads `--config`,
or the saved active state when no initial file was specified. A failed reload
retains the previous active configuration. Corrupt saved active state prevents
startup; a saved invalid draft is restored for repair while the saved active
configuration continues.

## Intake and publication

Each datagram is one complete UTF-8 XML CoT event, without a prefix, suffix,
TAK magic, or protobuf framing. Datagram size is at most 65,507 bytes.
Malformed, empty, truncated, and unsupported events increment invalid intake
counts and do not terminate the receive loop. Gateway can preserve XML shapes
that the CoT library does not support; these remain decoding failures here.

For each decoded event, every enabled output is attempted in configuration
order. Encoding and send failures are isolated per output. An output has one
body in one complete VMF PDU; no application fragmentation or retry occurs.
VMF authoring validates mandatory values, structure, and ranges before any
output callback. Never publish partial or oversized PDUs.

The native `cv_workspace_load` copies and validates an in-memory workspace.
The immutable owner survives concurrent `cv_process` calls; the caller must
keep it alive through every call and callback. `cv_process(NULL, ...)` provides
receive-only inspection. Callbacks synchronously borrow output id and bytes
and return publication success. A failed output does not stop later outputs.
Fresh job storage prevents absent source fields inheriting earlier values.

`cv_catalog` supplies native source/target metadata independently of mapping
validity, with per-schema diagnostics for invalid schemas. Its allocated JSON
buffer is released with `cv_buffer_destroy`. All public functions report
status values; none throws. The header specifies nullable arguments, size
limits, failure output states, reentrancy, and release obligations.

## Browser API

Assets and APIs share the configured HTTP listener. The default example binds
loopback. Origin checks reject cross-site requests; the service is intended
for an operator-controlled network. Assets require no outside resources.

- `GET /health`: readiness JSON.
- `GET /api/state`: draft document, draft/active revision, validity, diagnostic,
  native catalog, and activity snapshot.
- `POST /api/state`: `{revision, workspace}` replaces a draft using optimistic
  revision checks. Accepted invalid drafts return 200 with `valid:false`;
  malformed envelopes return 400, stale edits 409, persistence failures 500.
- `GET /api/events`: server-sent `activity` events containing field ids,
  counters, sequence, and configuration revisions.

Every accepted edit increments the draft revision. A complete valid candidate
is persisted before activation between processing jobs. Failed validation or
active publication retains the old active revision. Draft and active files
wrap the workspace as `{revision, workspace}`; `--config` accepts the bare
workspace. Publication guarantees atomic visibility, not directory-level crash
durability. State files are private and require a writable workspace.

Activity history and web clients are bounded. Slow clients do not own the UDP
worker; intermediate events may be coalesced into presence pulses. Reconnection
gets a current snapshot. Telemetry and reception logs carry metadata and counts,
not received field values or encoded payload bytes.
