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

Output plans select message ordinals and envelope profiles independently of
schema defaults. A plan owns a single-message registry view that borrows the
original canonical descriptors and materializes that message's effective
standard selection. This avoids making unrelated editions gate an output,
while retaining native raw-code origin and profile validation. Header identity
is generated before native header loading and complete-message authoring;
the translator does not implement another identity-to-wire mapping.

The catalog retains canonical message fields once and reports separate
availability, identities, and header previews for all four profiles. Browser
outputs are identified by their own ids, so several outputs can use one message
without collapsing profiles with equal wire identities. User metadata stays
separate from generated defaults. Message deletion and moves update ordinal
references and schema history together; external files use their explicit
message positions.

The optional GUI is embedded so Docker and offline runtime installations need
only the executable and user workspace. CivetWeb's C API, pinned through CPM,
keeps HTTP parsing out of application code. Assets use ordinary DOM/SVG and no
runtime frontend packages.

The workspace stores schemas and output mappings. Transport endpoints, GUI
selection, and logging belong to each service invocation. Offline CLI commands
and live browser edits share native validation and persistence; the CLI does
not require HTTP or the GUI. A workspace lock excludes offline writers while
the service runs. Docker imports optional seed inputs only for a fresh
workspace, then supplies runtime options on every start.

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
