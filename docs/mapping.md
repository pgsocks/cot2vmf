# Workspace and mapping contract

The service accepts one `cot-vmf-workspace/1` JSON document. All operational
schemas and mappings are user-supplied. `examples/synthetic.workspace.json`
illustrates syntax with two synthetic message definitions and outputs.

```json
{
  "format": "cot-vmf-workspace/1",
  "schemas": [],
  "outputs": []
}
```

Only `format`, `schemas`, and `outputs` are workspace properties. Network
endpoints, GUI selection, and logging belong to the `run` command; a `service`
object is rejected. Schemas and outputs are required arrays, each bounded to
128 entries. Each id is a unique, nonempty string of at most 128 UTF-8 bytes
without embedded NUL. Unknown properties and duplicate JSON keys fail.
Documents are bounded to 16 MiB; native loaders and job storage have additional
bounded budgets. The GUI retains exact integer values above JavaScript's
ordinary number range.

A schema entry is `{ "id": "position", "document": { ... } }`. `document`
is an unmodified native `vmf-schema/1` object; use the VMF repository's
[schema reference][schema] for fields, profiles, structures, and validation.
Messages contain ordered `elements`. A field requires a nonempty `key`,
unique throughout that message, and a bit width (optional for `type: "bool"`).
Arrays group elements; `optional`, `recurrence`, and `repeat` wrappers express
structure. `recurrence` declares a finite maximum; `repeat` declares either
an explicit count or a count-source key and finite maximum. Length sources and
condition terms also reference field keys. A field's `type` names its wire
encoding; `scale` selects scaled data with that raw integer representation.
Labels, notes, and conversion behavior are not added to that native dialect.
All schema definitions must validate before the whole workspace can activate.
Native schemas may omit their envelope default. Each output independently
chooses an envelope and one message from the shared definition.

An output is `{ "id": "position-out", "enabled": true, "mapping": { ... } }`.
Disabled outputs may retain incomplete mapping objects. Each enabled output
uses the `cot-vmf-mapping-config/1` format:

```json
{
  "format": "cot-vmf-mapping-config/1",
  "schema": "position",
  "message": 0,
  "envelope": "D1",
  "fields": [
    {"cot": "point.latitude", "vmf": {"key": "latitude"}}
  ]
}
```

Here `schema` names a workspace id, never a filesystem path. An enabled
mapping requires a zero-based integer `message` position within that schema's
messages array and an explicit `envelope`: `B`, `C`, `D`, or `D1`. There is no
fallback to the schema default. Reordering an externally edited messages array
requires updating its mapping ordinals. Browser message moves and deletion
adjust surviving references; deleting a selected message disables and clears
the affected selection. Undo restores both definitions and references.

Each output binds only its chosen message, borrowing the original canonical
definitions. Unrelated messages cannot prevent that output from using an
envelope. The native library resolves the effective payload edition and subtype
to the exact header identity. Named MIL-STD-6017B uses code 8 under C, code 7
under D/D1, and no version under B. Explicit ordinals can select either of two
editions whose header identities would otherwise coincide under B. Raw codes
retain their source-profile restrictions; unsupported selected editions and
absent VMF versions under D/D1 fail validation.

Optional `vmf_header` supplies native header metadata, such as originator,
recipients, precedence, or classification. Omitted fields and the sole message
descriptor receive native defaults. Supplied containers must have the proper
types, and a supplied messages array must contain exactly one body descriptor.
Caller-supplied `id` is rejected, including null or an otherwise matching value;
the service generates it from the selected message and envelope. Header options
follow VMF's [header JSON contract][header]. The author API derives lengths;
authentication generation and compression are unsupported.

## Bindings and values

`fields` entries name canonical CoT catalog paths. A VMF target is
`{"key":"application-key"}`. The key must resolve within the selected
message; numeric index destinations are rejected. Generated index addresses
are inspection metadata and can change when schema elements move. Key-based
field bindings survive those moves without being redirected to another field.
A source may feed multiple targets. Each target occurrence has one writer.
Indicators are structural controls rather than ordinary data targets.

Optional empty text is unavailable, while required empty text and numeric
zero retain native availability semantics. No missing CoT value is fabricated.
Only standard catalog fields are individually mappable. Residual `detail.xml`
and opaque extensions have visibility/presence metadata; they do not introduce
an arbitrary XML-path mapping engine.

Native schema constraints determine wire widths, representation, and encoding.
For numeric bindings, optional `factor` and `offset` obey:

```text
physical_vmf = wire_integer * schema_factor + schema_bias
cot_value = physical_vmf * binding_factor + binding_offset
```

Defaults are factor 1 and offset 0. Encoding inverts these relationships,
checks range, and rounds halfway away from zero. Values are never silently
clamped or wrapped. Full signed/unsigned 64-bit integer domains are retained.
Nonfinite mapped values fail.

A `values` table maps logical CoT scalars to raw unsigned VMF codes:

```json
{"cot":"type", "vmf":{"key":"affiliation"},
 "values":[{"cot":"a-f-G", "vmf":1}]}
```

Keys are unique in the native source type. Many-to-one codes are allowed.
Unmatched numeric inputs fall back to numeric conversion; unmatched text fails.
Raw values still obey schema constraints. Text enters the native API as UTF-8;
wire encoding and lengths come from the schema, without guessed padding or
truncation. Binary string bindings require `encoding:"hex"`; bit fields may
also specify `bit_count`, with unused high bits zero.

## Constants and structure

`vmf_constants` supplies explicit VMF values with the same target notation.
Text uses strings; signed fields use logical signed integers; unsigned,
enumerated, and scaled fields use raw unsigned codes. Binary constants require
hex encoding. A schema's constant restriction does not manufacture a value.
Length/count scalars and mandatory values must be supplied explicitly.

Inside repeats, bindings and constants carry every enclosing occurrence:

```json
{"cot":"point.latitude", "vmf":{"key":"latitude"},
 "occurrences":[{"repeat":1,"index":0},{"repeat":2,"index":1}]}
```

Occurrence indexes are zero-based and ordered outermost first. Repeat and
group identifiers come from the native catalog in wrapper preorder; revise
structural assertions when changing that structure. `presence`
assertions apply only to GPI-controlled groups; absent assertions allow native
inference from supplied descendants. `repeat_counts` assertions apply only to
FRI/GRI-driven recurrence. Fixed and preceding-scalar repeats remain governed
by the schema. Runtime activity and conditional constraints are native-owned.

Each output stages a complete PDU. Missing active mandatory values, invalid
conversion, structural failure, oversized PDU, or failed publication suppress
that output and increment failure counts; subsequent outputs still run.
No reverse translation or output routing predicates are provided.

[schema]: https://github.com/pgsocks/vmf/blob/master/docs/schema-json.md
[header]: https://github.com/pgsocks/vmf/blob/master/docs/header-json.md
