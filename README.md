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

Linux, CMake 3.24+, Git, `patch`, and a C11/C++17 GCC or Clang toolchain are
required.
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
outputs after selecting each output's message and envelope. New browser outputs
start disabled. One payload definition can serve independent B/C/D/D1 outputs;
header identity is generated from the selected message and profile. Valid edits
activate immediately; invalid drafts retain the previous
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

Workspace and mapping documents use format version 1. Embedded native payload
documents use `vmf-schema/1`.

## Author a payload in the browser

The schema library holds your definitions. A library name such as `payload-1`
is a workspace label. A message number such as `K01.1` identifies a message
inside that definition. A standard edition such as `MIL-STD-6017B` identifies
the specification you are transcribing. Choose the edition and message number
from your source document; they are separate settings.
When returning to the editor, select an existing library entry to open it.

For a synthetic walkthrough, open **Payload schemas** and:

1. Click **+ New schema**. In **Schema properties**, leave the optional envelope
   default unset, then choose the named edition `MIL-STD-6017B` under
   **Standard**. Outputs will select their own envelopes.
2. Click **+ Message** and enter `K01.1` in **Message number**. The new message
   stays an invalid draft until its required number is supplied.
3. Click **+ Add field**. Under **Identity**, change its key to `battery`.
   Under **Encoding**, use `unsigned`; under **Size & length**, enter `8` bits.
   The remaining constraint and condition settings are optional.
4. With `battery` selected, click **Wrap in group**, then **Make optional**.
   The outline now shows **Optional group → Group · 1 element → battery**.
   A group stays a group even when it contains only one field.
5. Click **Export native schema** to save the definition as JSON. Importing
   the identical definition again selects the existing library entry. A
   different definition is imported as a new entry; it does not replace an
   existing schema or its mappings.

Leave an input or press Tab to commit its value. **Changes saved** confirms the
edit was stored. Invalid imported definitions remain saved drafts, with errors
pointing to their nested JSON locations; the previous active configuration
continues running. Invalid keys and widths entered through the editor are
rejected before changing the definition.

Arrays in the exported JSON preserve wire order. Nesting determines group
membership and generates presence and recurrence indicators. You do not enter
field indexes, group/repeat codes, indicator targets, or indicator widths.
Every data field has a unique key within its message. Boolean width is implied;
other widths and text/binary capacities are explicitly measured in bits.
For example, the optional group above exports as:

```json
{
  "format": "vmf-schema/1",
  "message_standard": "MIL-STD-6017B",
  "messages": [{
    "message_number": "K01.1",
    "elements": [{
      "optional": [{"key": "battery", "number_of_bits": 8}]
    }]
  }]
}
```

These values describe a synthetic layout, not an assigned operational message.

To construct repeated or larger regions:

- Select a group or wrapper, then use **+ Add field inside** or
  **+ Add group inside**. Select the message row to add at the message level.
- Select an element and use **Move element up/down** to change its wire order.
- For two occurrences, each containing an optional group, select the
  **Optional group** row, click **Repeat fixed times**, and set **Count** to `2`.
  The outline becomes **Fixed repeat → Optional group → Group → battery**.
  Wrapping the repeat in **Make optional** instead controls the whole repeat.
- **Repeat with indicator** requires an explicit positive **Maximum**.
  **Repeat from field** requires an earlier count field and an explicit
  **Maximum**. Field-length and condition sources are also selected by key.
  The source chooser lists fields available at that point in the structure.
- **Remove wrapper** keeps its contents. **Delete element** removes the selected
  region. **Undo** restores the last schema edit, including affected references.
  Reloading keeps saved edits but clears the browser session's Undo history.

On **Field mapping**, click `detail.status.battery`, then the VMF `battery`
target, or drag between their ports. The connection creates a disabled output;
select that output, choose envelope `C`, then enable it. An unmapped optional
group can remain absent. Required fields and repeated occurrences need values;
use **Header & controls** for constants, presence controls, explicit recurrence
counts, and occurrence selections. Incoming CoT drives **Last test result**;
**Waiting for traffic** means no event has tested that configuration yet.

Connections use field keys. Renaming a key in the editor updates its schema
references and connections; reordering fields does not change their targets.
Edits that remove required repeat/group context disable affected outputs and
explain what needs review. Check those outputs before enabling them again.

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
