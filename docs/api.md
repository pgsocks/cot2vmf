# Service and native API

The supported runtime is Linux with GCC or Clang, C11 public headers and
procedural C++17 implementation. Version 0.1 does not freeze a binary ABI.
The complete native declarations and ownership rules are in
`include/cot2vmf/core.h`; `core.hpp` exposes the same procedural interface.

## CLI

`cot-to-vmf run` receives continuously. Omitting the command also selects
`run`. Runtime options select network endpoints, the GUI, and logging; they
are not persistent configuration. Options take separate values. Unknown or
duplicate scalar options fail, and `--web` and `--no-web` are mutually exclusive.

| Run option | Behavior |
| --- | --- |
| `--workspace DIR` | Select persistent drafts and active configuration |
| `--cot-listen HOST:PORT` | IPv4 UDP bind; default `0.0.0.0:9001` |
| `--vmf-target HOST:PORT` | IPv4 UDP destination; default `127.0.0.1:9002` |
| `--web [HOST:PORT]` | Enable the GUI; omitted address means `0.0.0.0:8080` |
| `--no-web` | Disable the GUI; native runs are headless by default |
| `--log-format human\|json` | Reception/status output; default human |

Every workspace command selects its directory using `--workspace`, then
`COT_VMF_WORKSPACE`, then `$XDG_STATE_HOME/cot-to-vmf`, then
`$HOME/.local/state/cot-to-vmf`. Empty environment values do not select a
workspace. Imported files supply schemas and mappings, never startup options.

### Offline configuration

`cot-to-vmf config [options]` edits the saved draft. The service must be stopped:
configuration writers take the same exclusive workspace lock as the service.
Read-only `export` and `validate` remain available while the service runs.

| Config option | Behavior |
| --- | --- |
| `--config FILE` | Use one bare workspace document as the starting point |
| `--schema ID=FILE` | Add or replace a schema with a native `vmf-schema/1` document |
| `--mapping ID=FILE` | Add or replace an output with a bare `cot-vmf-mapping-config/1` document |
| `--remove-schema ID` | Remove the schema and its referencing outputs |
| `--remove-mapping ID` | Remove the output identified by ID |
| `--set PATH=JSON` | Set a workspace value using dotted keys and zero-based `[index]` components |
| `--if-uninitialized` | Save only if neither active nor draft state exists |

Without `--config`, edits start from the saved draft, or an empty workspace.
A single `--config` supplies the base regardless of its argument position; all
other edits run in argument order. Repeated edits use their latest value.
Removing an unknown ID fails. A newly imported mapping is enabled; replacing
one preserves its enabled state. `--set` preserves JSON values, including exact
integers; missing objects and arrays are created, and array appends must be
contiguous. Sparse array writes and type conflicts fail. Paths begin with a
nonempty property name; quoted keys, JSON Pointer, and replacing the whole root
are unsupported. Use `--config FILE` to replace the whole workspace.

All edits are staged before publication. Command-shape, file-reading, JSON
parsing, and edit-path errors leave state unchanged and return 2. A complete
valid draft is persisted and made active with exit 0. A semantically invalid
draft is saved for repair, leaves the previous active configuration unchanged,
and returns 3. Persistence failures return 1. `config` with no edit options
saves the current draft and can initialize an empty workspace.

`--if-uninitialized` checks under the workspace lock. Either saved state file
counts as initialized, including an invalid draft; existing state skips seed
inputs rather than reading them again. A fresh workspace is initialized even
without seed options. Corrupt state is an error, never a reason to reseed.

`cot-to-vmf export [--active]` writes a bare workspace JSON document to stdout;
it selects the saved draft unless `--active` is supplied.
`cot-to-vmf validate [FILE]` checks a bare document, or the saved draft when
FILE is absent, without receiving traffic or writing state. Validation returns
0 on success and 2 for unreadable or invalid configuration. `--help` and
`--version` return 0. Orderly service shutdown returns 0; runtime setup or
argument errors return 2, and service I/O errors return 1.
Reading a nonexistent workspace exports an empty document or validates the
empty workspace successfully, without creating the directory or state files.

SIGINT/SIGTERM stop intake and join web workers. SIGHUP reloads saved active
state without changing saved configuration or runtime options. It never
rereads imported source files or discards a pending draft. A failed reload
retains the previous active configuration. Corrupt saved active state prevents
startup; a saved invalid draft is restored for repair while the saved active
configuration continues. Without an active configuration the service runs
receive-only.

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
wrap the workspace as `{revision, workspace}`; `config --config` accepts the
bare workspace. Publication guarantees atomic visibility, not directory-level
crash durability. State files are private and require a writable workspace.

Activity history and web clients are bounded. Slow clients do not own the UDP
worker; intermediate events may be coalesced into presence pulses. Reconnection
gets a current snapshot. Telemetry and reception logs carry metadata and counts,
not received field values or encoded payload bytes.
