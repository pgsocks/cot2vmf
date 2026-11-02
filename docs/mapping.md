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
Labels, notes, and conversion behavior are not added to that native dialect.
All schema definitions must validate before the whole workspace can activate.

An output is `{ "id": "position-out", "enabled": true, "mapping": { ... } }`.
Disabled outputs may retain incomplete mapping objects. Each enabled output
uses the `cot-vmf-mapping-config/1` format:

```json
{
  "format": "cot-vmf-mapping-config/1",
  "schema": "position",
  "vmf_header": {
    "fields": {
      "messages": [{"id": {
        "user_message_format": 2,
        "standard_version": 0,
        "identification": {"functional_area": 1, "message_number": 1}
      }}]
    }
  },
  "fields": [
    {"cot": "point.latitude", "vmf": {"key": "latitude"}}
  ]
}
```

Here `schema` names a workspace id, never a filesystem path. An enabled
mapping selects one body using an exact native header identity. Standard and
subtype presence/value participate in identity; the K-number alone does not
identify every payload. The GUI derives the initial header from the native
catalog. Header options follow VMF's [header JSON contract][header]. The author
API derives lengths; authentication generation and compression are unsupported.

## Bindings and values

`fields` entries name canonical CoT catalog paths. A VMF target is either
`{"key":"application-key"}` or `{"index":"3.1"}`; numeric index arrays
are also accepted. Keys must resolve uniquely within the selected message.
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
{"cot":"point.latitude", "vmf":{"index":"3.1"},
 "occurrences":[{"repeat":1,"index":0},{"repeat":2,"index":1}]}
```

Occurrence indexes are zero-based and ordered outermost first. `presence`
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
