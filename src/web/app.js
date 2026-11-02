"use strict";

// Native integer tokens remain exact through authoring, import and export.
function parseJSON(source) {
  let at = 0;
  const white = () => { while (/\s/.test(source[at] || "") && at < source.length) at++; };
  function value(depth = 0) {
    if (depth > 64) throw new Error("Document nesting exceeds 64 levels.");
    white();
    const start = at, char = source[at];
    if (char === '"') {
      at++;
      while (at < source.length) {
        if (source[at++] === '"') return JSON.parse(source.slice(start, at));
        if (source[at - 1] === "\\") at++;
      }
      throw new Error("Unterminated text value.");
    }
    if (char === "{" || char === "[") {
      const object = char === "{", result = object ? {} : [], end = object ? "}" : "]";
      at++; white();
      if (source[at] === end) { at++; return result; }
      for (;;) {
        let key;
        if (object) {
          white();
          if (source[at] !== '"') throw new Error("Expected a property name.");
          key = value(depth + 1); white();
          if (source[at++] !== ":") throw new Error("Expected a colon.");
          if (Object.prototype.hasOwnProperty.call(result, key)) throw new Error("Duplicate property: " + key);
        }
        const next = value(depth + 1);
        if (object) Object.defineProperty(result, key, {value: next, writable: true, enumerable: true, configurable: true});
        else result.push(next);
        white();
        const separator = source[at++];
        if (separator === end) return result;
        if (separator !== ",") throw new Error("Expected a comma.");
      }
    }
    for (const [token, result] of [["true", true], ["false", false], ["null", null]]) {
      if (source.startsWith(token, at)) { at += token.length; return result; }
    }
    const number = source.slice(at).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!number) throw new Error("Expected a value near byte " + at + ".");
    at += number[0].length;
    if (!/[.eE]/.test(number[0])) {
      const integer = BigInt(number[0]);
      return integer >= BigInt(Number.MIN_SAFE_INTEGER) && integer <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(integer) : integer;
    }
    const result = Number(number[0]);
    if (!Number.isFinite(result)) throw new Error("Numeric values must be finite.");
    return result;
  }
  const result = value(); white();
  if (at !== source.length) throw new Error("Unexpected trailing content.");
  return result;
}
function json(value, pretty = false, depth = 0) {
  if (typeof value === "bigint") return value.toString();
  if (!value || typeof value !== "object") return JSON.stringify(value);
  const pad = pretty ? "  ".repeat(depth + 1) : "", gap = pretty ? "\n" : "", sep = pretty ? ": " : ":";
  const items = Array.isArray(value) ? value.map(item => json(item, pretty, depth + 1)) : Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => JSON.stringify(key) + sep + json(item, pretty, depth + 1));
  const [open, close] = Array.isArray(value) ? ["[", "]"] : ["{", "}"];
  return items.length ? open + gap + pad + items.join("," + gap + pad) + gap + (pretty ? "  ".repeat(depth) : "") + close : open + close;
}
const clone = value => parseJSON(json(value));
const $ = id => document.getElementById(id);
function el(tag, className = "", text = "") { const node = document.createElement(tag); node.className = className; node.textContent = text; return node; }
function button(text, action, className = "button small") { const node = el("button", className, text); node.type = "button"; node.addEventListener("click", action); return node; }
function message(text, error = false) { $("toast").hidden = !text; $("toast").textContent = text; $("toast").classList.toggle("error", error); }
const text = {kind: "text"}, integer = {kind: "integer"}, number = {kind: "number"}, boolean = {kind: "boolean"}, scalar = {kind: "scalar"};
const enumeration = (...values) => ({kind: "enum", values});
const object = (properties, required = []) => ({kind: "object", properties, required});
const array = item => ({kind: "array", item});
const order = enumeration("default", "lsb_first", "msb_first");
const standards = enumeration("MIL-STD-6017", "MIL-STD-6017A", "MIL-STD-6017B", "MIL-STD-6017C", "MIL-STD-6017D", "MIL-STD-6017E", "TIDP-TE-R2", "TIDP-TE-R3", "TIDP-TE-R4", "TIDP-TE-R5", "TIDP-TE-R6", "TIDP-TE-R7", "TIDP-FTE-R6");
const rangeSpec = object({first: integer, last: integer}, ["first", "last"]);
const rationalSpec = object({numerator: integer, denominator: {...integer, initial: 1}}, ["numerator", "denominator"]);
const conditionSpec = object({mode: enumeration("all", "any"), negate: boolean, terms: array(object({field: text, values: array(rangeSpec), mask: integer, negate: boolean}, ["field", "values"]))}, ["mode", "terms"]);
const indexSpec = object({index_number: text, number_of_bits: {...integer, initial: 1}, key: text, group_code: text, repeat_code: text, encode_type: enumeration("default", "bool", "unsigned", "signed", "enum", "scaled", "bits", "octets", "text", "literal"), indicator: enumeration("none", "fpi", "gpi", "fri", "gri"), target: text, representation: enumeration("default", "unsigned", "twos_complement", "ones_complement", "sign_magnitude"), bit_order: order, text_encoding: enumeration("default", "ascii_7", "ascii_8", "latin_1", "utf_8"), length_from: text, length_bias: integer, when: conditionSpec, allowed: array(rangeSpec), constant: integer, scale: object({factor: rationalSpec, bias: rationalSpec, sentinels: array(integer)}, ["factor", "bias"])}, ["index_number", "number_of_bits"]);
const repeatSpec = object({repeat_code: text, count: integer, count_from: text, maximum: integer, minimum: integer, bias: integer}, ["repeat_code"]);
const nativeMessageSpec = object({message_number: text, indexes: array(indexSpec), message_standard: standards, standard_version: scalar, subtype: integer, repeats: array(repeatSpec), octet_order: order}, ["message_number", "indexes"]);
const schemaSpec = object({format: {kind: "enum", values: ["vmf-schema/1"]}, envelope: enumeration("B", "C", "D", "D1"), message_standard: standards, standard_version: scalar, messages: array(nativeMessageSpec)}, ["format", "envelope", "messages"]);
const occurrenceSpec = object({repeat: integer, index: integer}, ["repeat", "index"]);
const targetSpec = object({key: text, index: scalar});
const bindingSpec = object({cot: text, vmf: targetSpec, factor: {...number, initial: 1}, offset: number, values: array(object({cot: scalar, vmf: integer}, ["cot", "vmf"])), encoding: enumeration("hex"), bit_count: integer, occurrences: array(occurrenceSpec)}, ["cot", "vmf"]);
const constantSpec = object({vmf: targetSpec, value: scalar, encoding: enumeration("hex"), bit_count: integer, occurrences: array(occurrenceSpec)}, ["vmf", "value"]);
const addressSpec = object({urn: integer, name: text});
const workspaceSpec = object({format: enumeration("cot-vmf-workspace/1"), schemas: array(object({id: text, document: schemaSpec}, ["id", "document"])), outputs: array(object({id: text, enabled: boolean, mapping: object({})}, ["id", "enabled", "mapping"]))}, ["format", "schemas", "outputs"]);
const dtgSpec = object({year: integer, month: {...integer, initial: 1}, day: {...integer, initial: 1}, hour: integer, minute: integer, second: integer, extension: integer}, ["year", "month", "day", "hour", "minute", "second"]);
function headerSpec(profile) {
  const idSpec = object({user_message_format: {...integer, initial: 2}, standard_version: integer, identification: object({functional_area: integer, message_number: integer, subtype: integer}, ["functional_area", "message_number"])}, ["user_message_format", "identification"]);
  if (profile === "B") delete idSpec.properties.standard_version;
  const reference = object({originator: addressSpec, dtg: dtgSpec, ...(profile === "B" ? {functional_area: integer, message_number: integer} : {})}, ["originator", "dtg"]);
  const props = {id: idSpec, file_name: text, message_size_octets: integer, operation: integer, retransmit: boolean, precedence: integer, classification: integer, originator_dtg: dtgSpec, perishability: dtgSpec, acknowledgment: object({machine: boolean, operator_ack: boolean, operator_reply: boolean}), response: object({acknowledged: dtgSpec, receipt_compliance: integer, cantco_reason: integer, cantpro_reason: integer, amplification: text}, ["receipt_compliance"]), references: array(reference)};
  if (profile === "B") props.marking_b = integer;
  else if (profile === "C") props.marking_c = text;
  else props.markings = array(integer);
  const fields = {compression: integer, originator: addressSpec, recipients: array(addressSpec), information_addressees: array(addressSpec), messages: array(object(props, ["id"]))};
  if (profile !== "B") fields.header_size_octets = integer;
  return object({fields: object(fields, ["messages"]), ...(profile === "B" ? {} : {shortened: boolean})}, ["fields"]);
}
function initial(spec) {
  if (spec.initial !== undefined) return clone(spec.initial);
  if (spec.kind === "object") return Object.fromEntries((spec.required || []).map(key => [key, initial(spec.properties[key])]));
  if (spec.kind === "array") return [];
  if (spec.kind === "enum") return spec.values[0];
  if (spec.kind === "boolean") return false;
  if (spec.kind === "integer" || spec.kind === "number") return 0;
  return "";
}
function infer(value) {
  if (Array.isArray(value)) return array(value.length ? infer(value[0]) : text);
  if (value && typeof value === "object") return object(Object.fromEntries(Object.entries(value).map(([key, val]) => [key, infer(val)])));
  if (typeof value === "boolean") return boolean;
  if (typeof value === "number" || typeof value === "bigint") return number;
  return text;
}

let state = {draft: {format: "cot-vmf-workspace/1", schemas: [], outputs: []}, catalog: {cot: [], schemas: []}};
let workspace = state.draft, generation = 0, savedGeneration = 0, saving = false, saveTimer;
let selectedSchema = null, selectedMessage = null, selectedIndex = null, selectedWire = null, selectedOutput = null;
let armedSource = null, dragging = null, pointerPosition = null, activeFields = new Set(), liveTimer, wireFrame;
let latestActivity = null;
const expandedProperties = new Set();
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const isRevision = value => (typeof value === "bigint" || Number.isSafeInteger(value)) && value >= 0;
const draftSchemas = () => Array.isArray(workspace.schemas) ? workspace.schemas.filter(isObject) : [];
const draftOutputs = () => Array.isArray(workspace.outputs) ? workspace.outputs.filter(isObject) : [];
const schemaById = id => draftSchemas().find(item => item.id === id);
const catalogSchema = id => (state.catalog?.schemas || []).find(item => item.id === id);
const selectedDefinition = () => schemaById(selectedSchema)?.document;
const uid = prefix => prefix + "-" + crypto.getRandomValues(new Uint32Array(2)).join("-");

function changed() {
  generation++;
  $("save-status").textContent = "Saving edits…";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 180);
  renderFeedback();
}
async function request(path, options = {}) {
  const response = await fetch(path, {cache: "no-store", credentials: "same-origin", ...options});
  const body = parseJSON(await response.text());
  if (!response.ok) {
    const error = new Error(body.error || body.message || "Request failed (" + response.status + ").");
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}
function status() {
  $("save-status").textContent = state.valid === false ? "Draft saved · testing previous active mapping" : "Changes saved";
  $("revision-label").textContent = "Draft " + (state.draft_revision ?? "—") + " · Active " + (state.active_revision ?? "—");
  const error = state.error;
  $("draft-error").hidden = !error;
  $("draft-error").textContent = error ? "Draft needs attention. The last valid configuration remains active.\n" + (typeof error === "string" ? error : json(error)) : "";
  rememberActivity(state.activity);
  renderFeedback();
}
async function save() {
  if (saving || generation === savedGeneration) return;
  saving = true;
  $("save-status").textContent = "Saving edits…";
  const version = generation;
  try {
    const next = await request("/api/state", {method: "POST", headers: {"Content-Type": "application/json"}, body: json({revision: state.draft_revision, workspace})});
    state = next;
    savedGeneration = version;
    message("");
    // Keep the editable objects borrowed by controls that still have focus.
    if (version === generation) { status(); render(true); }
  } catch (error) {
    if (error.status === 500 && isObject(error.body?.draft)
        && isRevision(error.body.draft_revision)
        && isRevision(error.body.active_revision)
        && isObject(error.body.activity)
        && typeof error.body.valid === "boolean") {
      // A failed activation may still have persisted this draft revision.
      // Keep the objects and generations borrowed by pending editor input.
      state = error.body;
      status();
      $("save-status").textContent = "Draft not active · retry with your next edit";
    } else $("save-status").textContent = "Edits not saved";
    message(error.status === 409 ? "The workspace changed in another window. Export your schema if needed, then reload before editing." : error.message, true);
  } finally {
    saving = false;
    if (generation !== savedGeneration && generation !== version) save();
    renderFeedback();
  }
}

// A typed tree editor exposes native properties without a raw JSON escape hatch.
function editor(value, spec, set, label = "", path = "") {
  spec ||= infer(value);
  if (spec.kind === "scalar" && Array.isArray(value)) spec = array(integer);
  const node = el("div", "object-editor");
  if (value === null) {
    node.append(el("p", "property-help", "Absent"), button("Set value", () => { set(initial(spec)); changed(); renderEditors(); }));
    return node;
  }
  if ((spec.kind === "object" && (typeof value !== "object" || Array.isArray(value))) || (spec.kind === "array" && !Array.isArray(value))) {
    node.append(el("p", "schema-invalid", "This property has the wrong native value type."), button("Replace with " + spec.kind, () => { set(initial(spec)); changed(); render(); }));
    return node;
  }
  if (spec.kind === "object") {
    for (const [key, current] of Object.entries(value)) {
      const row = el("div", "property"), name = el("div", "property-label");
      row.dataset.propertyName = key;
      name.append(el("code", "", key), button("×", () => { delete value[key]; changed(); renderEditors(); }, "remove-property"));
      row.append(name);
      const childSpec = spec.properties[key] || infer(current);
      const nested = current !== null && typeof current === "object";
      const propertyPath = path + "/" + key;
      const control = editor(current, childSpec, next => { value[key] = next; set(value); }, key, propertyPath);
      if (nested) {
        const details = el("details"); details.open = expandedProperties.has(propertyPath);
        details.addEventListener("toggle", () => { if (details.open) expandedProperties.add(propertyPath); else expandedProperties.delete(propertyPath); });
        details.append(el("summary", "", Array.isArray(current) ? current.length + " items" : "Edit " + key), control);
        row.append(details);
      } else row.append(control);
      node.append(row);
    }
    const missing = Object.keys(spec.properties).filter(key => !Object.prototype.hasOwnProperty.call(value, key));
    if (missing.length) {
      const addition = el("div", "add-property"), select = el("select"); select.dataset.testid = "add-property";
      select.setAttribute("aria-label", "Property to add");
      for (const key of missing) select.add(new Option(key, key));
      addition.append(select, button("+ Add", () => { value[select.value] = initial(spec.properties[select.value]); set(value); changed(); renderEditors(); }));
      node.append(addition);
    }
    return node;
  }
  if (spec.kind === "array") {
    value.forEach((item, index) => {
      const row = el("div", "array-item"), heading = el("div", "array-heading"), actions = el("div", "array-actions");
      heading.append(el("span", "", "Item " + (index + 1)));
      actions.append(button("↑", () => { if (index) { [value[index - 1], value[index]] = [value[index], value[index - 1]]; changed(); renderEditors(); } }, ""), button("↓", () => { if (index + 1 < value.length) { [value[index + 1], value[index]] = [value[index], value[index + 1]]; changed(); renderEditors(); } }, ""), button("×", () => { value.splice(index, 1); changed(); renderEditors(); }, ""));
      heading.append(actions); row.append(heading, editor(item, spec.item, next => { value[index] = next; set(value); }, label, path + "/" + index)); node.append(row);
    });
    node.append(button("+ Add item", () => { value.push(initial(spec.item)); set(value); changed(); renderEditors(); }, "button small array-add"));
    return node;
  }
  let input;
  if (spec.kind === "enum") {
    input = el("select");
    for (const option of spec.values) input.add(new Option(option, option));
    if (!spec.values.includes(value)) input.add(new Option(String(value), String(value)));
    input.value = value;
  } else if (spec.kind === "boolean") {
    input = el("input"); input.type = "checkbox"; input.checked = !!value;
  } else {
    input = el("input"); input.type = "text"; input.value = String(value);
    input.spellcheck = false;
    if (spec.kind === "integer" || spec.kind === "number") input.inputMode = "decimal";
  }
  input.dataset.property = label;
  input.setAttribute("aria-label", label || "Value");
  let kind;
  if (spec.kind === "scalar") {
    kind = el("select", "scalar-kind"); kind.setAttribute("aria-label", label + " value type");
    for (const option of ["text", "number", "boolean"]) kind.add(new Option(option, option));
    kind.value = typeof value === "string" ? "text" : typeof value === "boolean" ? "boolean" : "number";
    kind.addEventListener("change", () => { set(kind.value === "text" ? "" : kind.value === "boolean" ? false : 0); changed(); renderEditors(); });
    node.append(kind);
  }
  input.addEventListener("change", () => {
    try {
      let next = input.value;
      if (spec.kind === "boolean") next = input.checked;
      else if (spec.kind === "integer" || spec.kind === "number" || (spec.kind === "scalar" && kind.value !== "text")) {
        next = parseJSON(input.value);
        if (kind?.value === "boolean") { if (typeof next !== "boolean") throw new Error("Enter true or false."); }
        else if (typeof next !== "number" && typeof next !== "bigint") throw new Error("Enter a numeric value.");
        if (spec.kind === "integer" && typeof next === "number" && !Number.isInteger(next)) throw new Error("Enter an integer token.");
        if (spec.kind === "integer" && /[.eE]/.test(input.value)) throw new Error("Integer fields do not accept decimal or exponent tokens.");
      }
      input.setCustomValidity(""); set(next); changed();
    } catch (error) { input.setCustomValidity(error.message); input.reportValidity(); }
  });
  node.append(input);
  return node;
}

function renderSchemas() {
  const list = $("schema-list"); list.replaceChildren();
  if (!workspace.schemas.length) list.append(el("p", "empty-hint", "No payload definitions yet."));
  for (const schema of workspace.schemas) {
    const card = button("", () => { selectedSchema = schema.id; selectedMessage = selectedIndex = null; renderSchemas(); renderSchemaEditor(); }, "schema-card" + (selectedSchema === schema.id ? " selected" : ""));
    card.dataset.schemaId = schema.id;
    card.append(el("strong", "", schema.id), el("small", "", "Envelope " + (schema.document.envelope || "—") + " · " + (schema.document.messages || []).length + " message types"));
    list.append(card);
  }
  const definition = selectedDefinition(), tree = $("schema-tree"); tree.replaceChildren();
  $("add-message").disabled = !definition;
  $("export-schema").disabled = $("delete-schema").disabled = !definition;
  $("add-index").disabled = !definition || selectedMessage === null;
  if (!definition) { tree.append(el("p", "empty-hint", "Create or import a schema to begin.")); return; }
  const root = button("Schema properties", () => { selectedMessage = selectedIndex = null; renderSchemas(); renderSchemaEditor(); }, "tree-select" + (selectedMessage === null ? " selected" : ""));
  tree.append(root);
  (Array.isArray(definition.messages) ? definition.messages : []).forEach((msg, mi) => {
    if (!msg || typeof msg !== "object") return;
    const group = el("div", "tree-message");
    group.append(button(msg.message_number || "Untitled message", () => { selectedMessage = mi; selectedIndex = null; renderSchemas(); renderSchemaEditor(); }, "tree-select" + (selectedMessage === mi && selectedIndex === null ? " selected" : "")));
    (Array.isArray(msg.indexes) ? msg.indexes : []).forEach((field, fi) => { if (field && typeof field === "object") group.append(button((field.index_number || "?") + "  " + (field.key || field.indicator || "field"), () => { selectedMessage = mi; selectedIndex = fi; renderSchemas(); renderSchemaEditor(); }, "tree-select field" + (selectedMessage === mi && selectedIndex === fi ? " selected" : ""))); });
    tree.append(group);
  });
}
function renderSchemaEditor() {
  const target = $("schema-editor"), definition = selectedDefinition(); target.replaceChildren();
  if (!definition) { $("schema-inspector-title").textContent = "Select a definition"; target.append(el("p", "empty-hint", "Choose a schema, message, or field. Every native property is available as a structured control.")); return; }
  let current = definition, spec = schemaSpec, title = "Schema properties";
  if (selectedMessage !== null) {
    current = definition.messages?.[selectedMessage]; spec = nativeMessageSpec; title = "Message properties";
    if (!current) { selectedMessage = selectedIndex = null; return renderSchemaEditor(); }
    if (selectedIndex !== null) { current = current.indexes?.[selectedIndex]; spec = indexSpec; title = "Field properties"; }
  }
  if (!current) { selectedIndex = null; return renderSchemaEditor(); }
  $("schema-inspector-title").textContent = title;
  const native = catalogSchema(selectedSchema);
  if (native?.valid === false) target.append(el("p", "schema-invalid", native.diagnostic || "Native schema validation failed."));
  const setCurrent = next => {
    if (selectedMessage === null) schemaById(selectedSchema).document = next;
    else if (selectedIndex === null) definition.messages[selectedMessage] = next;
    else definition.messages[selectedMessage].indexes[selectedIndex] = next;
  };
  target.append(editor(current, spec, setCurrent, "", "schema/" + selectedSchema + "/" + selectedMessage + "/" + selectedIndex));
  if (selectedMessage !== null) {
    const actions = el("div", "button-row");
    if (selectedIndex !== null) {
      actions.append(button("Move field up", () => { if (selectedIndex) { const fields = definition.messages[selectedMessage].indexes; [fields[selectedIndex - 1], fields[selectedIndex]] = [fields[selectedIndex], fields[selectedIndex - 1]]; selectedIndex--; changed(); renderSchemas(); renderSchemaEditor(); } }), button("Delete field", () => { definition.messages[selectedMessage].indexes.splice(selectedIndex, 1); selectedIndex = null; changed(); renderSchemas(); renderSchemaEditor(); }, "text-button danger"));
    } else actions.append(button("Delete message", () => { definition.messages.splice(selectedMessage, 1); selectedMessage = selectedIndex = null; changed(); renderSchemas(); renderSchemaEditor(); }, "text-button danger"));
    target.append(el("hr", "section-divider"), actions);
  }
}
function canonical(value) {
  if (!value || typeof value !== "object") return json(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
}
function messageIdentity(message) { return canonical(message.identity || message.header?.fields?.messages?.[0]?.id); }
function outputFor(schema, message) { return workspace.outputs.find(out => out.mapping?.schema === schema && canonical(out.mapping?.vmf_header?.fields?.messages?.[0]?.id) === messageIdentity(message)); }
function outputMessage(output) {
  const schema = catalogSchema(output.mapping?.schema);
  return schema?.messages?.find(msg => canonical(output.mapping?.vmf_header?.fields?.messages?.[0]?.id) === messageIdentity(msg));
}
function rememberActivity(data) {
  if (data && (!latestActivity || data.sequence >= latestActivity.sequence)) latestActivity = data;
}
function outputLabel(output) {
  if (output?.mapping?.name) return output.mapping.name;
  const message = output && outputMessage(output);
  return message && /^output-\d+-\d+$/.test(output.id)
    ? output.mapping.schema + " · " + (message.message_number || message.label) : output?.id || "Message output";
}
function feedbackIsCurrent(result) {
  return !saving && generation === savedGeneration && state.valid !== false
    && result.revision === state.draft_revision
    && result.revision === state.active_revision
    && result.revision === latestActivity?.active_revision
    && state.draft_revision === latestActivity?.draft_revision;
}
function feedbackLocation(result) {
  const output = draftOutputs().find(item => item.id === result.id);
  const message = output && outputMessage(output);
  if (!message) return {output};
  const match = /^\/fields\/(\d+)(?:\/|$)/.exec(result.config_path || "");
  const binding = match && Array.isArray(output.mapping.fields)
    && output.mapping.fields[Number(match[1])];
  const wireField = isObject(binding) && message.fields.find(item => refMatches(binding.vmf, item));
  const wire = wireField ? {id: output.id + ":" + Number(match[1]), field: wireField} : null;
  const index = String(result.target_index || "").replace(/\.$/, "");
  const field = index && message.fields.find(item => item.index.replace(/\.$/, "") === index);
  return {output, message, wire, field: field || wire?.field};
}
function feedbackTarget(result) {
  const location = feedbackLocation(result);
  return location.field && [...document.querySelectorAll(".target-port")].find(node =>
    node.dataset.schemaId === location.output.mapping.schema
    && node.dataset.messageOrdinal === String(location.message.ordinal)
    && node.dataset.targetIndex === location.field.index);
}
function focusFeedback(result) {
  if (!feedbackIsCurrent(result) || result.status !== "not_encoded") return;
  const location = feedbackLocation(result);
  selectedWire = location.wire?.id || null;
  selectedOutput = selectedWire ? null : result.id;
  renderOutputs(); renderMappingEditor(); scheduleWires();
  const target = feedbackTarget(result);
  if (target) { target.scrollIntoView({block: "nearest"}); target.focus(); }
  else $("mapping-inspector-title").scrollIntoView({block: "nearest"});
}
function wireHasDiagnostic(wire) {
  return (latestActivity?.outputs || []).some(result => result.id === wire.output.id
    && result.status === "not_encoded" && feedbackIsCurrent(result)
    && /^\/fields\/(\d+)(?:\/|$)/.exec(result.config_path || "")?.[1] === String(wire.index));
}
function renderFeedback() {
  const data = latestActivity || {};
  $("received-count").textContent = data.received ?? 0;
  $("decoded-count").textContent = data.decoded ?? 0;
  $("sent-count").textContent = data.outputs_succeeded ?? 0;
  $("failed-count").textContent = data.outputs_failed ?? 0;
  $("stimulation-status").textContent = !data.received
    ? "Waiting for CoT. Start real or synthetic traffic through TAK Gateway."
    : !data.decoded ? "CoT is arriving, but none has decoded yet. Check the input stream."
    : "CoT has been received. Highlights show sources observed in recent traffic, not encoding success.";
  const container = $("output-results");
  const focusedOutput = container.contains(document.activeElement)
    ? document.activeElement.dataset.feedbackOutput : null;
  container.replaceChildren();
  document.querySelectorAll(".diagnostic-target").forEach(node => node.classList.remove("diagnostic-target"));
  const results = data.outputs || [];
  if (!results.length) container.append(el("p", "empty-hint", "Connect the data your message needs to create an output. Its last test result will appear here."));
  const announcements = [];
  for (const result of results) {
    const current = feedbackIsCurrent(result);
    const output = draftOutputs().find(item => item.id === result.id);
    const card = el("article", "output-result " + result.status);
    card.dataset.outputId = result.id;
    card.append(el("h3", "", current && output ? outputLabel(output) : result.id));
    const labels = {sent: "VMF sent", not_encoded: "Not encoded for this event",
      send_failed: "Encoded; send failed", paused: "Paused",
      waiting: data.received ? "Waiting for the next event after your edit" : "Waiting for traffic"};
    const label = labels[result.status] || "Waiting for test feedback";
    card.append(el("p", "result-state", label));
    if (!current) {
      const context = result.revision < state.draft_revision || state.valid === false
        ? "Testing previous active revision " + result.revision + ". These results do not describe the edited draft."
        : result.revision > state.draft_revision
        ? "Testing active revision " + result.revision + ". Reload the workspace to edit this version."
        : "Testing the saved active mapping. Your pending edits have not been tested yet.";
      card.append(el("p", "result-context", context));
    }
    if (result.event) card.append(el("p", "result-context", "Last attempt: CoT event " + result.event));
    if (result.status === "sent") card.append(el("p", "result-help", "The selected data was encoded and sent as one VMF message."));
    if (result.status === "not_encoded") {
      card.append(el("p", "result-help", "Use this result to refine the mapping, then test with the next event. Only the data your message needs must be supplied."));
      if (result.message || result.code) card.append(el("p", "result-diagnostic", result.message || result.code));
      if (current && output) {
        const location = feedbackLocation(result);
        const name = location.wire ? "Review connection" : location.field ? "Review target" : "Review message controls";
        const action = button(name, () => focusFeedback(result), "text-button");
        action.dataset.feedbackOutput = result.id;
        card.append(action);
        const target = feedbackTarget(result);
        if (target) target.classList.add("diagnostic-target");
      }
    }
    if (result.status === "send_failed") {
      card.append(el("p", "result-help", "Encoding succeeded. Check the VMF destination and transport before the next attempt."));
      if (result.message || result.code) card.append(el("p", "result-diagnostic", result.message || result.code));
    }
    if (result.status === "paused") card.append(el("p", "result-help", "Send is off. This output will not be attempted as CoT arrives."));
    container.append(card);
    announcements.push(result.id + ": " + label);
  }
  const announcement = announcements.join(". ");
  if ($("test-announcement").textContent !== announcement) $("test-announcement").textContent = announcement;
  if (focusedOutput) [...container.querySelectorAll("button")].find(node =>
    node.dataset.feedbackOutput === focusedOutput)?.focus({preventScroll: true});
}
function selectOutput(id) {
  selectedOutput = id; selectedWire = null;
  renderOutputs(); renderMappingEditor(); scheduleWires();
}
function inspectMessage(schema, message) {
  const existing = outputFor(schema, message);
  const output = existing || ensureOutput(schema, message, false);
  if (!existing) changed();
  selectOutput(output.id);
}
function ensureOutput(schema, message, enabled = true) {
  let output = outputFor(schema, message);
  if (!output) {
    output = {id: uid("output"), enabled, mapping: {format: "cot-vmf-mapping-config/1", schema, vmf_header: clone(message.header), fields: []}};
    workspace.outputs.push(output);
  }
  return output;
}
function mappingTarget(field) { return {index: field.index}; }
function refMatches(reference, field) { return isObject(reference) && (reference.key !== undefined ? reference.key === field.key : String(Array.isArray(reference.index) ? reference.index.join(".") : reference.index).replace(/\.$/, "") === field.index.replace(/\.$/, "")); }
function findField(schemaId, message, reference) { return (message.fields || []).find(field => refMatches(reference, field)); }
function wireRecords() {
  const records = [];
  draftOutputs().forEach(output => {
    const schema = catalogSchema(output.mapping?.schema);
    const message = outputMessage(output);
    if (!message) return;
    (Array.isArray(output.mapping.fields) ? output.mapping.fields : []).forEach((binding, index) => {
      if (!isObject(binding)) return;
      const field = findField(schema.id, message, binding.vmf);
      if (field) records.push({id: output.id + ":" + index, output, binding, index, field, schema: schema.id, message});
    });
  });
  return records;
}
function selectSource(source) { armedSource = armedSource === source.path ? null : source.path; document.querySelectorAll(".source-port").forEach(node => node.classList.toggle("armed", node.dataset.sourcePath === armedSource)); }
function connect(sourcePath, schemaId, msg, field) {
  const output = ensureOutput(schemaId, msg);
  if (["fields", "vmf_constants"].some(key => output.mapping[key] !== undefined && !Array.isArray(output.mapping[key]))) {
    selectOutput(output.id);
    message("Repair the mapping collections in this output before adding connections.", true); return;
  }
  const matches = binding => isObject(binding) && refMatches(binding.vmf, field) && (!Array.isArray(binding.occurrences) || !binding.occurrences.length);
  if ((output.mapping.fields || []).some(matches) || (output.mapping.vmf_constants || []).some(matches)) {
    message("This target already has a value. Select its wire to edit it, or use occurrence selectors for repeated fields."); return;
  }
  const binding = {cot: sourcePath, vmf: mappingTarget(field)};
  if (field.repeats?.length) binding.occurrences = field.repeats.map(repeat => ({repeat: repeat.repeat, index: 0}));
  (output.mapping.fields ||= []).push(binding);
  selectedWire = output.id + ":" + (output.mapping.fields.length - 1); selectedOutput = null; armedSource = null;
  message(""); changed(); renderMapping(); renderMappingEditor();
}
function renderOutputs() {
  const list = $("output-list"); list.replaceChildren();
  if (!workspace.outputs.length) list.append(el("p", "empty-hint", "No outputs yet."));
  for (const output of workspace.outputs) {
    const row = el("div", "output-row"), select = button(outputLabel(output), () => selectOutput(output.id), "output-select" + (selectedOutput === output.id ? " selected" : ""));
    select.dataset.outputId = output.id;
    const enable = el("label", "output-enable"), toggle = el("input");
    toggle.type = "checkbox"; toggle.checked = !!output.enabled;
    toggle.setAttribute("aria-label", "Enable output " + output.id);
    toggle.addEventListener("change", () => { output.enabled = toggle.checked; changed(); renderMapping(); });
    enable.append(toggle, "Send"); row.append(select, enable);
    if (!outputMessage(output)) row.append(el("span", "output-unresolved", "Unresolved reference"));
    list.append(row);
  }
}
function renderMapping() {
  if (workspaceNeedsRepair()) { render(true); return; }
  renderOutputs();
  const sources = $("source-fields"), targets = $("target-fields"), filter = $("source-search").value.toLowerCase(); sources.replaceChildren(); targets.replaceChildren();
  let group;
  for (const source of state.catalog?.cot || []) {
    if (filter && ![source.path, source.type, source.unit, source.group].join(" ").toLowerCase().includes(filter)) continue;
    if (source.group !== group) { group = source.group; sources.append(el("div", "source-group", group || "Event")); }
    const port = button("", () => { if (source.mappable) selectSource(source); }, "source-port" + (activeFields.has(Number(source.id)) ? " live" : ""));
    port.dataset.sourceId = source.id; port.dataset.sourcePath = source.path; port.classList.toggle("armed", armedSource === source.path);
    const copy = el("span", "port-copy"); copy.append(el("span", "field-path", source.path), el("span", "field-meta", source.type + (source.unit && source.unit !== "none" ? " · " + source.unit : "") + (source.mappable ? "" : " · presence only")));
    port.append(copy, el("span", "port-dot"));
    port.addEventListener("pointerdown", event => {
      if (!source.mappable || event.button !== 0) return;
      dragging = source.path; pointerPosition = {x: event.clientX, y: event.clientY};
    });
    sources.append(port);
  }
  if (!workspace.schemas.length) {
    const empty = el("div", "empty-hint"); empty.append(el("p", "", "Your VMF schema library is empty."), el("p", "", "CoT reception works without schemas. Add your payload definitions to start connecting fields."), button("Author a schema →", () => tab("schemas"), "button secondary")); targets.append(empty);
  }
  for (const schema of workspace.schemas) {
    const catalog = catalogSchema(schema.id);
    targets.append(el("div", "source-group", schema.id + " / " + (schema.document.envelope || "—")));
    if (!catalog?.valid) { targets.append(el("p", "schema-invalid", catalog?.diagnostic || "Complete this schema in Payload schemas to expose its fields.")); continue; }
    for (const msg of catalog.messages || []) {
      const box = el("section", "message-group"), heading = el("div", "message-heading"), output = outputFor(schema.id, msg);
      const title = button("", () => inspectMessage(schema.id, msg), "message-info");
      title.append(el("strong", "", msg.message_number || msg.label), el("small", "", msg.label || "Exact native message identity"));
      const enable = el("label", "message-enable"), toggle = el("input"); toggle.type = "checkbox"; toggle.checked = !!output?.enabled; toggle.setAttribute("aria-label", "Enable " + schema.id + " " + msg.message_number);
      toggle.addEventListener("change", () => { ensureOutput(schema.id, msg).enabled = toggle.checked; changed(); renderOutputs(); }); enable.append(toggle, "Send"); heading.append(title, enable); box.append(heading);
      for (const field of msg.fields || []) {
        const port = button("", () => {
          if (armedSource && field.mappable) connect(armedSource, schema.id, msg, field);
          else inspectMessage(schema.id, msg);
        }, "target-port");
        port.dataset.schemaId = schema.id; port.dataset.messageOrdinal = msg.ordinal; port.dataset.targetIndex = field.index;
        port.dataset.mappable = field.mappable ? "true" : "false";
        const copy = el("span", "port-copy"); copy.append(el("span", "field-path", field.index + (field.key ? "  " + field.key : "")), el("span", "field-meta", field.bits + " bits · " + field.kind + (field.mappable ? "" : " · structural") + (field.repeats?.length ? " · repeated" : "")));
        port.append(el("span", "port-dot"), copy);
        port.addEventListener("pointerup", event => {
          if (dragging && field.mappable) { const source = dragging; dragging = null; pointerPosition = null; event.preventDefault(); connect(source, schema.id, msg, field); }
        });
        box.append(port);
      }
      const tools = el("div", "output-tools"); tools.append(button("Header & controls", () => inspectMessage(schema.id, msg), "text-button")); box.append(tools); targets.append(box);
    }
  }
  renderFeedback(); scheduleWires();
}
function scheduleWires() { if (!wireFrame) wireFrame = requestAnimationFrame(() => { wireFrame = null; drawWires(); }); }
function drawWires() {
  const canvas = $("mapping-canvas"), svg = $("wires"), rect = canvas.getBoundingClientRect(); svg.replaceChildren();
  svg.setAttribute("width", canvas.scrollWidth); svg.setAttribute("height", canvas.scrollHeight);
  const endpoint = node => { const dot = node?.querySelector(".port-dot")?.getBoundingClientRect(); return dot ? {x: dot.x + dot.width / 2 - rect.x, y: dot.y + dot.height / 2 - rect.y} : null; };
  const visible = node => {
    const bounds = node?.parentElement?.closest("#source-fields, #target-fields")?.getBoundingClientRect();
    const item = node?.getBoundingClientRect();
    return bounds && item && item.bottom > bounds.top && item.top < bounds.bottom;
  };
  function path(a, b, className) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", "path"), reach = Math.max(45, (b.x - a.x) * .5);
    node.setAttribute("d", `M ${a.x},${a.y} C ${a.x + reach},${a.y} ${b.x - reach},${b.y} ${b.x},${b.y}`); node.setAttribute("class", className); svg.append(node); return node;
  }
  for (const wire of wireRecords()) {
    const source = [...document.querySelectorAll(".source-port")].find(node => node.dataset.sourcePath === wire.binding.cot);
    const target = [...document.querySelectorAll(".target-port")].find(node => node.dataset.schemaId === wire.schema && node.dataset.messageOrdinal === String(wire.message.ordinal) && node.dataset.targetIndex === wire.field.index);
    const a = endpoint(source), b = endpoint(target);
    if (!a || !b) continue;
    const live = source.classList.contains("live");
    const node = path(a, b, "wire" + (selectedWire === wire.id ? " selected" : "") + (live ? " live" : "") + (wireHasDiagnostic(wire) ? " diagnostic-wire" : "")); node.dataset.wireId = wire.id;
    node.setAttribute("visibility", visible(source) && visible(target) ? "visible" : "hidden");
    node.setAttribute("role", "button"); node.setAttribute("tabindex", "0"); node.setAttribute("aria-label", wire.binding.cot + " to " + wire.field.index);
    const select = () => { selectedWire = wire.id; selectedOutput = null; renderOutputs(); renderMappingEditor(); scheduleWires(); };
    node.addEventListener("click", select); node.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(); } });
    if (live) target.classList.add("live");
  }
  if (dragging && pointerPosition) {
    const source = [...document.querySelectorAll(".source-port")].find(node => node.dataset.sourcePath === dragging), a = endpoint(source);
    if (a) path(a, {x: pointerPosition.x - rect.x, y: pointerPosition.y - rect.y}, "drag-wire");
  }
}
function removeSelectedConnection() {
  const wire = wireRecords().find(item => item.id === selectedWire);
  if (!wire) return false;
  wire.output.mapping.fields.splice(wire.index, 1);
  selectedWire = null;
  changed(); renderMapping(); renderMappingEditor();
  return true;
}
function renderMappingEditor() {
  const target = $("mapping-editor"); target.replaceChildren();
  const wire = wireRecords().find(item => item.id === selectedWire);
  if (wire) {
    $("mapping-inspector-title").textContent = "Connection properties";
    target.append(el("div", "selected-target", wire.binding.cot + " → " + wire.field.index), editor(wire.binding, bindingSpec, next => { wire.output.mapping.fields[wire.index] = next; }, "", "wire/" + wire.id), button("Remove connection", removeSelectedConnection, "button wide-button danger"));
    return;
  }
  const output = workspace.outputs.find(item => item.id === selectedOutput);
  if (output) {
    $("mapping-inspector-title").textContent = "Message output";
    const envelope = schemaById(output.mapping?.schema)?.document.envelope || "C";
    const spec = object({format: enumeration("cot-vmf-mapping-config/1"), name: text, schema: text, vmf_header: headerSpec(envelope), fields: array(bindingSpec), vmf_constants: array(constantSpec), presence: array(object({group: integer, occurrences: array(occurrenceSpec), present: boolean}, ["group", "present"])), repeat_counts: array(object({repeat: integer, occurrences: array(occurrenceSpec), count: integer}, ["repeat", "count"]))});
    target.append(el("p", "property-help", "Headers select the exact message identity. Constants use raw VMF values. Indicator presence and repeat counts remain explicit."), editor(output.mapping, spec, next => { output.mapping = next; }, "", "output/" + output.id), button("Remove output", () => { workspace.outputs.splice(workspace.outputs.indexOf(output), 1); selectedOutput = null; changed(); renderMapping(); renderMappingEditor(); }, "button wide-button danger"));
    return;
  }
  $("mapping-inspector-title").textContent = "Make a connection";
  target.append(el("p", "empty-hint", "Drag a CoT source port to a VMF field, or select the two ports. Select a wire for transformations and occurrence selectors. Select a message heading for headers, constants, and structural controls."));
}
function workspaceNeedsRepair() {
  return workspace.format !== "cot-vmf-workspace/1"
    || !Array.isArray(workspace.schemas) || !Array.isArray(workspace.outputs)
    || workspace.schemas.some(item => !isObject(item) || !isObject(item.document)
      || typeof item.id !== "string" || !item.id)
    || workspace.outputs.some(item => !isObject(item)
      || typeof item.id !== "string" || !item.id);
}
function renderEditors() {
  if (workspaceNeedsRepair() || !$("workspace-repair").hidden) { render(); return; }
  renderSchemaEditor(); renderMappingEditor(); scheduleWires();
}
function render(preserveFocus = false) {
  const focus = document.activeElement, repair = workspaceNeedsRepair();
  $("workspace-repair").hidden = !repair;
  const page = document.querySelector("[data-tab].selected")?.dataset.tab || "mapping";
  $("mapping-page").hidden = repair || page !== "mapping";
  $("schemas-page").hidden = repair || page !== "schemas";
  if (repair) {
    const target = $("workspace-editor");
    if (!preserveFocus || !target.contains(focus)) {
      target.replaceChildren(editor(workspace, workspaceSpec, next => { workspace = next; }, "", "workspace"));
    }
    return;
  }
  $("workspace-editor").replaceChildren();
  renderSchemas();
  if (!preserveFocus || !$("schema-editor").contains(focus)) renderSchemaEditor();
  renderMapping();
  if (!preserveFocus || !$("mapping-editor").contains(focus)) renderMappingEditor();
}
function tab(name) {
  document.querySelectorAll("[data-tab]").forEach(node => node.classList.toggle("selected", node.dataset.tab === name));
  $("mapping-page").hidden = workspaceNeedsRepair() || name !== "mapping"; $("schemas-page").hidden = workspaceNeedsRepair() || name !== "schemas";
  $("page-title").textContent = name === "mapping" ? "Connect the fields." : "Define your payloads.";
  $("page-description").textContent = name === "mapping" ? "Connect the data your message needs. Saved edits are tested with incoming CoT." : "Build native VMF definitions. Your schemas provide every payload field.";
  scheduleWires();
}
function download(name, value) {
  const url = URL.createObjectURL(new Blob([json(value, true) + "\n"], {type: "application/json"})), link = el("a");
  link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function activity(event) {
  const data = parseJSON(event.data);
  if (latestActivity && data.sequence < latestActivity.sequence) return;
  rememberActivity(data); renderFeedback();
  if (data.received !== undefined) $("activity-note").textContent = data.received ? "Received CoT · event " + data.received : "Waiting for CoT from TAK Gateway";
  // A draft may differ from active; presence still lights every attached wire.
  activeFields = new Set((data.fields || []).map(Number));
  document.querySelectorAll(".source-port").forEach(node => node.classList.toggle("live", activeFields.has(Number(node.dataset.sourceId))));
  document.querySelectorAll(".target-port").forEach(node => node.classList.remove("live"));
  scheduleWires(); clearTimeout(liveTimer);
  liveTimer = setTimeout(() => {
    activeFields.clear(); document.querySelectorAll(".live").forEach(node => node.classList.remove("live"));
  }, 1600);
}

document.querySelectorAll("[data-tab]").forEach(node => node.addEventListener("click", () => tab(node.dataset.tab)));
$("source-search").addEventListener("input", renderMapping);
$("mapping-scroll").addEventListener("scroll", scheduleWires);
$("source-fields").addEventListener("scroll", scheduleWires);
$("target-fields").addEventListener("scroll", scheduleWires);
window.addEventListener("resize", scheduleWires);
document.addEventListener("pointermove", event => { if (dragging) { pointerPosition = {x: event.clientX, y: event.clientY}; scheduleWires(); } });
document.addEventListener("pointerup", () => { dragging = null; pointerPosition = null; scheduleWires(); });
document.addEventListener("keydown", event => { if (event.key === "Escape") { armedSource = dragging = null; pointerPosition = null; renderMapping(); } });
document.addEventListener("keydown", event => {
  if (event.key !== "Delete" || event.defaultPrevented || event.isComposing
      || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey
      || $("mapping-page").hidden
      || event.target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])")) return;
  if (removeSelectedConnection()) event.preventDefault();
});
$("add-schema").addEventListener("click", () => {
  const schema = {id: uid("schema"), document: {format: "vmf-schema/1", envelope: "C", messages: []}};
  workspace.schemas.push(schema); selectedSchema = schema.id; selectedMessage = selectedIndex = null; changed(); render();
});
$("add-message").addEventListener("click", () => {
  const definition = selectedDefinition(); if (!definition) return;
  (definition.messages ||= []).push({message_number: "", indexes: []}); selectedMessage = definition.messages.length - 1; selectedIndex = null; changed(); renderSchemas(); renderSchemaEditor();
});
$("add-index").addEventListener("click", () => {
  const msg = selectedDefinition()?.messages?.[selectedMessage]; if (!msg) return;
  (msg.indexes ||= []).push({index_number: String(msg.indexes.length + 1) + ".", number_of_bits: 1}); selectedIndex = msg.indexes.length - 1; changed(); renderSchemas(); renderSchemaEditor();
});
$("import-schema").addEventListener("change", async event => {
  const file = event.target.files[0]; if (!file) return;
  try {
    if (file.size > 16 * 1024 * 1024) throw new Error("Schema exceeds 16 MiB.");
    const document = parseJSON(await file.text());
    if (document.format !== "vmf-schema/1" || !Array.isArray(document.messages)) throw new Error("Choose a native vmf-schema/1 definition.");
    let id = file.name.replace(/\.json$/i, ""); if (!id) id = uid("schema");
    if (schemaById(id)) id += "-" + Date.now();
    workspace.schemas.push({id, document}); selectedSchema = id; selectedMessage = selectedIndex = null; changed(); render(); message("Schema imported. Native validation runs when the draft is saved.");
  } catch (error) { message(error.message, true); }
  event.target.value = "";
});
$("export-schema").addEventListener("click", () => { const schema = schemaById(selectedSchema); if (schema) download(schema.id + ".json", schema.document); });
$("delete-schema").addEventListener("click", () => {
  if (!selectedSchema) return;
  workspace.outputs = workspace.outputs.filter(item => item.mapping?.schema !== selectedSchema);
  workspace.schemas = workspace.schemas.filter(item => item.id !== selectedSchema);
  selectedSchema = selectedMessage = selectedIndex = selectedWire = selectedOutput = null;
  changed(); render();
});
$("reload").addEventListener("click", async () => {
  if (saving) return;
  try { clearTimeout(saveTimer); state = await request("/api/state"); workspace = state.draft; generation = savedGeneration = 0; selectedWire = selectedOutput = null; message(""); status(); render(); } catch (error) { message(error.message, true); }
});
(async () => {
  try {
    state = await request("/api/state"); workspace = state.draft; status(); render();
    const stream = new EventSource("/api/events");
    stream.addEventListener("open", () => {
      $("connection-status").textContent = "Service connected";
      $("connection-light").classList.add("connected");
      // Every connection starts with a fresh snapshot. A restarted service
      // can have a lower sequence than the process we previously observed.
      latestActivity = null;
      renderFeedback();
    });
    stream.addEventListener("activity", activity);
    stream.addEventListener("error", () => { $("connection-status").textContent = "Reconnecting…"; $("connection-light").classList.remove("connected"); });
  } catch (error) { $("save-status").textContent = "Connection failed"; message(error.message, true); }
})();
