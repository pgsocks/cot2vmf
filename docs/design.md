# Design rationale

The translator is a continuous one-way adapter downstream of TAK Gateway.
Gateway owns server authentication, TLS, negotiation, and protobuf-to-XML
normalization. Its [UDP contract][gateway] removes framing and TAK-session
state from this application's receive loop.

Immutable workspaces own validated schemas and mappings. Each event and output
uses a fresh job for values, encoded results, and diagnostics. This prevents
stale optional values, cumulative job allocation, and dangling schema
references during live replacement.

The native CoT inspection catalog supplies source metadata and semantic
availability. VMF's [schema][schema] and [authoring][author] APIs own field
structure and encoding; this project does not implement a second payload
codec. Physical-to-raw numeric conversion remains the translator's task.
Exact arithmetic and range checks preserve the source and target domains.

One active configuration contains several independent output plans. Every
enabled plan processes the same decoded event. This matches the field-wiring
workflow without introducing routing predicates. A failed plan suppresses its
PDU while subsequent plans continue. One body per datagram keeps failure and
publication boundaries explicit.

The optional GUI is embedded so Docker and offline runtime installations need
only the executable and user workspace. CivetWeb's C API, pinned through CPM,
keeps HTTP parsing out of application code. Assets use ordinary DOM/SVG and no
runtime frontend packages.

Web writers serialize edits while validation and persistence run independently
of UDP processing. A narrow engine lock exchanges the active owner between
jobs; separate metadata locking protects bounded activity history. Readers
never retain a freed workspace. Draft revision checks prevent silent browser
edit conflicts. Persistence precedes activation so restart recovers what was
successfully published.

Visual schema forms edit native JSON with exact integer transport. Labels
and mappings remain outside the strict native schema dialect. Incomplete
schemas stay editable; the last valid complete configuration continues.

The [testing guide](testing.md) describes native contract tests, Cucumber
service workflows, and Playwright checks of browser controls and wires.

[gateway]: https://github.com/pgsocks/tak-gateway/blob/master/docs/api.md
[schema]: https://github.com/pgsocks/vmf/blob/master/docs/schema-json.md
[author]: https://github.com/pgsocks/vmf/blob/master/docs/authoring.md
