"use strict";

// Native integer tokens remain exact through authoring, import and export.
function parseJSON(source) {
  let at = 0;
  const white = () => { while (/\s/.test(source[at] || "") && at < source.length) at++; };
  function value(depth = 0) {
    if (depth > 256) throw new Error("Document nesting exceeds 256 levels.");
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
// Contextual help lives outside scrolling panels and never starts a mapping.
let openHelp = null;
let helpTooltip = null;
let helpHideTimer;
let helpTooltipHovered = false;
const dismissedHelp = new WeakSet();

function dismissHelp(dismissed = false) {
  clearTimeout(helpHideTimer);
  if (!openHelp) return;
  const trigger = openHelp.trigger;
  if (dismissed) dismissedHelp.add(trigger);
  const descriptions = (trigger.getAttribute("aria-describedby") || "")
    .split(/\s+/).filter(id => id && id !== helpTooltip.id);
  if (descriptions.length) trigger.setAttribute("aria-describedby", descriptions.join(" "));
  else trigger.removeAttribute("aria-describedby");
  helpTooltip.hidden = true;
  helpTooltipHovered = false;
  openHelp = null;
}

function positionHelp() {
  if (!openHelp) return;
  const trigger = openHelp.trigger;
  if (!trigger.isConnected || trigger.closest("[hidden]")) { dismissHelp(); return; }
  const anchor = trigger.getBoundingClientRect();
  const width = document.documentElement.clientWidth;
  const height = document.documentElement.clientHeight;
  if (!anchor.width || !anchor.height || anchor.bottom < 0 || anchor.top > height) {
    dismissHelp(); return;
  }
  for (let parent = trigger.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    if (!/(auto|scroll|hidden|clip)/.test(style.overflow + style.overflowY + style.overflowX)) continue;
    const bounds = parent.getBoundingClientRect();
    if (anchor.bottom <= bounds.top || anchor.top >= bounds.bottom
        || anchor.right <= bounds.left || anchor.left >= bounds.right) {
      dismissHelp(); return;
    }
  }
  helpTooltip.style.left = "8px";
  helpTooltip.style.top = "8px";
  const box = helpTooltip.getBoundingClientRect();
  const left = Math.max(8, Math.min(anchor.left, width - box.width - 8));
  let top = anchor.bottom + 8;
  if (top + box.height > height - 8) top = anchor.top - box.height - 8;
  helpTooltip.style.left = left + "px";
  helpTooltip.style.top = Math.max(8, Math.min(top, height - box.height - 8)) + "px";
}

function scheduleHelpDismiss() {
  clearTimeout(helpHideTimer);
  helpHideTimer = setTimeout(() => {
    if (openHelp && !openHelp.pinned && !helpTooltipHovered
        && document.activeElement !== openHelp.trigger) dismissHelp();
  }, 120);
}

function ensureHelpTooltip() {
  if (helpTooltip) return;
  helpTooltip = document.createElement("div");
  helpTooltip.id = "context-help-tooltip";
  helpTooltip.className = "help-tooltip";
  helpTooltip.setAttribute("role", "tooltip");
  helpTooltip.hidden = true;
  document.body.append(helpTooltip);
  helpTooltip.addEventListener("pointerenter", () => {
    helpTooltipHovered = true; clearTimeout(helpHideTimer);
  });
  helpTooltip.addEventListener("pointerleave", () => {
    helpTooltipHovered = false; scheduleHelpDismiss();
  });
  for (const type of ["pointerdown", "click"])
    helpTooltip.addEventListener(type, event => event.stopPropagation());
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") dismissHelp(true);
  });
  document.addEventListener("pointerdown", event => {
    if (openHelp && !openHelp.trigger.contains(event.target)
        && !helpTooltip.contains(event.target)) dismissHelp();
  }, true);
  document.addEventListener("scroll", positionHelp, true);
  window.addEventListener("resize", positionHelp);
  new MutationObserver(() => {
    if (openHelp && (!openHelp.trigger.isConnected
        || openHelp.trigger.closest("[hidden]"))) dismissHelp();
  }).observe(document.body, {childList: true, subtree: true,
    attributes: true, attributeFilter: ["hidden"]});
}

function showHelp(trigger, description, pinned = false) {
  ensureHelpTooltip();
  clearTimeout(helpHideTimer);
  if (openHelp?.trigger !== trigger) dismissHelp();
  openHelp = {trigger, pinned};
  helpTooltip.textContent = description;
  helpTooltip.hidden = false;
  const descriptions = new Set((trigger.getAttribute("aria-describedby") || "")
    .split(/\s+/).filter(Boolean));
  descriptions.add(helpTooltip.id);
  trigger.setAttribute("aria-describedby", [...descriptions].join(" "));
  positionHelp();
}

function helpButton(label, description) {
  ensureHelpTooltip();
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "help-button";
  trigger.textContent = "?";
  trigger.setAttribute("aria-label", "Help for " + label);
  const reveal = () => {
    dismissedHelp.delete(trigger);
    showHelp(trigger, description, openHelp?.trigger === trigger && openHelp.pinned);
  };
  trigger.addEventListener("pointerenter", reveal);
  trigger.addEventListener("focus", () => {
    if (!dismissedHelp.has(trigger)) reveal();
  });
  trigger.addEventListener("pointerleave", () => {
    dismissedHelp.delete(trigger);
    scheduleHelpDismiss();
  });
  trigger.addEventListener("blur", () => {
    dismissedHelp.delete(trigger);
    if (openHelp?.trigger === trigger) openHelp.pinned = false;
    scheduleHelpDismiss();
  });
  for (const type of ["pointerdown"])
    trigger.addEventListener(type, event => event.stopPropagation());
  trigger.addEventListener("click", event => {
    event.preventDefault(); event.stopPropagation();
    if (openHelp?.trigger === trigger && openHelp.pinned) dismissHelp(true);
    else { dismissedHelp.delete(trigger); showHelp(trigger, description, true); }
  });
  return trigger;
}

const cotFieldHelp = {
  type: "The CoT type code describes the kind of object or event, including its affiliation when represented by the code.",
  access: "The event's optional access-control label. Empty access and the CoT value Undefined are treated as unavailable.",
  qos: "The event's optional quality-of-service code. Its original text is available for a value-table mapping when present.",
  opex: "The event's optional operation or exercise code. Its original text is available for a value-table mapping when present.",
  uid: "The unique identifier of the object or event represented by this CoT message.",
  send_time_ms: "The event's send time, represented as UTC milliseconds since the Unix epoch. This is the XML time attribute.",
  start_time_ms: "The start of the event's validity interval, represented as UTC milliseconds since the Unix epoch. This is the XML start attribute.",
  stale_time_ms: "The time after which the event is stale, represented as UTC milliseconds since the Unix epoch. This is the XML stale attribute.",
  how: "The CoT code describing how the event information was obtained or determined.",
  "point.latitude": "The object's latitude in WGS84 degrees, positive north and negative south.",
  "point.longitude": "The object's longitude in WGS84 degrees, positive east and negative west.",
  "point.hae": "The object's height above the WGS84 ellipsoid in metres. The native CoT unknown-height value is 999999 metres.",
  "point.ce": "Circular horizontal position error in metres. The native CoT unknown-error value is 999999 metres.",
  "point.le": "Linear vertical position error in metres. The native CoT unknown-error value is 999999 metres.",
  caveat: "The event's optional caveat marking, preserved as text for any explicit mapping you define.",
  releasable_to: "The event's optional releasability marking. This is the XML releasableTo attribute, preserved as text.",
  "detail.contact.endpoint": "The contact's primary endpoint address, when supplied by the sender.",
  "detail.contact.callsign": "The contact's human-readable callsign or display name.",
  "detail.contact.altendpoints": "The contact's optional alternate endpoint addresses, preserved as one text value.",
  "detail.group.name": "The contact's group or team name. This is the name attribute of the XML __group element.",
  "detail.group.role": "The contact's role within its group or team. This is the role attribute of the XML __group element.",
  "detail.precision_location.geopointsrc": "The sender's code for the source of the horizontal position, such as the positioning source used by the device.",
  "detail.precision_location.altsrc": "The sender's code for the source of the altitude measurement.",
  "detail.status.battery": "The device's reported battery percentage. The full native unsigned 32-bit value is preserved.",
  "detail.takv.device": "The device name or model reported by the TAK client.",
  "detail.takv.platform": "The TAK platform or client application name reported by the sender.",
  "detail.takv.os": "The operating system reported by the TAK client.",
  "detail.takv.version": "The application version reported by the TAK client.",
  "detail.track.speed": "The object's reported speed in metres per second.",
  "detail.track.course": "The object's reported course in degrees clockwise from true north.",
  "detail.xml": "Residual XML detail content that is not represented by the standard typed fields. Its presence can be observed, but it cannot be connected directly to a VMF field.",
  "detail.extensions": "Opaque registered extension entries retained by the native CoT decoder. Their presence can be observed, but they cannot be connected directly to a VMF field.",
};

const schemaPropertyHelp = {
  format: "The payload document identifier: vmf-schema/1.",
  envelope: "An optional default envelope. Each output chooses its own envelope; named payload editions retain their meaning.",
  message_standard: "The named edition of the specification you are transcribing. A message may replace this schema-level choice.",
  standard_version: "An explicit raw standard-version code, or absent where allowed. Named editions are usually easier to use across envelopes.",
  message_number: "The VMF K-series message number, such as K01.1, printed in your specification.",
  messages: "The message definitions in this schema. Add fields and groups in their specified wire order.",
  subtype: "An optional exact message subtype. Present zero and absence identify different messages.",
  elements: "An ordered list of fields, groups, and optional or repeating structures. Nesting generates the control fields and membership automatically.",
  number_of_bits: "The exact wire width or finite variable-field capacity, in bits. Boolean fields imply one bit.",
  key: "A required field name, unique within its message. Dependencies and mappings use this name. Renaming in this editor updates those references together.",
  type: "The wire data type. Signed types explicitly choose their bit representation. Scale is inferred from its metadata.",
  bit_order: "The logical significance of bits within the field, independent of physical octet packing.",
  octet_order: "The physical octet packing order for this message. It does not insert alignment padding.",
  text_encoding: "The wire text encoding. Capacities must contain whole seven- or eight-bit wire units. UTF-8 units are bytes.",
  length_from: "Choose an available earlier unsigned scalar field by key. Its value supplies this field's length in wire units.",
  length_bias: "A checked signed adjustment to the selected length field's value.",
  when: "A condition comparing raw codes from available earlier scalar fields. It controls this field without adding a presence bit.",
  all: "Every condition term must match.",
  any: "At least one condition term must match.",
  negate: "Invert the condition or term's result.",
  field: "Choose the available earlier scalar field whose raw code this term tests.",
  values: "Inclusive raw-code intervals that satisfy this condition term.",
  mask: "An optional raw-bit mask applied before comparison. Omitting it uses every raw bit.",
  allowed: "Disjoint inclusive intervals of permitted raw wire codes, including for signed and scaled fields.",
  first: "The first included raw code.",
  last: "The last included raw code.",
  constant: "A required raw scalar code. The output still needs to supply that value.",
  scale: "Exact factor and bias for physical_value = raw_code × factor + bias. Adding this metadata implies scaled encoding.",
  factor: "The exact rational multiplier for this field's scale.",
  bias: "The exact scale offset, or the checked signed adjustment to a scalar repeat count.",
  numerator: "The signed numerator of this exact rational value.",
  denominator: "The nonzero unsigned denominator of this exact rational value.",
  sentinels: "Raw codes reserved as scale sentinel values.",
  count: "The explicit fixed number of occurrences, including zero.",
  count_from: "Choose the available earlier unsigned scalar field supplying the occurrence count. Its input value remains explicit.",
  maximum: "The finite maximum permitted occurrence count from your specification.",
  minimum: "The minimum permitted scalar-controlled occurrence count.",
};

const mappingPropertyHelp = {
  format: "The native mapping format identifier. Outputs use cot-vmf-mapping-config/1.",
  name: "An optional human-readable name for this output mapping.",
  schema: "The workspace schema ID containing this output's message definition. It is not a filesystem path.",
  message: "The zero-based ordinal of the selected message in the schema document. Message 0 is the first definition.",
  envelope: "The envelope explicitly selected for this output. Its header identity is derived from the selected payload definition.",
  cot: "The canonical CoT source path. Only standard individually mappable catalog fields can supply a connection.",
  vmf: "The target VMF field, selected by its unique key within this output's exact message.",
  key: "The unique application key of the target field. Select either key or index for a target reference.",
  index: "The target's numeric field address, such as 3.1, or the zero-based occurrence index inside an occurrence selector.",
  factor: "Numeric conversion uses cot_value = physical_vmf × factor + offset. The default factor is 1; encoding inverts the conversion.",
  offset: "Numeric conversion uses cot_value = physical_vmf × factor + offset. The default offset is 0.",
  values: "An explicit table from logical CoT values to raw unsigned VMF codes. Unmatched numeric sources use numeric conversion; unmatched text fails.",
  encoding: "Binary values supplied as text require hexadecimal encoding. The schema still determines their wire width and length.",
  bit_count: "An explicit significant bit count for a binary bit value. Unused high bits must be zero.",
  occurrences: "Select every enclosing repeat occurrence, outermost first. Occurrence indices are zero-based.",
  repeat: "The enclosing repeat ID identified by this occurrence selector or repeat-count assertion.",
  value: "An explicit VMF constant. Signed fields take logical signed integers; unsigned, enum and scaled fields take raw unsigned codes.",
  fields: "Connections from canonical CoT fields to VMF target occurrences. Each target occurrence has one writer.",
  vmf_constants: "Explicit values supplied directly to VMF fields. A constant and a connection cannot write the same target occurrence.",
  presence: "Explicit presence assertions for GPI-controlled groups. Without an assertion, the native encoder may infer presence from supplied descendants.",
  group: "The GPI-controlled group ID whose presence is being asserted.",
  present: "Whether the selected GPI-controlled group is present in the encoded message.",
  repeat_counts: "Explicit counts for FRI/GRI-controlled repeats. Fixed and preceding-scalar repeats remain governed by their schema.",
  count: "The explicitly asserted number of occurrences of an FRI/GRI-controlled repeat.",
  vmf_header: "Optional envelope metadata. Omitted values use native defaults; message identity comes from the selected schema, ordinal, and envelope and must not be supplied here.",
  id: "The exact native VMF message identity. This must match a message in the selected schema.",
  user_message_format: "The native user-message-format code. Payload schema definitions in this application select VMF format 2.",
  standard_version: "The exact raw standard-version code in the message identity. Present zero differs from an absent version.",
  identification: "The functional area, message number and optional subtype identifying this VMF message.",
  functional_area: "The functional-area number in the exact VMF message identity.",
  message_number: "The message number within its functional area. It must match the selected schema identity.",
  subtype: "The optional exact message subtype. Present zero differs from an absent subtype.",
  shortened: "Select the profile's shortened-header form. Native header rules determine its required and permitted fields.",
  compression: "The native header compression code. Message compression is unsupported by this translator.",
  originator: "The originating address. Supply exactly one native URN or name for a present address.",
  recipients: "The recipient addresses carried by the VMF header.",
  information_addressees: "Additional information addressees carried by the VMF header.",
  urn: "The numeric native address identifier. A present address uses either URN or name.",
  file_name: "The optional native message filename, subject to the identity-specific header rules.",
  header_size_octets: "The header-size field in octets. Complete-PDU authoring derives encoded lengths.",
  message_size_octets: "The message-size field in octets. Complete-PDU authoring derives encoded lengths.",
  operation: "The native message operation code.",
  retransmit: "Whether the native header marks this message as a retransmission.",
  precedence: "The native message precedence code; defaults depend on the envelope profile.",
  classification: "The native message classification code.",
  originator_dtg: "The message's originator date-time group.",
  perishability: "The message's native perishability date-time group.",
  acknowledgment: "The requested acknowledgment flags. Acknowledgment requests cannot coexist with response-only metadata.",
  machine: "Request a machine acknowledgment.",
  operator_ack: "Request an operator acknowledgment.",
  operator_reply: "Request an operator reply.",
  response: "Response-only metadata, including its required receipt-compliance code.",
  acknowledged: "The date-time group of the message being acknowledged.",
  receipt_compliance: "The required native receipt-compliance response code.",
  cantco_reason: "The native reason code for inability to comply, when applicable to the response.",
  cantpro_reason: "The native reason code for inability to process, when applicable to the response.",
  amplification: "Optional response amplification text.",
  references: "References to other messages, each identifying its originator and date-time group.",
  dtg: "The native date-time group associated with this reference.",
  year: "The year component of this native date-time group.",
  month: "The month component of this native date-time group.",
  day: "The day component of this native date-time group.",
  hour: "The hour component of this native date-time group.",
  minute: "The minute component of this native date-time group.",
  second: "The second component of this native date-time group.",
  extension: "The optional native date-time extension code.",
  marking_b: "The security marking field available with envelope B.",
  marking_c: "The security marking text available with envelope C.",
  markings: "The security marking codes available with envelopes D and D1.",
};

function propertyHelp(key, path = "") {
  if (path.startsWith("schema/")
      || /^workspace\/schemas\/\d+\/document(?:\/|$)/.test(path)) return schemaPropertyHelp[key];
  if (path === "workspace") return {
    format: "The workspace format identifier: cot-vmf-workspace/1.",
    schemas: "The workspace's library of user-supplied native payload definitions.",
    outputs: "The independently enabled output mappings stored in this workspace.",
  }[key];
  if (/^workspace\/schemas\/\d+$/.test(path)) return {
    id: "The unique workspace schema ID used by output mappings.",
    document: "The native vmf-schema/1 payload definition for this schema.",
  }[key];
  if (/^workspace\/outputs\/\d+$/.test(path)) return {
    id: "The unique workspace identifier of this output.",
    enabled: "Attempt this output for incoming CoT events when enabled.",
    mapping: "The output's schema, message ordinal, chosen envelope, and field mappings.",
  }[key];
  if (path.startsWith("workspace/")
      && !/^workspace\/outputs\/\d+\/mapping(?:\/|$)/.test(path)) return undefined;
  if (key === "fields" && path.includes("vmf_header"))
    return "Optional native envelope metadata, including addresses. The message identity is derived and cannot be edited here.";
  if (key === "messages" && path.includes("vmf_header"))
    return "Optional metadata for one body descriptor. Its identity is generated from the selected message and envelope.";
  if (key === "name" && /\/(originator|recipients|information_addressees)(\/|$)/.test(path))
    return "The text form of a native address. A present address uses either name or URN.";
  if (key === "index" && path.includes("occurrences"))
    return "The zero-based occurrence index within the selected enclosing repeat.";
  if (key === "vmf" && path.includes("values"))
    return "The raw unsigned VMF code supplied when this table entry's CoT value matches.";
  if (key === "cot" && path.includes("values"))
    return "The logical CoT scalar matched by this value-table entry. Each source value must be unique in the table.";
  return mappingPropertyHelp[key];
}

function attachStaticHelp() {
  const items = [
    [".source-column .column-title h2", "CoT sources", "Canonical CoT fields appear here. Connect only the data your VMF message needs. A dashed pending wire follows the pointer until you choose a target or press Escape."],
    [".target-column .column-title h2", "VMF payloads", "Targets come from your valid native schema definitions. Structural indicators are controlled by presence and repeat settings rather than ordinary connections."],
    [".outputs-panel h2", "Outputs", "Each enabled output is attempted for every incoming CoT event. Turning Send off retains its mapping without attempting transmission."],
    [".test-results h2", "Last test result", "The most recent attempt for each output. When the edited draft is invalid, results describe the previous active configuration; the revision shown identifies the tested version."],
    [".session-totals summary", "Session totals", "Cumulative service counters include earlier authoring attempts. Use an output's last test result to assess its current mapping."],
    ["#schema-inspector-title", "Payload authoring", "Choose the fields that determine validity first, then complete the applicable settings in later steps. Back revisits earlier choices; Undo restores the previous payload edit."],
  ];
  for (const [selector, label, description] of items) {
    const target = document.querySelector(selector);
    if (!target) continue;
    const sibling = target.id === "schema-inspector-title";
    const existing = sibling
      ? [...target.parentElement.children].some(child => child.dataset.staticHelp === label)
      : target.querySelector(".help-button");
    if (existing) continue;
    const help = helpButton(label, description);
    help.dataset.staticHelp = label;
    if (sibling) target.after(help);
    else target.append(help);
  }
}

const text = {kind: "text"}, integer = {kind: "integer"}, number = {kind: "number"}, boolean = {kind: "boolean"}, scalar = {kind: "scalar"};
const enumeration = (...values) => ({kind: "enum", values});
const object = (properties, required = []) => ({kind: "object", properties, required});
const array = item => ({kind: "array", item});
const order = enumeration("default", "lsb_first", "msb_first");
const standards = enumeration("MIL-STD-6017", "MIL-STD-6017A", "MIL-STD-6017B", "MIL-STD-6017C", "MIL-STD-6017D", "MIL-STD-6017E", "TIDP-TE-R2", "TIDP-TE-R3", "TIDP-TE-R4", "TIDP-TE-R5", "TIDP-TE-R6", "TIDP-TE-R7", "TIDP-FTE-R6");
const rangeSpec = object({first: integer, last: integer}, ["first", "last"]);
const rationalSpec = object({numerator: integer, denominator: {...integer, initial: 1}}, ["numerator", "denominator"]);
const termSpec = object({field: text, values: array(rangeSpec), mask: integer, negate: boolean}, ["field", "values"]);
const conditionSpec = object({all: array(termSpec), any: array(termSpec), negate: boolean});
const fieldSpec = object({key: text, number_of_bits: {...integer, initial: 1}, type: enumeration("unsigned", "bool", "enum", "twos_complement", "ones_complement", "sign_magnitude", "bits", "octets", "text", "literal"), bit_order: order, text_encoding: enumeration("default", "ascii_7", "ascii_8", "latin_1", "utf_8"), length_from: text, length_bias: integer, when: conditionSpec, allowed: array(rangeSpec), constant: integer, scale: object({factor: rationalSpec, bias: rationalSpec, sentinels: array(integer)}, ["factor", "bias"])}, ["key"]);
const nodeSpec = {kind: "node"};
const nativeMessageSpec = object({message_number: text, elements: array(nodeSpec), message_standard: standards, standard_version: scalar, subtype: integer, octet_order: order}, ["message_number", "elements"]);
const schemaSpec = object({format: {kind: "enum", values: ["vmf-schema/1"]}, envelope: enumeration("B", "C", "D", "D1"), message_standard: standards, standard_version: scalar, messages: array(nativeMessageSpec)}, ["format", "messages"]);
const occurrenceSpec = object({repeat: integer, index: integer}, ["repeat", "index"]);
const targetSpec = object({key: text}, ["key"]);
const bindingSpec = object({cot: text, vmf: targetSpec, factor: {...number, initial: 1}, offset: number, values: array(object({cot: scalar, vmf: integer}, ["cot", "vmf"])), encoding: enumeration("hex"), bit_count: integer, occurrences: array(occurrenceSpec)}, ["cot", "vmf"]);
const constantSpec = object({vmf: targetSpec, value: scalar, encoding: enumeration("hex"), bit_count: integer, occurrences: array(occurrenceSpec)}, ["vmf", "value"]);
const addressSpec = object({urn: integer, name: text});
const workspaceSpec = object({format: enumeration("cot-vmf-workspace/1"), schemas: array(object({id: text, document: schemaSpec}, ["id", "document"])), outputs: array(object({id: text, enabled: boolean, mapping: object({})}, ["id", "enabled", "mapping"]))}, ["format", "schemas", "outputs"]);
const dtgSpec = object({year: integer, month: {...integer, initial: 1}, day: {...integer, initial: 1}, hour: integer, minute: integer, second: integer, extension: integer}, ["year", "month", "day", "hour", "minute", "second"]);
function headerSpec(profile) {
  const reference = object({originator: addressSpec, dtg: dtgSpec, ...(profile === "B" ? {functional_area: integer, message_number: integer} : {})}, ["originator", "dtg"]);
  const props = {file_name: text, message_size_octets: integer, operation: integer, retransmit: boolean, precedence: integer, classification: integer, originator_dtg: dtgSpec, perishability: dtgSpec, acknowledgment: object({machine: boolean, operator_ack: boolean, operator_reply: boolean}), response: object({acknowledged: dtgSpec, receipt_compliance: integer, cantco_reason: integer, cantpro_reason: integer, amplification: text}, ["receipt_compliance"]), references: array(reference)};
  if (!envelopeProfiles.includes(profile) || profile === "B") props.marking_b = integer;
  if (!envelopeProfiles.includes(profile) || profile === "C") props.marking_c = text;
  if (!envelopeProfiles.includes(profile) || profile === "D" || profile === "D1") props.markings = array(integer);
  const fields = {compression: integer, originator: addressSpec, recipients: array(addressSpec), information_addressees: array(addressSpec), messages: {...array(object(props)), initial: [{}]}};
  if (profile !== "B") fields.header_size_octets = integer;
  return object({fields: object(fields), ...(profile === "B" ? {} : {shortened: boolean})});
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
let pendingMessage = null;
let importingMapping = false;
const envelopeProfiles = ["B", "C", "D", "D1"];
let armedSource = null, dragging = null, pointerPosition = null, activeFields = new Set(), liveTimer, wireFrame;
let pointerGesture = null, suppressPointerClick = false;
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
function connectionFailure(message) {
  const error = new Error(message);
  error.connectionFailure = true;
  return error;
}
async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {cache: "no-store", credentials: "same-origin", ...options});
  } catch {
    throw connectionFailure("Could not contact the translator service. Check that it is running and that this page is reachable.");
  }
  let text;
  try { text = await response.text(); }
  catch { throw connectionFailure("The connection to the translator ended before its response was received."); }
  const body = parseJSON(text);
  if (!response.ok) {
    const error = new Error(body.error || body.message || "Request failed (" + response.status + ").");
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}
function status() {
  $("import-mapping-button").disabled = importingMapping;
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
    } else $("save-status").textContent = error.connectionFailure ? "Save not confirmed" : "Edits not saved";
    const detail = error.message + (error.connectionFailure ? " Keep this tab open. Use Export schema to keep a copy before reloading." : "");
    message(error.status === 409 ? "The workspace changed in another window. Export your schema if needed, then reload before editing." : detail, true);
  } finally {
    saving = false;
    if (generation !== savedGeneration && generation !== version) save();
    renderFeedback();
  }
}

// A typed tree editor exposes native properties without a raw JSON escape hatch.
function editor(value, spec, set, label = "", path = "") {
  if (spec === nodeSpec) return editor(value, infer(value), set, label, path);
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
      if (spec.hidden?.includes(key)) continue;
      const row = el("div", "property"), name = el("div", "property-label");
      row.dataset.propertyName = key;
      name.append(el("code", "", key));
      const description = propertyHelp(key, path);
      if (description) name.append(helpButton(key, description));
      name.append(button("×", () => { delete value[key]; changed(); renderEditors(); }, "remove-property"));
      row.append(name);
      const childSpec = spec.properties[key] || infer(current);
      const nested = current !== null && typeof current === "object";
      const propertyPath = path + "/" + key;
      const control = editor(current, childSpec, next => { value[key] = next; set(value); if (spec.refreshOn?.includes(key)) setTimeout(() => { renderMapping(); renderMappingEditor(); }, 0); }, key, propertyPath);
      if (nested) {
        const details = el("details"); details.open = expandedProperties.has(propertyPath);
        details.addEventListener("toggle", () => { if (details.open) expandedProperties.add(propertyPath); else expandedProperties.delete(propertyPath); });
        details.append(el("summary", "", Array.isArray(current) ? current.length + " items" : "Edit " + key), control);
        row.append(details);
      } else row.append(control);
      node.append(row);
    }
    const missing = Object.keys(spec.properties).filter(key => !spec.hidden?.includes(key) && !Object.prototype.hasOwnProperty.call(value, key));
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

// Editor paths address the authored tree. Generated VMF addresses stay private.
function nodeKind(value) {
  if (Array.isArray(value)) return "group";
  if (!isObject(value)) return "invalid";
  for (const kind of ["optional", "recurrence", "repeat"]) if (guidedOwn(value, kind)) return kind;
  return "field";
}
function nodeBody(value) {
  const kind = nodeKind(value);
  return kind === "optional" ? value.optional : ["recurrence", "repeat"].includes(kind) ? value[kind]?.body : undefined;
}
function pathValue(owner, path) { return path.reduce((value, key) => value?.[key], owner); }
function setPath(owner, path, value) {
  const parent = pathValue(owner, path.slice(0, -1));
  if (parent !== null && typeof parent === "object") parent[path[path.length - 1]] = value;
}
function pathText(path) { return path.map(key => String(key).replace(/~/g, "~0").replace(/\//g, "~1")).join("/"); }
function selectedNode() { return selectedIndex === null ? undefined : pathValue(selectedDefinition()?.messages?.[selectedMessage], selectedIndex); }
function eachNode(message, visit) {
  function walk(node, path, depth) {
    if (depth > 128) return;
    visit(node, path);
    const kind = nodeKind(node);
    if (kind === "group") node.forEach((item, index) => walk(item, [...path, index], depth + 1));
    else if (kind === "optional") walk(node.optional, [...path, "optional"], depth + 1);
    else if (["repeat", "recurrence"].includes(kind) && isObject(node[kind])) walk(node[kind].body, [...path, kind, "body"], depth + 1);
  }
  if (Array.isArray(message?.elements)) message.elements.forEach((node, index) => walk(node, ["elements", index], 0));
}
function fieldNodes(message) {
  const result = [];
  eachNode(message, (node, path) => { if (nodeKind(node) === "field") result.push({node, path}); });
  return result;
}
function freshField(message) {
  const used = new Set(fieldNodes(message).map(item => item.node.key));
  let number = 1; while (used.has("field_" + number)) number++;
  return {key: "field_" + number, number_of_bits: 1};
}
function nodeTitle(node) {
  const kind = nodeKind(node);
  if (kind === "field") return node.key || "Unnamed field";
  if (kind === "group") return "Group · " + node.length + (node.length === 1 ? " element" : " elements");
  if (kind === "optional") return "Optional " + (nodeKind(node.optional) === "field" ? "field" : "group");
  if (kind === "recurrence") return "Recurring " + (nodeKind(nodeBody(node)) === "field" ? "field" : "group") + " · maximum " + String(node.recurrence?.maximum ?? "?");
  if (kind === "repeat") return guidedOwn(node.repeat || {}, "count") ? "Fixed repeat · " + String(node.repeat.count) + " times" : "Counted repeat · " + String(node.repeat?.count_from || "choose source");
  return "Repair element";
}
function renderSchemas() {
  const list = $("schema-list"); list.replaceChildren();
  if (!workspace.schemas.length) list.append(el("p", "empty-hint", "No payload definitions yet."));
  for (const schema of workspace.schemas) {
    const card = button("", () => { selectedSchema = schema.id; selectedMessage = selectedIndex = null; renderSchemas(); renderSchemaEditor(); }, "schema-card" + (selectedSchema === schema.id ? " selected" : ""));
    card.dataset.schemaId = schema.id;
    card.append(el("strong", "", schema.id), el("small", "", (schema.document.messages || []).length + " message types"));
    list.append(card);
  }
  const definition = selectedDefinition(), tree = $("schema-tree"); tree.replaceChildren();
  $("add-message").disabled = !definition;
  $("export-schema").disabled = $("delete-schema").disabled = !definition;
  for (const id of ["add-index", "add-group"]) $(id).disabled = !definition || selectedMessage === null;
  const container = nodeKind(selectedNode());
  $("add-index").textContent = selectedIndex !== null && ["group", "optional", "repeat", "recurrence"].includes(container) ? "+ Add field inside" : "+ Add field";
  $("add-group").textContent = selectedIndex !== null && ["group", "optional", "repeat", "recurrence"].includes(container) ? "+ Add group inside" : "+ Add group";
  if (!definition) { tree.append(el("p", "empty-hint", draftSchemas().length ? "Select a schema from the library to inspect its messages and fields." : "Create or import a schema to begin.")); return; }
  tree.append(button("Schema properties", () => { selectedMessage = selectedIndex = null; renderSchemas(); renderSchemaEditor(); }, "tree-select" + (selectedMessage === null ? " selected" : "")));
  (Array.isArray(definition.messages) ? definition.messages : []).forEach((msg, mi) => {
    if (!isObject(msg)) return;
    const group = el("div", "tree-message");
    group.append(button(msg.message_number || "Untitled message", () => { selectedMessage = mi; selectedIndex = null; renderSchemas(); renderSchemaEditor(); }, "tree-select" + (selectedMessage === mi && selectedIndex === null ? " selected" : "")));
    eachNode(msg, (node, path) => {
      const kind = nodeKind(node), selected = selectedMessage === mi && json(selectedIndex) === json(path);
      const item = button(nodeTitle(node), () => { selectedMessage = mi; selectedIndex = path; renderSchemas(); renderSchemaEditor(); }, "tree-select schema-node " + kind + (selected ? " selected" : ""));
      item.style.setProperty("--node-depth", String(path.filter(key => typeof key === "number").length + path.filter(key => key === "optional" || key === "body").length - 1));
      item.dataset.nodePath = "/messages/" + mi + "/" + pathText(path);
      if (kind === "field") item.dataset.fieldKey = node.key || "";
      group.append(item);
    });
    if (Array.isArray(msg.elements) && !msg.elements.length) group.append(el("p", "empty-hint", "Add a field or group below. Elements are encoded from top to bottom."));
    tree.append(group);
  });
}

const schemaUndoHistory = [];
const schemaSteps = new Map();
const schemaStepReach = new Map();
let schemaExplanation = "";
const guidedOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const guidedLabel = key => key.replace(/_/g, " ").replace(/^./, char => char.toUpperCase());
const guidedControllerKeys = ["type", "text_encoding", "length_from"];
const guidedScalarTypes = ["unsigned", "bool", "enum", "twos_complement", "ones_complement", "sign_magnitude"];
const signedTypes = ["twos_complement", "ones_complement", "sign_magnitude"];

function resetSchemaHistory() { schemaUndoHistory.length = 0; schemaSteps.clear(); schemaStepReach.clear(); schemaExplanation = ""; }
function schemaSelection() { return {schema: selectedSchema, message: selectedMessage, index: selectedIndex?.slice() ?? null}; }
const schemaIdentities = new WeakMap();
let nextSchemaIdentity = 1;
function schemaIdentity(value) {
  if (!value || typeof value !== "object") return null;
  if (!schemaIdentities.has(value)) schemaIdentities.set(value, nextSchemaIdentity++);
  return schemaIdentities.get(value);
}
function schemaSnapshot(value) {
  const copy = clone(value), pending = [[value, copy]];
  while (pending.length) {
    const [source, target] = pending.pop();
    if (!source || typeof source !== "object" || !target || typeof target !== "object") continue;
    schemaIdentities.set(target, schemaIdentity(source));
    for (const key of Object.keys(source)) if (source[key] && typeof source[key] === "object") pending.push([source[key], target[key]]);
  }
  return copy;
}
function outputPatches(before, after, path = [], result = []) {
  if (json(before) === json(after)) return result;
  if (isObject(before) && isObject(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) outputPatches(before[key], after[key], [...path, key], result);
  } else if (Array.isArray(before) && Array.isArray(after) && before.length === after.length) {
    before.forEach((item, index) => outputPatches(item, after[index], [...path, index], result));
  } else result.push({path, before: before === undefined ? undefined : clone(before), after: after === undefined ? undefined : clone(after)});
  return result;
}
function schemaLayout(message) {
  const result = {message, messageId: schemaIdentity(message), groups: new Map(), repeats: new Map(), groupIds: new Map(), repeatIds: new Map(), repeatModes: new Map(), fields: new Map()};
  let groups = 0, repeats = 0;
  function visit(node, address, ancestry, depth) {
    if (depth > 128) return;
    const kind = nodeKind(node), identity = schemaIdentity(node);
    if (kind === "field") { result.fields.set(identity, {key: node.key, address: address.join("."), ancestry}); return; }
    if (kind === "group") { node.forEach((child, index) => visit(child, [...address, index + 1], ancestry, depth + 1)); return; }
    if (kind === "optional" && nodeKind(node.optional) !== "field") { result.groups.set(++groups, identity); result.groupIds.set(identity, groups); }
    if (kind === "repeat" || kind === "recurrence") { result.repeats.set(++repeats, identity); result.repeatIds.set(identity, repeats); result.repeatModes.set(identity, kind === "recurrence" ? "recurrence" : guidedOwn(node.repeat || {}, "count") ? "fixed" : "scalar"); ancestry = [...ancestry, identity]; }
    const body = nodeBody(node);
    if (Array.isArray(body)) body.forEach((child, index) => visit(child, [...address, index + 1], ancestry, depth + 1));
    else if (body !== undefined) visit(body, [...address, 1], ancestry, depth + 1);
  }
  if (Array.isArray(message?.elements)) message.elements.forEach((node, index) => visit(node, [index + 1], [], 0));
  return result;
}
function schemaLayouts() {
  return draftSchemas().flatMap(schema => (Array.isArray(schema.document.messages) ? schema.document.messages : []).filter(isObject).map(message => ({schema: schema.id, ...schemaLayout(message)})));
}
function reconcileSchemaControls(before) {
  const after = schemaLayouts(), affected = new Set(), unsafe = new Set();
  for (const output of draftOutputs()) {
    const schema = schemaById(output.mapping?.schema), message = schema?.document.messages?.[output.mapping?.message];
    const current = after.find(layout => layout.schema === schema?.id && layout.messageId === schemaIdentity(message));
    const previous = before.find(layout => layout.schema === schema?.id && layout.messageId === schemaIdentity(message));
    if (!previous || !current) continue;
    const changedScopes = previous.groups.size !== current.groups.size || previous.repeats.size !== current.repeats.size || [...previous.groups].some(([id, node]) => current.groups.get(id) !== node) || [...previous.repeats].some(([id, node]) => current.repeats.get(id) !== node || previous.repeatModes.get(node) !== current.repeatModes.get(node));
    const changedFields = previous.fields.size !== current.fields.size || [...previous.fields].some(([node, field]) => !current.fields.has(node) || field.ancestry.length !== current.fields.get(node).ancestry.length || field.ancestry.some((parent, index) => parent !== current.fields.get(node).ancestry[index]));
    if (!changedScopes && !changedFields) continue;
    const invalidate = (lost = true) => { output.enabled = false; affected.add(output.id); if (lost) unsafe.add(output.id); };
    const remap = (id, oldMap, newMap) => newMap.get(oldMap.get(Number(id)));
    for (const name of ["presence", "repeat_counts"]) {
      if (!Array.isArray(output.mapping[name])) continue;
      const group = name === "presence", key = group ? "group" : "repeat";
      output.mapping[name] = output.mapping[name].filter(control => {
        if (!isObject(control)) return true;
        const next = remap(control[key], group ? previous.groups : previous.repeats, group ? current.groupIds : current.repeatIds);
        if (next === undefined || !group && current.repeatModes.get(current.repeats.get(next)) !== "recurrence") { invalidate(); return false; }
        control[key] = next; return true;
      });
    }
    const entries = ["fields", "vmf_constants", "presence", "repeat_counts"].flatMap(name => Array.isArray(output.mapping[name]) ? output.mapping[name] : []);
    for (const entry of entries) {
      if (!isObject(entry)) continue;
      if (Array.isArray(entry.occurrences)) entry.occurrences = entry.occurrences.filter(selector => {
        if (!isObject(selector)) return true;
        const next = remap(selector.repeat, previous.repeats, current.repeatIds);
        if (next === undefined) { invalidate(); return false; }
        selector.repeat = next; return true;
      });
      if (!isObject(entry.vmf) || typeof entry.vmf.key !== "string") continue;
      const oldField = [...previous.fields].find(([, field]) => field.key === entry.vmf.key);
      if (!oldField) continue;
      const next = current.fields.get(oldField[0]);
      if (!next || oldField[1].ancestry.length !== next.ancestry.length || oldField[1].ancestry.some((node, index) => node !== next.ancestry[index] || previous.repeatModes.get(node) !== current.repeatModes.get(node))) {
        const lost = !next || Array.isArray(entry.occurrences) && entry.occurrences.length > 0;
        delete entry.occurrences; invalidate(lost);
      }
    }
  }
  if (affected.size) schemaExplanation = (schemaExplanation ? schemaExplanation + " " : "") + "Outputs " + [...affected].join(", ") + " were disabled because their fields or repeat/group controls changed. Review their mappings and occurrence settings before enabling them. Undo restores this edit.";
  return unsafe;
}
function schemaChange(label, action, refresh = true) {
  const before = schemaSnapshot(workspace.schemas), selection = schemaSelection(), layouts = schemaLayouts();
  const steps = [...schemaSteps], reach = [...schemaStepReach];
  const outputs = draftOutputs().map((entry, index) => ({entry, index, value: clone(entry)}));
  action();
  if (json(before) === json(workspace.schemas)) return false;
  reconcileSchemaControls(layouts);
  const removedOutputs = outputs.filter(({entry}) => !workspace.outputs.includes(entry)).map(({value, index}) => ({entry: value, index}));
  const outputChanges = outputs.filter(({entry}) => workspace.outputs.includes(entry)).map(({entry, value}) => ({id: entry.id, patches: outputPatches(value, entry)})).filter(change => change.patches.length);
  schemaUndoHistory.push({label, schemas: before, selection, removedOutputs, outputChanges, steps, reach});
  changed();
  if (refresh) render(); else { renderSchemas(); renderSchemaExplanation(); updateSchemaUndo(); scheduleWires(); }
  return true;
}
function renderSchemaExplanation() {
  const target = $("schema-editor");
  let note = target.querySelector(":scope > .guided-explanation");
  if (!schemaExplanation) { note?.remove(); return; }
  if (!note) {
    note = el("p", "guided-explanation");
    const history = target.querySelector(".schema-history");
    if (history) history.after(note); else target.prepend(note);
  }
  note.textContent = schemaExplanation;
}
function updateSchemaUndo() {
  const node = $("schema-undo"); if (!node) return;
  const entry = schemaUndoHistory[schemaUndoHistory.length - 1]; node.disabled = !entry; node.textContent = entry ? "Undo: " + entry.label : "Undo";
}
function undoSchemaChange() {
  if ($("schema-editor").contains(document.activeElement)) document.activeElement.blur();
  const entry = schemaUndoHistory.pop(); if (!entry) return;
  const layouts = schemaLayouts();
  const selections = draftOutputs().map(output => ({id: output.id, schema: output.mapping?.schema, message: schemaIdentity(schemaById(output.mapping?.schema)?.document.messages?.[output.mapping?.message])}));
  const changes = (entry.outputChanges || []).map(change => {
    const output = draftOutputs().find(item => item.id === change.id);
    return {id: change.id, patches: output ? change.patches.filter(patch => json(pathValue(output, patch.path)) === json(patch.after)) : []};
  });
  const restored = new Set(entry.schemas.map(schema => schema.id)), removed = new Set(draftSchemas().filter(schema => !restored.has(schema.id)).map(schema => schema.id));
  workspace.outputs = draftOutputs().filter(output => !removed.has(output.mapping?.schema));
  for (const {entry: output, index} of entry.removedOutputs) if (!workspace.outputs.some(current => current.id === output.id)) workspace.outputs.splice(Math.min(index, workspace.outputs.length), 0, clone(output));
  workspace.schemas = schemaSnapshot(entry.schemas);
  const after = schemaLayouts(), lostMessages = new Set();
  for (const selection of selections) {
    const output = draftOutputs().find(item => item.id === selection.id);
    if (!output || !selection.message || output.mapping?.schema !== selection.schema) continue;
    const schema = schemaById(selection.schema), messages = schema?.document.messages;
    const ordinal = Array.isArray(messages) ? messages.findIndex(message => schemaIdentity(message) === selection.message) : -1;
    if (ordinal >= 0) output.mapping.message = ordinal;
    else { delete output.mapping.message; output.enabled = false; lostMessages.add(output.id); }
  }
  // A mapping created after a rename must follow the same field back on Undo.
  for (const previous of layouts) {
    const current = after.find(layout => layout.schema === previous.schema && layout.messageId === previous.messageId);
    if (!current) continue;
    const schema = schemaById(current.schema), ordinal = schema.document.messages.indexOf(current.message);
    for (const [identity, field] of previous.fields) {
      const restoredField = current.fields.get(identity);
      if (!restoredField || field.key === restoredField.key) continue;
      for (const output of draftOutputs()) {
        if (output.mapping?.schema !== current.schema || output.mapping?.message !== ordinal) continue;
        for (const name of ["fields", "vmf_constants"]) for (const binding of Array.isArray(output.mapping[name]) ? output.mapping[name] : []) if (binding?.vmf?.key === field.key) binding.vmf.key = restoredField.key;
      }
    }
  }
  schemaExplanation = "";
  const unsafe = reconcileSchemaControls(layouts);
  for (const change of changes) {
    const output = draftOutputs().find(item => item.id === change.id); if (!output) continue;
    for (const patch of change.patches) {
      const last = patch.path[patch.path.length - 1];
      // Stable identities already remapped numeric selectors and keyed targets.
      if ((last === "repeat" || last === "group") && patch.path[0] === "mapping") continue;
      if (last === "key" && patch.path.includes("vmf")) continue;
      if (last === "message" && selections.some(selection => selection.id === output.id && selection.message)) continue;
      const owner = pathValue(output, patch.path.slice(0, -1)); if (!owner || typeof owner !== "object") continue;
      if (patch.before === undefined) delete owner[last]; else owner[last] = clone(patch.before);
    }
  }
  for (const output of draftOutputs()) if (unsafe.has(output.id) || lostMessages.has(output.id)) output.enabled = false;
  selectedSchema = entry.selection.schema; selectedMessage = entry.selection.message; selectedIndex = entry.selection.index;
  selectedWire = selectedOutput = null; schemaSteps.clear(); schemaStepReach.clear();
  for (const [key, value] of entry.steps) schemaSteps.set(key, value);
  for (const [key, value] of entry.reach) schemaStepReach.set(key, value);
  const review = [...new Set([...unsafe, ...lostMessages])];
  schemaExplanation = "Undid " + entry.label + ". Edits will be saved automatically." + (review.length ? " Outputs " + review.join(", ") + " remain disabled because controls or fields added afterward need review." : "");
  changed(); render();
}
function guidedHelp(name, description) {
  return typeof helpButton === "function" ? helpButton(name, description) : el("span", "property-help", description);
}
function guidedNote(container, text) { container.append(el("p", "property-help", text)); }
function guidedRemove(owner, keys, removed) {
  for (const key of keys) if (guidedOwn(owner, key)) { delete owner[key]; removed.push(key); }
}
function guidedIndexKeys(field) {
  const keys = ["key", "type", "number_of_bits", "when"], type = field.type || "unsigned";
  if (guidedScalarTypes.includes(type)) { keys.push("bit_order", "allowed", "constant"); if (type === "unsigned" || signedTypes.includes(type)) keys.push("scale"); }
  else if (["bits", "octets", "text", "literal"].includes(type)) {
    if (type !== "bits") keys.push("bit_order");
    if (type === "text" || type === "literal") keys.push("text_encoding");
    if (type !== "literal") { keys.push("length_from"); if (guidedOwn(field, "length_from")) keys.push("length_bias"); }
  }
  return keys;
}
function guidedPruneField(field, removed) {
  const applicable = guidedIndexKeys(field), type = field.type || "unsigned";
  guidedRemove(field, Object.keys(fieldSpec.properties).filter(key => !applicable.includes(key)), removed);
  if (type === "bool") guidedRemove(field, ["number_of_bits"], removed);
  if (type === "literal" && field.text_encoding && !["default", "ascii_7"].includes(field.text_encoding)) guidedRemove(field, ["text_encoding"], removed);
  if (guidedOwn(field, "number_of_bits")) {
    try { guidedCheckInteger("number_of_bits", field.number_of_bits, field, {}); }
    catch { guidedRemove(field, ["number_of_bits"], removed); }
  }
}
function validateFieldKey(value, field, message) {
  if (typeof value !== "string" || !value || value.includes("\0")) throw new Error("Enter a nonempty field key without NUL characters.");
  if (fieldNodes(message).some(item => item.node !== field && item.node.key === value)) throw new Error("This message already contains a field named " + value + ". Choose a unique key.");
}
function renameFieldKey(field, key, message) {
  const previous = field.key;
  const ambiguous = typeof previous === "string" && previous && fieldNodes(message).filter(item => item.node.key === previous).length > 1;
  field.key = key;
  if (ambiguous) {
    schemaExplanation = "The previous key was duplicated. Renamed only this field; existing references and mappings remain with the other field. Review ambiguous dependencies before continuing. Undo restores the previous draft.";
    return;
  }
  if (typeof previous !== "string" || !previous || previous === key) return;
  eachNode(message, node => {
    if (nodeKind(node) === "field") {
      if (node.length_from === previous) node.length_from = key;
      for (const mode of ["all", "any"]) for (const term of Array.isArray(node.when?.[mode]) ? node.when[mode] : []) if (isObject(term) && term.field === previous) term.field = key;
    } else if (nodeKind(node) === "repeat" && node.repeat?.count_from === previous) node.repeat.count_from = key;
  });
  for (const output of draftOutputs()) {
    if (output.mapping?.schema !== selectedSchema || output.mapping?.message !== selectedMessage) continue;
    for (const name of ["fields", "vmf_constants"]) for (const binding of Array.isArray(output.mapping[name]) ? output.mapping[name] : []) if (isObject(binding?.vmf) && binding.vmf.key === previous) binding.vmf.key = key;
  }
}
function precedingFields(message, consumer, extent = false) {
  const result = [];
  function walk(node, ancestors, optional, depth) {
    if (depth > 128) return false;
    if (node === consumer) { result.push(...ancestors); return true; }
    const kind = nodeKind(node);
    if (kind === "field") return false;
    if (kind === "group") {
      const available = ancestors.slice();
      for (const child of node) {
        if (walk(child, available, optional, depth + 1)) return true;
        if (!optional && nodeKind(child) === "field" && !child.when && guidedScalarTypes.includes(child.type || "unsigned") && (!extent || !child.scale && ["unsigned", "bool", "enum"].includes(child.type || "unsigned"))) available.push(child);
        if (!optional && Array.isArray(child)) for (const candidate of alwaysFields(child)) if (!extent || !candidate.scale && ["unsigned", "bool", "enum"].includes(candidate.type || "unsigned")) available.push(candidate);
      }
    } else {
      const body = nodeBody(node);
      if (body !== undefined && walk(body, ancestors, false, depth + 1)) return true;
    }
    return false;
  }
  function alwaysFields(nodes) { return nodes.flatMap(node => Array.isArray(node) ? alwaysFields(node) : nodeKind(node) === "field" && !node.when && guidedScalarTypes.includes(node.type || "unsigned") ? [node] : []); }
  walk(message?.elements || [], [], false, 0);
  return [...new Map(result.filter(node => typeof node.key === "string" && node.key).map(node => [node.key, node])).values()];
}
function guidedController(label, action) {
  const removed = [];
  schemaChange(label, () => { action(removed); schemaExplanation = removed.length ? "Removed settings incompatible with this choice: " + [...new Set(removed)].join(", ") + ". Use Undo to restore the previous choice and its settings." : ""; });
}
function guidedDefault(spec, key) {
  if (key === "scale") return {factor: {numerator: 1, denominator: 1}, bias: {numerator: 0, denominator: 1}};
  if (key === "when") return {all: []};
  return initial(spec);
}
function guidedInteger(source) {
  if (!/^-?(?:0|[1-9]\d*)$/.test(source)) throw new Error("Enter an integer without decimals or exponents.");
  const value = parseJSON(source);
  if (BigInt(value) < -9223372036854775808n || BigInt(value) > 18446744073709551615n) throw new Error("Enter an integer in the native 64-bit range.");
  return value;
}
function guidedCheckInteger(key, next, owner, context) {
  const value = BigInt(next), signed = ["numerator", "length_bias", "bias"].includes(key);
  if (!signed && value < 0n) throw new Error("Enter an unsigned integer.");
  if (signed && value > 9223372036854775807n) throw new Error("Enter a signed 64-bit integer.");
  if (key === "denominator" && value === 0n) throw new Error("Denominator must be nonzero.");
  if (key === "subtype" && value > 127n) throw new Error("Subtype must be between 0 and 127.");
  if (["count", "maximum"].includes(key) && value === 18446744073709551615n) throw new Error("Enter a finite count below 18446744073709551615.");
  if (key === "maximum" && context.recurrence && value < 1n) throw new Error("Recurrence maximum must be positive.");
  if (key === "number_of_bits") {
    const type = owner.type || "unsigned";
    if (type === "bool" && value !== 1n) throw new Error("Boolean fields use one bit.");
    if (guidedScalarTypes.includes(type) && (value < BigInt(signedTypes.includes(type) ? 2 : 1) || value > 64n)) throw new Error("Enter a scalar width between its representation minimum and 64 bits.");
    const unit = type === "octets" ? 8n : type === "literal" || type === "text" && (!owner.text_encoding || ["default", "ascii_7"].includes(owner.text_encoding)) ? 7n : type === "text" ? 8n : 1n;
    if (value % unit) throw new Error("Capacity must be divisible by " + unit + " bits.");
    if (!guidedScalarTypes.includes(type) && type !== "literal" && !owner.length_from && value === 0n) throw new Error("Fixed capacity must be positive. Zero is allowed with a length source or literal encoding.");
  }
}
function guidedField(owner, key, spec, path, context = {}, options = {}) {
  const row = el("div", "property guided-property"); row.dataset.propertyName = key;
  const name = el("div", "property-label"); name.append(el("label", "", guidedLabel(key)));
  const description = options.help || propertyHelp(key, path);
  if (description) name.append(guidedHelp(key, description));
  if (!options.required && guidedOwn(owner, key)) name.append(button("Remove " + guidedLabel(key), () => {
    guidedController("remove " + guidedLabel(key), removed => { delete owner[key]; if (context.field === owner && guidedControllerKeys.includes(key)) guidedPruneField(owner, removed); });
  }, "remove-property"));
  row.append(name);
  if (!guidedOwn(owner, key) && !options.required) {
    row.append(button("+ Add " + guidedLabel(key), () => {
      guidedController("add " + guidedLabel(key), removed => { owner[key] = guidedDefault(spec, key); if (context.field === owner && guidedControllerKeys.includes(key)) guidedPruneField(owner, removed); });
    }));
    return row;
  }
  const current = guidedOwn(owner, key) ? owner[key] : options.defaultValue;
  const reference = ["length_from", "count_from", "field"].includes(key) && context.message;
  if (reference) spec = {kind: "enum", values: precedingFields(context.message, context.consumer || context.field, key !== "field").map(field => field.key)};
  if (spec.kind === "object" || spec.kind === "array") {
    if (options.required && (spec.kind === "object" ? !isObject(current) : !Array.isArray(current))) row.dataset.requiredInvalid = "true";
    row.append(guidedValue(current, spec, next => { owner[key] = next; }, path + "/" + key, context));
    return row;
  }
  const validType = current === undefined || spec.kind === "enum" ? current === undefined || spec.kind !== "enum" || spec.values.includes(current) : spec.kind === "integer" ? (typeof current === "bigint" || Number.isSafeInteger(current)) : spec.kind === "boolean" ? typeof current === "boolean" : typeof current === "string";
  if (!validType && !reference) { if (options.required) row.dataset.requiredInvalid = "true"; row.append(guidedRepairValue(current, spec, next => { owner[key] = next; if (context.field === owner && guidedControllerKeys.includes(key)) guidedPruneField(owner, []); }, path + "/" + key, context)); return row; }
  let input;
  if (spec.kind === "enum") {
    input = el("select");
    if (current === undefined || reference) input.add(new Option(reference ? "Choose an earlier field…" : "Choose…", ""));
    if (current !== undefined && reference && !spec.values.includes(current)) { const saved = new Option("Unavailable saved reference: " + String(current), String(current)); saved.disabled = true; input.add(saved); }
    for (const option of spec.values) input.add(new Option(String(option), String(option)));
    input.value = current === undefined ? "" : String(current);
  } else {
    input = el("input"); input.type = spec.kind === "boolean" ? "checkbox" : "text";
    if (spec.kind === "boolean") input.checked = current || false;
    else input.value = current === undefined ? "" : String(current);
    if (spec.kind === "integer") input.inputMode = "numeric";
    input.spellcheck = false;
  }
  input.dataset.property = key; input.setAttribute("aria-label", key);
  input.required = !!options.required;
  if (reference && current !== undefined && !spec.values.includes(current)) input.setCustomValidity("Choose an available preceding field to repair this reference.");
  if (key === "key" && context.field === owner && current !== undefined) {
    try { validateFieldKey(current, owner, context.message); } catch (error) { input.setCustomValidity(error.message); }
  }
  if (current !== undefined && spec.kind === "integer") {
    try { guidedCheckInteger(key, guidedInteger(String(current)), owner, context); }
    catch (error) { input.setCustomValidity(error.message); }
  }
  const pending = el("small", "pending-input", "Press Tab or leave this field to save");
  pending.hidden = true; pending.setAttribute("role", "status");
  input.addEventListener("input", () => { input.setCustomValidity(""); pending.hidden = false; });
  input.addEventListener("change", () => {
    try {
      let next = spec.kind === "boolean" ? input.checked : spec.kind === "enum" ? spec.values.find(option => String(option) === input.value) : input.value;
      if (spec.kind === "integer") { next = guidedInteger(input.value); guidedCheckInteger(key, next, owner, context); }
      if (reference && next === undefined) throw new Error("Choose an available preceding field.");
      if (key === "key" && context.field === owner) validateFieldKey(next, owner, context.message);
      if (options.required && next === "") throw new Error("Enter " + guidedLabel(key).toLowerCase() + ".");
      if (key === "message_number" && !/^K(?:0?[0-9]|10)\.(?:[1-9]|[1-9][0-9]|1[01][0-9]|12[0-7])$/.test(next)) throw new Error("Enter a K-number with functional area 0–10 and message number 1–127, such as K01.1.");
      input.setCustomValidity("");
      if (options.controller) guidedController("change " + guidedLabel(key), removed => {
        if (key === "key" && context.field === owner) renameFieldKey(owner, next, context.message); else owner[key] = next;
        if (options.setValue) options.setValue(next);
        if (context.field === owner && guidedControllerKeys.includes(key)) guidedPruneField(owner, removed);
        if (options.after) options.after(removed);
      });
      else schemaChange("change " + guidedLabel(key), () => { if (key === "key" && context.field === owner) renameFieldKey(owner, next, context.message); else owner[key] = next; if (options.setValue) options.setValue(next); }, false);
      pending.hidden = true;
    } catch (error) { input.setCustomValidity(error.message); input.reportValidity(); }
  });
  row.append(input, pending); return row;
}
function guidedFields(target, owner, spec, keys, path, context, required = spec.required || []) {
  for (const key of keys) target.append(guidedField(owner, key, spec.properties[key], path, context, {required: required.includes(key)}));
}
function guidedRepairValue(value, spec, set, path, context) {
  const node = el("div", "guided-repair");
  guidedNote(node, "This saved value needs repair. It stays unchanged until you replace it.");
  node.append(el("code", "repair-value", json(value) ?? "Missing"), button("Replace with " + spec.kind, () => schemaChange("repair value", () => set(guidedDefault(spec, path.split("/").pop())))));
  return node;
}
function guidedRepairProperties(target, value, spec, applicable, path, context) {
  const keys = Object.keys(value).filter(key => !applicable.includes(key));
  if (!keys.length) return;
  const repair = el("details", "guided-repair"); repair.append(el("summary", "", "Review saved settings (" + keys.length + ")"));
  guidedNote(repair, "These settings are unknown or do not apply to the current choices. They are preserved until you edit or remove them.");
  for (const key of keys) {
    const row = el("div", "property"); row.append(el("code", "", key), el("code", "repair-value", json(value[key])), button("Remove " + key, () => schemaChange("remove " + key, () => { delete value[key]; })));
    repair.append(row);
  }
  target.append(repair);
}
function guidedStepper(path, stages) {
  const node = el("section", "guided-form"); node.dataset.guidedForm = path;
  let step = Math.min(schemaSteps.get(path) || 0, stages.length - 1);
  schemaSteps.set(path, step);
  const reached = Math.max(schemaStepReach.get(path) || 0, step);
  schemaStepReach.set(path, reached);
  const navigation = el("nav", "guided-steps"); navigation.setAttribute("aria-label", "Form steps");
  const body = el("div", "guided-step-body");
  function advance(next) {
    if (next > step) {
      const invalid = body.querySelector('[data-required-invalid="true"]');
      if (invalid) { message("Complete or repair the required settings in this step before continuing.", true); invalid.scrollIntoView({block: "nearest"}); invalid.querySelector("button")?.focus(); return; }
      for (const input of body.querySelectorAll("input, select")) if (!input.checkValidity()) { input.reportValidity(); return; }
    }
    schemaSteps.set(path, next); renderSchemaEditor();
  }
  stages.forEach((stage, index) => {
    const control = button((index + 1) + ". " + stage.title, () => advance(index), "guided-step" + (index === step ? " selected" : ""));
    control.disabled = index > reached + 1;
    if (index === step) control.setAttribute("aria-current", "step");
    navigation.append(control);
  });
  node.append(navigation); stages[step].render(body); node.append(body);
  const actions = el("div", "button-row guided-navigation");
  const back = button("Back", () => advance(step - 1)); back.disabled = !step;
  actions.append(back);
  if (step < stages.length - 1) actions.append(button("Next", () => advance(step + 1), "button small primary"));
  else actions.append(el("span", "property-help", "Edits save automatically."));
  node.append(actions); return node;
}
function guidedStandard(target, owner, path, envelope, isMessage) {
  const names = standards.values;
  const hasNamed = guidedOwn(owner, "message_standard"), hasRaw = guidedOwn(owner, "standard_version");
  const mode = hasNamed && hasRaw ? "conflict" : hasNamed ? "edition" : hasRaw ? owner.standard_version === "absent" ? "absent" : "raw" : "inherit";
  const row = el("div", "property"), select = el("select");
  select.setAttribute("aria-label", "Standard selection"); select.dataset.property = "standard_selection";
  select.add(new Option(isMessage ? "Inherit schema selection" : "No shared standard selection", "inherit"));
  select.add(new Option("Explicitly absent", "absent"));
  if (names.length) { select.add(new Option("Named edition", "edition")); select.add(new Option("Raw version code", "raw")); }
  if (![...select.options].some(option => option.value === mode)) select.add(new Option("Saved selection needs repair", mode));
  select.value = mode;
  const label = el("label", "property-label", "Standard selection");
  label.append(helpButton("standard selection", "Choose inheritance, an absent version where permitted, a named edition, or a raw version code. Named and raw selections replace each other; message overrides replace the schema selection as a unit."));
  row.append(label, select); target.append(row);
  select.addEventListener("change", () => schemaChange("change standard selection", () => {
    delete owner.message_standard; delete owner.standard_version;
    if (select.value === "edition") owner.message_standard = names[0];
    else if (select.value === "raw") owner.standard_version = 0;
    else if (select.value === "absent") owner.standard_version = "absent";
    schemaExplanation = "The standard selection replaces its previous selection as one edit. Use Undo to restore it.";
  }));
  if (hasNamed) target.append(guidedField(owner, "message_standard", {kind: "enum", values: names}, path, {}, {required: true}));
  if (hasRaw && owner.standard_version !== "absent") {
    const codes = Array.from({length: 11}, (_, index) => index);
    const control = guidedField(owner, "standard_version", {kind: "enum", values: codes}, path, {}, {required: true});
    // Native version codes are numbers, despite HTML option values being strings.
    const input = control.querySelector("select");
    if (input) input.addEventListener("change", () => { if (typeof owner.standard_version === "string" && /^\d+$/.test(owner.standard_version)) owner.standard_version = Number(owner.standard_version); });
    target.append(control);
  }
  if (mode === "conflict") guidedNote(target, "Choose one selection mechanism to replace these conflicting saved properties.");
  guidedNote(target, "Named editions are shared by compatible output envelopes. B omits their version; C/D/D1 map it to their own codes. A raw code retains its source-profile restriction when a default envelope is present.");
}
function guidedValue(value, spec, set, path, context = {}) {
  if (spec.kind === "array") {
    if (!Array.isArray(value)) return guidedRepairValue(value, spec, set, path, context);
    const node = el("div", "guided-array");
    value.forEach((item, index) => {
      const row = el("section", "array-item"), heading = el("div", "array-heading");
      heading.append(el("strong", "", "Item " + (index + 1)));
      const actions = el("div", "array-actions");
      const up = button("Move item up", () => schemaChange("move item", () => { [value[index - 1], value[index]] = [value[index], value[index - 1]]; })); up.disabled = index === 0;
      const down = button("Move item down", () => schemaChange("move item", () => { [value[index + 1], value[index]] = [value[index], value[index + 1]]; })); down.disabled = index === value.length - 1;
      actions.append(up, down, button("Delete item", () => schemaChange("delete item", () => value.splice(index, 1)), "text-button danger"));
      heading.append(actions); row.append(heading);
      if (spec.item.kind === "object" || spec.item.kind === "array") row.append(guidedValue(item, spec.item, next => { value[index] = next; }, path + "/" + index, context));
      else {
        const owner = {value: item};
        const control = guidedField(owner, "value", spec.item, path + "/" + index, context, {required: true, setValue: next => { value[index] = next; }});
        row.append(control);
      }
      node.append(row);
    });
    node.append(button("+ Add item", () => schemaChange("add item", () => value.push(guidedDefault(spec.item, path.split("/").pop())))));
    return node;
  }
  if (!isObject(value)) return guidedRepairValue(value, spec, set, path, context);
  if (spec === schemaSpec) return guidedSchema(value, path);
  if (spec === nativeMessageSpec) return guidedMessage(value, path);
  if (spec === fieldSpec) return guidedIndex(value, path, context);
  if (spec === conditionSpec) return guidedCondition(value, path, context);
  const node = el("div", "object-editor");
  guidedFields(node, value, spec, Object.keys(spec.properties), path, context);
  guidedRepairProperties(node, value, spec, Object.keys(spec.properties), path, context);
  return node;
}
function guidedMalformedItems(target, value, spec, path, context) {
  value.forEach((item, index) => {
    if (isObject(item)) return;
    const row = el("div", "guided-repair");
    row.append(el("strong", "", "Repair item " + (index + 1)), guidedRepairValue(item, spec, next => { value[index] = next; }, path + "/" + index, context), button("Delete malformed item", () => schemaChange("delete malformed item", () => value.splice(index, 1)), "text-button danger"));
    target.append(row);
  });
}
function guidedSchema(value, path) {
  const node = el("div");
  guidedNote(node, "Library name: " + selectedSchema + ". This workspace label is separate from a message number such as K01.1 and the specification's MIL standard edition.");
  if (value.format !== "vmf-schema/1") node.append(guidedField(value, "format", schemaSpec.properties.format, path, {}, {required: true}));
  node.append(guidedStepper(path, [
    {title: "Defaults", render: target => { guidedNote(target, "Choose the standard edition for your definition. An envelope default is optional; outputs choose their own envelopes."); target.append(guidedField(value, "envelope", schemaSpec.properties.envelope, path, {}, {controller: true})); }},
    {title: "Standard", render: target => guidedStandard(target, value, path, value.envelope, false)},
    {title: "Messages", render: target => { guidedNote(target, "Use + Message, then add fields and groups in the order they appear in your specification."); if (!Array.isArray(value.messages)) target.append(guidedField(value, "messages", schemaSpec.properties.messages, path, {}, {required: true})); else guidedMalformedItems(target, value.messages, nativeMessageSpec, path + "/messages", {}); }}
  ]));
  guidedRepairProperties(node, value, schemaSpec, Object.keys(schemaSpec.properties), path, {});
  return node;
}
function guidedMessage(value, path) {
  const node = el("div"), context = {message: value};
  guidedNote(node, "Message number identifies the message inside this definition, for example K01.1. The MIL standard edition identifies your source specification; the library name identifies the saved definition.");
  if (!value.message_number) guidedNote(node, "Enter the message number from your specification to complete this new message. For the synthetic walkthrough, use K01.1.");
  node.append(guidedStepper(path, [
    {title: "Identity", render: target => { guidedFields(target, value, nativeMessageSpec, ["message_number", "subtype"], path, context); guidedStandard(target, value, path, selectedDefinition()?.envelope, true); }},
    {title: "Packing", render: target => { guidedFields(target, value, nativeMessageSpec, ["octet_order"], path, context); guidedNote(target, "The outline lists elements in wire order. Select an element to move it, wrap it, or add children. A group containing one field remains a group."); if (!Array.isArray(value.elements)) target.append(guidedField(value, "elements", nativeMessageSpec.properties.elements, path, context, {required: true})); }}
  ]));
  guidedRepairProperties(node, value, nativeMessageSpec, Object.keys(nativeMessageSpec.properties), path, context);
  return node;
}
function directlyOptional(path) { return path?.[path.length - 1] === "optional"; }
function guidedIndex(value, path, context) {
  const node = el("div"), type = value.type || "unsigned", optional = directlyOptional(selectedIndex);
  context = {...context, field: value, consumer: value};
  node.append(guidedStepper(path, [
    {title: "Identity", render: target => {
      guidedNote(target, "Give this field a unique key. Dependencies and mappings follow this key when you move the field; renaming updates those references together.");
      target.append(guidedField(value, "key", text, path, context, {required: true}));
      if (fieldNodes(context.message).filter(item => item.node.key === value.key).length > 1) target.append(el("p", "schema-invalid", "This key is duplicated. Rename this field before continuing."));
    }},
    {title: "Encoding", render: target => {
      target.append(guidedField(value, "type", fieldSpec.properties.type, path, context, {required: true, controller: true, defaultValue: "unsigned"}));
      if (type === "text" || type === "literal") target.append(guidedField(value, "text_encoding", type === "literal" ? enumeration("default", "ascii_7") : fieldSpec.properties.text_encoding, path, context, {controller: true}));
      guidedNote(target, signedTypes.includes(type) ? "This type explicitly chooses the signed integer representation." : type === "bool" ? "Boolean width is implied: one bit." : "Choose the wire type given by your specification.");
    }},
    {title: "Size & length", render: target => {
      if (["bits", "octets", "text"].includes(type)) target.append(guidedField(value, "length_from", text, path, context, {controller: true}));
      if (type === "bool") {
        guidedNote(target, "One bit is generated automatically. You do not need to enter its width.");
        if (guidedOwn(value, "number_of_bits")) {
          if (value.number_of_bits !== 1) target.append(el("p", "schema-invalid", "The saved boolean width is invalid."));
          target.append(button("Use implied one-bit width", () => schemaChange("use boolean width", () => { delete value.number_of_bits; })));
        }
      } else target.append(guidedField(value, "number_of_bits", integer, path, context, {required: true}));
      if (guidedOwn(value, "length_from")) target.append(guidedField(value, "length_bias", integer, path, context));
      if (type !== "bits") target.append(guidedField(value, "bit_order", order, path, context));
      guidedNote(target, value.length_from !== undefined || type === "literal" ? "Enter the finite capacity in bits. Length comes from the chosen source or literal termination." : "Enter the exact field width in bits from the specification.");
    }},
    {title: "Constraints", render: target => {
      if (guidedScalarTypes.includes(type)) {
        guidedFields(target, value, fieldSpec, ["allowed", "constant", ...(type === "unsigned" || signedTypes.includes(type) ? ["scale"] : [])], path, context, []);
        guidedNote(target, "Adding scale supplies its exact rational metadata and makes this a scaled field automatically. Raw constraints still use wire codes.");
      } else guidedNote(target, "Raw scalar constraints and scale do not apply to this field type.");
    }},
    {title: "Condition", render: target => {
      if (optional) {
        guidedNote(target, "This field already has its own presence control. A separate condition cannot also control it.");
        if (guidedOwn(value, "when")) target.append(button("Remove incompatible condition", () => schemaChange("remove incompatible condition", () => { delete value.when; })));
      } else target.append(guidedField(value, "when", conditionSpec, path, context));
    }}
  ]));
  guidedRepairProperties(node, value, fieldSpec, guidedIndexKeys(value), path, context);
  return node;
}
function guidedCondition(value, path, context) {
  const node = el("div"), mode = guidedOwn(value, "any") && !guidedOwn(value, "all") ? "any" : "all";
  node.dataset.guidedForm = path;
  const label = el("label", "property-label", "Match condition terms"), select = el("select");
  select.dataset.property = "condition_mode"; select.setAttribute("aria-label", "Condition match");
  select.add(new Option("All terms must match", "all")); select.add(new Option("Any term may match", "any")); select.value = mode;
  select.addEventListener("change", () => schemaChange("change condition mode", () => { const terms = Array.isArray(value[mode]) ? value[mode] : []; delete value.all; delete value.any; value[select.value] = terms; }));
  node.append(label, select, guidedField(value, "negate", boolean, path, context));
  if (guidedOwn(value, "all") && guidedOwn(value, "any")) node.append(el("p", "schema-invalid", "Choose a match mode to repair the conflicting all/any arrays."));
  guidedNote(node, "Choose available earlier scalar fields by key. Add at least one term and one raw-code range per term.");
  node.append(guidedConditionTerms(value, path, context, mode));
  guidedRepairProperties(node, value, conditionSpec, ["all", "any", "negate"], path, context);
  return node;
}
function guidedConditionTerms(value, path, context, mode) {
  const spec = termSpec;
  if (!Array.isArray(value[mode])) return guidedRepairValue(value[mode], array(spec), next => { value[mode] = next; }, path + "/" + mode, context);
  const node = el("div", "guided-array");
  value[mode].forEach((term, index) => {
    const row = el("section", "array-item"), termPath = path + "/" + mode + "/" + index;
    row.append(el("h4", "", "Term " + (index + 1)), button("Delete term", () => schemaChange("delete condition term", () => value[mode].splice(index, 1)), "text-button danger"));
    if (!isObject(term)) row.append(guidedRepairValue(term, spec, next => { value[mode][index] = next; }, termPath, context));
    else {
      row.append(guidedStepper(termPath, [
        {title: "Source", render: target => target.append(guidedField(term, "field", text, termPath, context, {required: true}))},
        {title: "Raw values", render: target => guidedFields(target, term, spec, ["values"], termPath, context)},
        {title: "Mask & negation", render: target => guidedFields(target, term, spec, ["mask", "negate"], termPath, context)}
      ]));
      guidedRepairProperties(row, term, spec, Object.keys(spec.properties), termPath, context);
    }
    node.append(row);
  });
  node.append(button("+ Add term", () => schemaChange("add condition term", () => value[mode].push({field: "", values: []}))));
  return node;
}
function selectNodeObject(message, value) {
  selectedIndex = null;
  eachNode(message, (node, path) => { if (node === value && selectedIndex === null) selectedIndex = path; });
}
function structuralEdit(label, action) {
  schemaChange(label, () => { schemaExplanation = ""; action(); schemaSteps.clear(); schemaStepReach.clear(); });
}
function wrapSelected(kind) {
  const message = selectedDefinition()?.messages?.[selectedMessage], value = selectedNode();
  if (!message || selectedIndex === null) return;
  structuralEdit("wrap " + nodeTitle(value), () => {
    let next;
    if (kind === "group") next = [value];
    else if (kind === "optional") {
      if (nodeKind(value) === "field" && guidedOwn(value, "when")) { delete value.when; schemaExplanation = "Removed the field condition because a direct optional field uses its own presence control. Undo restores the condition and previous structure."; }
      next = {optional: value};
    } else if (kind === "recurrence") next = {recurrence: {maximum: 1, body: value}};
    else next = {repeat: kind === "fixed" ? {count: 1, body: value} : {count_from: "", maximum: 1, body: value}};
    setPath(message, selectedIndex, next); selectNodeObject(message, next);
  });
}
function moveSelected(direction) {
  const message = selectedDefinition()?.messages?.[selectedMessage], path = selectedIndex?.slice();
  if (!message || !path) return;
  const parent = pathValue(message, path.slice(0, -1)), index = path[path.length - 1], value = pathValue(message, path);
  if (!Array.isArray(parent) || index + direction < 0 || index + direction >= parent.length) return;
  structuralEdit("move element", () => { [parent[index], parent[index + direction]] = [parent[index + direction], parent[index]]; selectNodeObject(message, value); });
}
function unwrapSelected() {
  const message = selectedDefinition()?.messages?.[selectedMessage], path = selectedIndex?.slice(), value = selectedNode(), kind = nodeKind(value);
  if (!message || !path) return;
  structuralEdit(kind === "group" ? "ungroup elements" : "remove wrapper", () => {
    const parent = pathValue(message, path.slice(0, -1)), key = path[path.length - 1];
    if (kind === "group") {
      if (Array.isArray(parent)) { parent.splice(key, 1, ...value); selectedIndex = value.length ? [...path.slice(0, -1), key] : null; }
      else if (value.length === 1) { setPath(message, path, value[0]); selectNodeObject(message, value[0]); }
    } else { const body = nodeBody(value); setPath(message, path, body); selectNodeObject(message, body); }
  });
}
function deleteSelected() {
  const message = selectedDefinition()?.messages?.[selectedMessage], path = selectedIndex?.slice();
  if (!message || !path) return;
  structuralEdit("delete element", () => {
    const parent = pathValue(message, path.slice(0, -1)), key = path[path.length - 1];
    if (Array.isArray(parent)) { parent.splice(key, 1); selectedIndex = path.length > 2 ? path.slice(0, -1) : null; }
    else { parent[key] = []; selectedIndex = path; }
  });
}
function guidedContainer(value, path, context) {
  const node = el("div"), kind = nodeKind(value), body = nodeBody(value);
  if (kind === "invalid") {
    guidedNote(node, "This element is malformed. Replace it with a field or a group, or delete it. The saved value is preserved until you choose.");
    node.append(el("code", "repair-value", json(value) ?? "Missing"), button("Replace with field", () => structuralEdit("repair element", () => { const field = freshField(context.message); setPath(context.message, selectedIndex, field); selectNodeObject(context.message, field); })), button("Replace with group", () => structuralEdit("repair element", () => { const group = [freshField(context.message)]; setPath(context.message, selectedIndex, group); selectNodeObject(context.message, group); })));
    return node;
  }
  if (kind === "group") guidedNote(node, "This ordered group adds no bits by itself. Its children appear below it in the outline. It remains a group even when it contains one field.");
  else if (kind === "optional") {
    guidedNote(node, nodeKind(body) === "field" ? "One generated presence bit controls this field. Supply its mapped value to include it." : "One generated presence bit controls this group. Its contents stay together.");
    guidedRepairProperties(node, value, object({optional: nodeSpec}), ["optional"], path, context);
  } else {
    const settings = value[kind];
    if (!isObject(settings)) { node.append(guidedRepairValue(settings, object({body: nodeSpec}), next => { value[kind] = {...next, ...(kind === "recurrence" ? {maximum: 1} : {count: 1}), body: freshField(context.message)}; }, path + "/" + kind, context)); return node; }
    const mode = kind === "recurrence" ? "recurrence" : guidedOwn(settings, "count") ? "fixed" : "scalar";
    const choice = el("select"); choice.setAttribute("aria-label", "Repeat count mechanism"); choice.dataset.property = "repeat_mechanism";
    for (const [name, label] of [["recurrence", "Recurrence indicator with explicit maximum"], ["fixed", "Fixed count"], ["scalar", "Count from an earlier field"]]) choice.add(new Option(label, name));
    choice.value = mode;
    choice.addEventListener("change", () => structuralEdit("change repeat count mechanism", () => {
      const child = nodeBody(value); delete value.recurrence; delete value.repeat;
      if (choice.value === "recurrence") value.recurrence = {maximum: 1, body: child};
      else value.repeat = choice.value === "fixed" ? {count: 1, body: child} : {count_from: "", maximum: 1, body: child};
      schemaExplanation = "Changed the repetition rule. The body was preserved; Undo restores the previous count settings.";
    }));
    node.append(el("label", "property-label", "Repeat count mechanism"), choice);
    const repeatContext = {...context, consumer: value, recurrence: mode === "recurrence"}, repeatPath = path + "/" + kind;
    const keys = mode === "fixed" ? ["count"] : mode === "scalar" ? ["count_from", "maximum", "minimum", "bias"] : ["maximum"];
    for (const key of keys) node.append(guidedField(settings, key, key === "count_from" ? text : integer, repeatPath, repeatContext, {required: ["count", "count_from", "maximum"].includes(key)}));
    guidedNote(node, mode === "recurrence" ? "The maximum comes from your specification. The selected field or group repeats with generated recurrence bits." : mode === "fixed" ? "Every occurrence uses the same body. Zero is an explicit fixed count." : "Choose the field that supplies the count and enter the permitted maximum. The count field still needs its own input value.");
    guidedRepairProperties(node, settings, object(Object.fromEntries(["body", ...keys].map(key => [key, key === "body" ? nodeSpec : key === "count_from" ? text : integer]))), ["body", ...keys], repeatPath, repeatContext);
    guidedRepairProperties(node, value, object({[kind]: nodeSpec}), [kind], path, context);
  }
  if (kind === "group" && !value.length || kind !== "group" && body === undefined) guidedNote(node, "This body is empty or missing. Add a field inside before this definition can activate.");
  const children = el("div", "button-row node-children");
  children.append(button("Add field inside", () => guidedAddElement("field")), button("Add group inside", () => guidedAddElement("group")));
  node.append(children);
  return node;
}
function renderSchemaEditor() {
  const target = $("schema-editor"), definition = selectedDefinition(); target.replaceChildren();
  const undo = button("Undo", undoSchemaChange, "button small schema-undo"); undo.id = "schema-undo";
  const history = el("div", "schema-history"); history.append(undo, helpButton("schema Undo", "Restore a schema edit, including wrappers, moves, renamed references, and affected mapping controls. Unrelated Mapping edits are retained. Reloading clears this history."));
  target.append(history); updateSchemaUndo();
  if (schemaExplanation) target.append(el("p", "guided-explanation", schemaExplanation));
  if (!definition) { $("schema-inspector-title").textContent = "Select a definition"; guidedNote(target, draftSchemas().length ? "Select a schema from the library to edit its fields and groups." : "Choose or create a schema. Add a message, then define its fields and groups in wire order."); return; }
  let current = definition, spec = schemaSpec, title = "Schema properties", context = {};
  if (selectedMessage !== null) {
    current = definition.messages?.[selectedMessage]; spec = nativeMessageSpec; title = "Message properties";
    if (!isObject(current)) { selectedMessage = selectedIndex = null; return renderSchemaEditor(); }
    context.message = current;
    if (selectedIndex !== null) { current = pathValue(current, selectedIndex); spec = nodeKind(current) === "field" ? fieldSpec : nodeSpec; title = nodeTitle(current); context.field = current; }
  }
  $("schema-inspector-title").textContent = title;
  const native = catalogSchema(selectedSchema);
  if (native?.valid === false) target.append(el("p", "schema-invalid", native.diagnostic || "Complete this schema to activate it."));
  const path = "schema/" + selectedSchema + "/messages/" + selectedMessage + (selectedIndex ? "/" + pathText(selectedIndex) : "");
  const setCurrent = next => { if (selectedMessage === null) schemaById(selectedSchema).document = next; else if (selectedIndex === null) definition.messages[selectedMessage] = next; else setPath(definition.messages[selectedMessage], selectedIndex, next); };
  target.append(spec === nodeSpec ? guidedContainer(current, path, context) : guidedValue(current, spec, setCurrent, path, context));
  if (selectedMessage !== null) {
    const actions = el("div", "button-row node-actions");
    if (selectedIndex !== null) {
      const kind = nodeKind(current), parent = pathValue(context.message, selectedIndex.slice(0, -1)), index = selectedIndex[selectedIndex.length - 1];
      const up = button("Move element up", () => moveSelected(-1)), down = button("Move element down", () => moveSelected(1));
      up.disabled = !Array.isArray(parent) || index === 0; down.disabled = !Array.isArray(parent) || index >= parent.length - 1;
      actions.append(up, down);
      for (const [kind, label] of [["group", "Wrap in group"], ["optional", "Make optional"], ["recurrence", "Repeat with indicator"], ["fixed", "Repeat fixed times"], ["scalar", "Repeat from field"]]) actions.append(button(label, () => wrapSelected(kind)));
      if (["optional", "recurrence", "repeat"].includes(kind)) actions.append(button("Remove wrapper", unwrapSelected));
      if (kind === "group") { const ungroup = button("Ungroup", unwrapSelected); ungroup.disabled = !Array.isArray(parent) && current.length !== 1; actions.append(ungroup); }
      actions.append(button("Delete element", deleteSelected, "text-button danger"));
    } else {
      const up = button("Move message up", () => moveSchemaMessage(selectedMessage, -1)), down = button("Move message down", () => moveSchemaMessage(selectedMessage, 1));
      up.disabled = selectedMessage === 0; down.disabled = selectedMessage === definition.messages.length - 1;
      actions.append(up, down, button("Delete message", () => deleteSchemaMessage(selectedMessage), "text-button danger"));
    }
    target.append(el("hr", "section-divider"), actions);
  }
}
function moveSchemaMessage(index, direction) {
  const definition = selectedDefinition(), next = index + direction;
  if (!Array.isArray(definition?.messages) || next < 0 || next >= definition.messages.length) return;
  schemaChange("move message", () => {
    [definition.messages[index], definition.messages[next]] = [definition.messages[next], definition.messages[index]];
    for (const output of draftOutputs()) {
      if (output.mapping?.schema !== selectedSchema) continue;
      if (output.mapping.message === index) output.mapping.message = next;
      else if (output.mapping.message === next) output.mapping.message = index;
    }
    selectedMessage = next; selectedIndex = null;
  });
}
function deleteSchemaMessage(index) {
  const definition = selectedDefinition();
  if (!Array.isArray(definition?.messages)) return;
  schemaChange("delete message", () => {
    definition.messages.splice(index, 1);
    for (const output of draftOutputs()) {
      if (output.mapping?.schema !== selectedSchema || !Number.isInteger(output.mapping.message)) continue;
      if (output.mapping.message === index) { delete output.mapping.message; output.enabled = false; }
      else if (output.mapping.message > index) output.mapping.message--;
    }
    selectedMessage = selectedIndex = null;
  });
}
function uniqueSchemaName(base, numbered = false) {
  let suffix = 1, name = numbered ? base + "-1" : base;
  while (schemaById(name)) name = base + "-" + (++suffix);
  return name;
}
function guidedAddSchema() {
  schemaChange("new schema", () => {
    const schema = {id: uniqueSchemaName("payload", true), document: {format: "vmf-schema/1", messages: []}};
    workspace.schemas.push(schema); selectedSchema = schema.id; selectedMessage = selectedIndex = null; schemaExplanation = "";
  });
}
function guidedAddMessage() {
  const definition = selectedDefinition(); if (!definition) return;
  if (!Array.isArray(definition.messages)) { message("Repair the messages array before adding a message.", true); return; }
  schemaChange("new message", () => { definition.messages.push({message_number: "", elements: []}); selectedMessage = definition.messages.length - 1; selectedIndex = null; schemaExplanation = ""; });
}
function guidedAddElement(kind) {
  const message = selectedDefinition()?.messages?.[selectedMessage]; if (!message) return;
  if (!Array.isArray(message.elements)) { messageNotice("Repair the elements array before adding a field or group."); return; }
  structuralEdit("add " + kind, () => {
    const field = freshField(message), next = kind === "group" ? [field] : field, selected = selectedNode(), selectedKind = nodeKind(selected);
    if (selectedIndex === null) message.elements.push(next);
    else if (Array.isArray(selected)) selected.push(next);
    else if (["optional", "repeat", "recurrence"].includes(selectedKind)) {
      const body = nodeBody(selected), key = selectedKind === "optional" ? [...selectedIndex, "optional"] : [...selectedIndex, selectedKind, "body"];
      if (Array.isArray(body)) body.push(next); else setPath(message, key, body === undefined ? [next] : [body, next]);
    } else {
      const parent = pathValue(message, selectedIndex.slice(0, -1)), key = selectedIndex[selectedIndex.length - 1];
      if (Array.isArray(parent)) parent.splice(key + 1, 0, next); else setPath(message, selectedIndex, [selected, next]);
    }
    selectNodeObject(message, next);
  });
}
function guidedAddIndex() { guidedAddElement("field"); }
async function guidedImportSchema(event) {
  const file = event.target.files[0]; if (!file) return;
  try {
    if (file.size > 16 * 1024 * 1024) throw new Error("Schema exceeds 16 MiB.");
    let text;
    try { text = await file.text(); }
    catch { throw new Error("Could not read the selected schema file. Choose the file again."); }
    const document = parseJSON(text);
    if (document.format !== "vmf-schema/1" || !Array.isArray(document.messages)) throw new Error("Choose a native vmf-schema/1 definition.");
    const existing = draftSchemas().find(schema => canonical(schema.document) === canonical(document));
    if (existing) {
      selectedSchema = existing.id; selectedMessage = selectedIndex = null;
      renderSchemas(); renderSchemaEditor();
      message("This definition is already in your library. Selected " + existing.id + ". Your mappings are unchanged.");
    } else {
      const id = uniqueSchemaName(file.name.replace(/\.json$/i, "") || "payload");
      schemaChange("import schema", () => { workspace.schemas.push({id, document}); selectedSchema = id; selectedMessage = selectedIndex = null; schemaExplanation = ""; });
      message("Schema imported as " + id + ". Validation runs when the draft is saved.");
    }
  } catch (error) { message(error.message, true); }
  event.target.value = "";
}
function checkWorkspaceImport(document) {
  const fail = detail => { throw new Error("Invalid imported workspace: " + detail); };
  const properties = (value, keys, path) => {
    if (!isObject(value)) fail(path + " must be an object.");
    if (Object.keys(value).some(key => !keys.includes(key))) fail(path + " contains an unknown property.");
  };
  properties(document, ["format", "schemas", "outputs"], "workspace");
  for (const collection of ["schemas", "outputs"]) {
    const entries = document[collection], ids = new Set();
    if (!Array.isArray(entries) || entries.length > 128) fail(collection + " must be an array with at most 128 entries.");
    entries.forEach((entry, index) => {
      const path = collection + "/" + index;
      properties(entry, collection === "schemas" ? ["id", "document"] : ["id", "enabled", "mapping"], path);
      if (typeof entry.id !== "string" || !entry.id || entry.id.includes("\0") || new TextEncoder().encode(entry.id).length > 128) fail(path + "/id must be nonempty text of at most 128 UTF-8 bytes without NUL.");
      if (ids.has(entry.id)) fail(path + "/id duplicates " + entry.id + ".");
      ids.add(entry.id);
      if (collection === "schemas" && !isObject(entry.document)) fail(path + "/document must be a native schema object.");
      if (collection === "outputs" && (typeof entry.enabled !== "boolean" || !isObject(entry.mapping))) fail(path + " requires a boolean enabled and an object mapping.");
    });
  }
}
async function guidedImportMapping(event) {
  const file = event.target.files[0], targetId = selectedOutput;
  if (!file || importingMapping) { event.target.value = ""; return; }
  importingMapping = true;
  $("import-mapping-button").disabled = true;
  try {
    if (file.size > 16 * 1024 * 1024) throw new Error("Mapping file exceeds 16 MiB.");
    let text;
    try { text = await file.text(); }
    catch { throw new Error("Could not read the selected mapping file. Choose the file again."); }
    const document = parseJSON(text);
    if (!isObject(document) || !["cot-vmf-mapping-config/1", "cot-vmf-workspace/1"].includes(document.format)) throw new Error("Choose a cot-vmf-mapping-config/1 mapping or cot-vmf-workspace/1 workspace.");
    const wholeWorkspace = document.format === "cot-vmf-workspace/1";
    let candidate, output;
    if (wholeWorkspace) {
      checkWorkspaceImport(document);
      candidate = {...document, outputs: document.outputs.map(item => ({...item, enabled: false}))};
    } else {
      const existing = draftOutputs().find(item => item.id === targetId);
      if (targetId && !existing) throw new Error("The selected output was removed. Select an output and import again.");
      if (!existing && workspace.outputs.length >= 128) throw new Error("A workspace can contain at most 128 outputs.");
      let id = existing?.id;
      if (!id) do { id = uid("output"); } while (draftOutputs().some(item => item.id === id));
      output = {id, enabled: false, mapping: document};
      candidate = {...workspace, outputs: existing ? workspace.outputs.map(item => item === existing ? output : item) : [...workspace.outputs, output]};
    }
    // Reserve the largest revision so a concurrent save cannot exceed the
    // HTTP body limit by increasing the number of revision digits.
    if (new TextEncoder().encode(json({revision: 18446744073709551615n, workspace: candidate})).length > 16 * 1024 * 1024) throw new Error("Imported workspace exceeds the 16 MiB request limit.");
    workspace = candidate;
    cancelPendingConnection();
    selectedWire = pendingMessage = null;
    if (wholeWorkspace) {
      selectedSchema = selectedMessage = selectedIndex = null;
      selectedOutput = workspace.outputs[0]?.id ?? null;
      resetSchemaHistory();
      expandedProperties.clear();
      state.catalog = {...state.catalog, schemas: []};
    } else {
      selectedOutput = output.id;
      for (const entry of schemaUndoHistory) entry.outputChanges = entry.outputChanges.filter(change => change.id !== output.id);
    }
    changed(); render();
    message(wholeWorkspace ? "Workspace replaced. Imported outputs have Send off; review them before enabling." : "Mapping imported into " + output.id + " with Send off. Review it before enabling.");
  } catch (error) { message(error.message, true); }
  finally {
    importingMapping = false;
    $("import-mapping-button").disabled = false;
    event.target.value = "";
  }
}
function guidedDeleteSchema() {
  if (!selectedSchema) return;
  schemaChange("delete schema and its outputs", () => {
    workspace.outputs = workspace.outputs.filter(item => item.mapping?.schema !== selectedSchema);
    workspace.schemas = workspace.schemas.filter(item => item.id !== selectedSchema);
    selectedSchema = selectedMessage = selectedIndex = selectedWire = selectedOutput = null;
  });
}

function canonical(value) {
  if (!value || typeof value !== "object") return json(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
}
function messageOutputs(schema, message) {
  return draftOutputs().filter(output => output.mapping?.schema === schema && output.mapping?.message === message.ordinal);
}
function activeOutput() {
  const wireOutput = selectedWire?.slice(0, selectedWire.lastIndexOf(":"));
  return draftOutputs().find(output => output.id === selectedOutput || output.id === wireOutput);
}
function outputFor(schema, message) {
  const outputs = messageOutputs(schema, message), active = activeOutput();
  return outputs.includes(active) ? active : outputs.length === 1 ? outputs[0] : null;
}
function outputMessage(output) {
  if (!Number.isInteger(output?.mapping?.message) || output.mapping.message < 0) return undefined;
  return catalogSchema(output.mapping.schema)?.messages?.find(message => message.ordinal === output.mapping.message);
}
function outputVariant(output) { return outputMessage(output)?.profiles?.[output.mapping?.envelope]; }
function outputReady(output) { return envelopeProfiles.includes(output.mapping?.envelope) && outputVariant(output)?.available === true; }
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
  selectedOutput = id; selectedWire = null; pendingMessage = null;
  renderOutputs(); renderMappingEditor(); scheduleWires();
}
function inspectMessage(schema, message) {
  const existing = outputFor(schema, message);
  if (existing) return selectOutput(existing.id);
  if (!messageOutputs(schema, message).length) {
    const output = createOutput(schema, message); changed(); return selectOutput(output.id);
  }
  selectedOutput = selectedWire = null; pendingMessage = {schema, ordinal: message.ordinal};
  renderOutputs(); renderMappingEditor();
}
function createOutput(schema, message) {
  const output = {id: uid("output"), enabled: false, mapping: {format: "cot-vmf-mapping-config/1", schema, message: message.ordinal, fields: []}};
  workspace.outputs.push(output); return output;
}
function ensureOutput(schema, message) {
  const output = outputFor(schema, message);
  if (output) return output;
  if (messageOutputs(schema, message).length) {
    pendingMessage = {schema, ordinal: message.ordinal}; selectedOutput = selectedWire = null;
    renderOutputs(); renderMappingEditor();
    messageNotice("Choose an output for this message before connecting another field.");
    return null;
  }
  return createOutput(schema, message);
}
function messageNotice(text) { $("toast").hidden = false; $("toast").textContent = text; $("toast").classList.remove("error"); }
function mappingTarget(field) { return {key: field.key}; }
function refMatches(reference, field) { return isObject(reference) && typeof reference.key === "string" && reference.key === field.key; }
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
function updatePendingConnection() {
  document.querySelectorAll(".source-port").forEach(node => {
    const armed = node.dataset.sourcePath === armedSource;
    node.classList.toggle("armed", armed);
    node.setAttribute("aria-pressed", String(armed));
  });
  $("connection-instructions").textContent = armedSource
    ? armedSource + " → Choose a VMF target. Escape cancels."
    : "Drag a source port to a target, or click a source then a target.";
  scheduleWires();
}
function cancelPendingConnection() {
  if (pointerGesture) suppressPointerClick = true;
  armedSource = dragging = pointerGesture = pointerPosition = null;
  updatePendingConnection();
}
function selectSource(source, event) {
  armedSource = armedSource === source.path ? null : source.path;
  if (armedSource) {
    const dot = event.currentTarget.querySelector(".port-dot").getBoundingClientRect();
    pointerPosition = event.detail ? {x: event.clientX, y: event.clientY}
      : {x: dot.right + 45, y: dot.y + dot.height / 2};
    const output = activeOutput();
    selectedWire = null; selectedOutput = output?.id || null;
    renderOutputs(); renderMappingEditor();
  } else pointerPosition = null;
  updatePendingConnection();
}
function connectTarget(port) {
  const schema = catalogSchema(port.dataset.schemaId);
  const msg = schema?.messages.find(item => String(item.ordinal) === port.dataset.messageOrdinal);
  const field = msg?.fields.find(item => item.index === port.dataset.targetIndex);
  if (armedSource && field?.mappable) return connect(armedSource, schema.id, msg, field);
  return false;
}
function connect(sourcePath, schemaId, msg, field) {
  const output = ensureOutput(schemaId, msg);
  if (!output) return false;
  if (["fields", "vmf_constants"].some(key => output.mapping[key] !== undefined && !Array.isArray(output.mapping[key]))) {
    selectOutput(output.id);
    message("Repair the mapping collections in this output before adding connections.", true); return false;
  }
  const matches = binding => isObject(binding) && refMatches(binding.vmf, field) && (!Array.isArray(binding.occurrences) || !binding.occurrences.length);
  if ((output.mapping.fields || []).some(matches) || (output.mapping.vmf_constants || []).some(matches)) {
    message("This target already has a value. Select its wire to edit it, or use occurrence selectors for repeated fields."); return false;
  }
  const binding = {cot: sourcePath, vmf: mappingTarget(field)};
  if (field.repeats?.length) binding.occurrences = field.repeats.map(repeat => ({repeat: repeat.repeat, index: 0}));
  (output.mapping.fields ||= []).push(binding);
  selectedWire = output.id + ":" + (output.mapping.fields.length - 1); selectedOutput = null; armedSource = null;
  cancelPendingConnection();
  message(""); changed(); renderMapping(); renderMappingEditor();
  return true;
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
    toggle.disabled = !output.enabled && !outputReady(output);
    toggle.addEventListener("change", () => { output.enabled = toggle.checked; changed(); renderMapping(); });
    enable.append(toggle, "Send"); row.append(select, enable);
    row.append(el("small", "output-profile", output.mapping?.envelope || "Choose envelope"));
    if (!outputMessage(output)) row.append(el("span", "output-unresolved", "Unresolved reference"));
    else if (output.mapping?.envelope && !outputVariant(output)?.available) row.append(el("span", "output-unresolved", "Envelope unavailable"));
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
    const port = button("", event => { if (source.mappable) selectSource(source, event); }, "source-port" + (activeFields.has(Number(source.id)) ? " live" : ""));
    port.dataset.sourceId = source.id; port.dataset.sourcePath = source.path; port.classList.toggle("armed", armedSource === source.path);
    const copy = el("span", "port-copy"); copy.append(el("span", "field-path", source.path), el("span", "field-meta", source.type + (source.unit && source.unit !== "none" ? " · " + source.unit : "") + (source.mappable ? "" : " · presence only")));
    port.append(copy, el("span", "port-dot"));
    port.addEventListener("pointerdown", event => {
      if (!source.mappable || event.button !== 0) return;
      pointerGesture = {source: source.path, id: event.pointerId,
        x: event.clientX, y: event.clientY, previous: armedSource, moved: false};
      dragging = source.path; pointerPosition = {x: event.clientX, y: event.clientY};
      scheduleWires();
    });
    const row = el("div", "source-field-row");
    const help = helpButton(source.path, cotFieldHelp[source.path]);
    help.dataset.sourceHelp = source.path;
    row.append(port, help); sources.append(row);
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
      const addOutput = button("+ Output", () => { const next = createOutput(schema.id, msg); changed(); renderOutputs(); selectOutput(next.id); }, "text-button");
      addOutput.setAttribute("aria-label", "Add output for " + schema.id + " message " + msg.ordinal);
      heading.append(title, addOutput); box.append(heading);
      for (const field of msg.fields || []) {
        if (!field.mappable || !field.key) continue;
        const port = button("", () => {
          if (armedSource && field.mappable) connect(armedSource, schema.id, msg, field);
          else inspectMessage(schema.id, msg);
        }, "target-port");
        port.dataset.schemaId = schema.id; port.dataset.messageOrdinal = msg.ordinal; port.dataset.targetIndex = field.index; port.dataset.targetKey = field.key;
        port.dataset.mappable = field.mappable ? "true" : "false";
        const copy = el("span", "port-copy"); copy.append(el("span", "field-path", field.key), el("span", "field-meta", field.bits + " bits · " + field.kind + (field.mappable ? "" : " · structural") + (field.repeats?.length ? " · repeated" : "")));
        port.append(el("span", "port-dot"), copy);
        port.addEventListener("focus", () => {
          if (!armedSource) return;
          const dot = port.querySelector(".port-dot").getBoundingClientRect();
          pointerPosition = {x: dot.x + dot.width / 2, y: dot.y + dot.height / 2};
          scheduleWires();
        });
        box.append(port);
      }
      const tools = el("div", "output-tools"); tools.append(button("Header & controls", () => inspectMessage(schema.id, msg), "text-button")); box.append(tools); targets.append(box);
    }
  }
  if (armedSource && ![...sources.querySelectorAll(".source-port")].some(node => node.dataset.sourcePath === armedSource)) cancelPendingConnection();
  renderFeedback(); updatePendingConnection();
}
function scheduleWires() { if (!wireFrame) wireFrame = requestAnimationFrame(() => { wireFrame = null; drawWires(); }); }
function drawWires() {
  const canvas = $("mapping-canvas"), svg = $("wires"), rect = canvas.getBoundingClientRect();
  const existing = new Map([...svg.querySelectorAll(".wire")].map(node => [node.dataset.wireId, node]));
  svg.querySelector(".drag-wire")?.remove();
  svg.setAttribute("width", canvas.scrollWidth); svg.setAttribute("height", canvas.scrollHeight);
  const endpoint = node => { const dot = node?.querySelector(".port-dot")?.getBoundingClientRect(); return dot ? {x: dot.x + dot.width / 2 - rect.x, y: dot.y + dot.height / 2 - rect.y} : null; };
  const visible = node => {
    const bounds = node?.parentElement?.closest("#source-fields, #target-fields")?.getBoundingClientRect();
    const item = node?.getBoundingClientRect();
    return bounds && item && item.bottom > bounds.top && item.top < bounds.bottom;
  };
  function path(a, b, className, previous) {
    const node = previous || document.createElementNS("http://www.w3.org/2000/svg", "path"), reach = Math.max(45, (b.x - a.x) * .5);
    node.setAttribute("d", `M ${a.x},${a.y} C ${a.x + reach},${a.y} ${b.x - reach},${b.y} ${b.x},${b.y}`); node.setAttribute("class", className); if (!previous) svg.append(node); return node;
  }
  for (const wire of wireRecords()) {
    const source = [...document.querySelectorAll(".source-port")].find(node => node.dataset.sourcePath === wire.binding.cot);
    const target = [...document.querySelectorAll(".target-port")].find(node => node.dataset.schemaId === wire.schema && node.dataset.messageOrdinal === String(wire.message.ordinal) && node.dataset.targetIndex === wire.field.index);
    const a = endpoint(source), b = endpoint(target);
    if (!a || !b) continue;
    const live = source.classList.contains("live");
    const previous = existing.get(wire.id);
    existing.delete(wire.id);
    const node = path(a, b, "wire" + (selectedWire === wire.id ? " selected" : "") + (live ? " live" : "") + (wireHasDiagnostic(wire) ? " diagnostic-wire" : ""), previous); node.dataset.wireId = wire.id;
    node.setAttribute("visibility", visible(source) && visible(target) ? "visible" : "hidden");
    node.setAttribute("role", "button"); node.setAttribute("tabindex", "0"); node.setAttribute("aria-label", wire.binding.cot + " to " + wire.field.key);
    node.setAttribute("aria-pressed", String(selectedWire === wire.id));
    if (!previous) {
      const select = () => { cancelPendingConnection(); selectedWire = node.dataset.wireId; selectedOutput = null; renderOutputs(); renderMappingEditor(); scheduleWires(); };
      node.addEventListener("click", select); node.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(); } });
    }
    if (live) target.classList.add("live");
  }
  existing.forEach(node => node.remove());
  if ((dragging || armedSource) && pointerPosition) {
    const source = [...document.querySelectorAll(".source-port")].find(node => node.dataset.sourcePath === (dragging || armedSource)), a = endpoint(source);
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
    target.append(el("div", "selected-target", wire.binding.cot + " → " + wire.field.key), editor(wire.binding, bindingSpec, next => { wire.output.mapping.fields[wire.index] = next; }, "", "wire/" + wire.id), button("Remove connection", removeSelectedConnection, "button wide-button danger"));
    return;
  }
  const output = draftOutputs().find(item => item.id === selectedOutput);
  if (output) {
    $("mapping-inspector-title").textContent = "Message output";
    const profile = output.mapping?.envelope;
    if (isObject(output.mapping)) {
      const row = el("div", "property output-envelope"), label = el("label", "property-label", "Envelope"), choice = el("select");
      label.append(helpButton("envelope", mappingPropertyHelp.envelope));
      choice.dataset.property = "envelope"; choice.setAttribute("aria-label", "Output envelope");
      choice.add(new Option("Choose envelope…", ""));
      for (const name of envelopeProfiles) {
        const variant = outputMessage(output)?.profiles?.[name];
        const option = new Option(name + (variant?.available ? "" : " · unavailable"), name);
        option.disabled = !variant?.available && profile !== name;
        choice.add(option);
      }
      if (profile !== undefined && !envelopeProfiles.includes(profile)) choice.add(new Option("Saved selection: " + String(profile), String(profile)));
      choice.value = profile === undefined ? "" : String(profile);
      choice.addEventListener("change", () => {
        if (choice.value) output.mapping.envelope = choice.value;
        else { delete output.mapping.envelope; output.enabled = false; }
        changed(); renderMapping(); renderMappingEditor();
      });
      row.append(label, choice); target.append(row);
      const variant = outputVariant(output);
      if (variant?.available) {
        const preview = el("details", "derived-header");
        preview.open = true;
        preview.append(el("summary", "", "Derived message identity"), el("pre", "derived-identity", json(variant.identity, true)));
        target.append(preview);
      } else target.append(el("p", "schema-invalid", profile ? variant?.diagnostic || "This envelope is unavailable for the selected message." : "Choose an envelope before enabling this output."));
    }
    const spec = object({format: enumeration("cot-vmf-mapping-config/1"), name: text, schema: text, message: integer, envelope: enumeration(...envelopeProfiles), vmf_header: headerSpec(profile), fields: array(bindingSpec), vmf_constants: array(constantSpec), presence: array(object({group: integer, occurrences: array(occurrenceSpec), present: boolean}, ["group", "present"])), repeat_counts: array(object({repeat: integer, occurrences: array(occurrenceSpec), count: integer}, ["repeat", "count"]))});
    spec.hidden = ["envelope"]; spec.refreshOn = ["schema", "message"];
    target.append(el("p", "property-help", "The schema, message ordinal, and chosen envelope determine the read-only identity. Header metadata is optional. Constants use raw VMF values."), editor(output.mapping, spec, next => { output.mapping = next; }, "", "output/" + output.id), button("Remove output", () => { workspace.outputs.splice(workspace.outputs.indexOf(output), 1); selectedOutput = pendingMessage = null; changed(); renderMapping(); renderMappingEditor(); }, "button wide-button danger"));
    return;
  }
  if (pendingMessage) {
    const payload = catalogSchema(pendingMessage.schema)?.messages?.find(item => item.ordinal === pendingMessage.ordinal);
    if (payload) {
      $("mapping-inspector-title").textContent = "Choose an output";
      target.append(el("p", "property-help", "Several outputs use this payload. Select the one to edit or connect."));
      for (const item of messageOutputs(pendingMessage.schema, payload)) target.append(button(outputLabel(item) + " · " + (item.mapping?.envelope || "Choose envelope"), () => selectOutput(item.id), "button wide-button"));
      target.append(button("+ Add output", () => { const next = createOutput(pendingMessage.schema, payload); changed(); renderOutputs(); selectOutput(next.id); }, "button wide-button"));
      return;
    }
    pendingMessage = null;
  }
  $("mapping-inspector-title").textContent = "Make a connection";
  target.append(el("p", "empty-hint", "Drag a CoT source port to a VMF field, or select the two ports. Choose an output when a payload has several. New outputs remain disabled until you choose an envelope and enable them."));
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
  if (name !== "mapping") cancelPendingConnection();
  document.querySelectorAll("[data-tab]").forEach(node => node.classList.toggle("selected", node.dataset.tab === name));
  $("mapping-page").hidden = workspaceNeedsRepair() || name !== "mapping"; $("schemas-page").hidden = workspaceNeedsRepair() || name !== "schemas";
  $("page-title").textContent = name === "mapping" ? "Connect the fields." : "Define your payloads.";
  $("page-description").textContent = name === "mapping" ? "Connect the data your message needs. Saved edits are tested with incoming CoT." : "Build your payload in wire order. Nest optional and repeating fields or groups.";
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
document.addEventListener("pointerdown", () => { suppressPointerClick = false; }, true);
document.addEventListener("click", event => {
  if (!suppressPointerClick || !event.detail) return;
  suppressPointerClick = false; event.preventDefault(); event.stopImmediatePropagation();
}, true);
document.addEventListener("pointermove", event => {
  if (pointerGesture && event.pointerId === pointerGesture.id
      && Math.hypot(event.clientX - pointerGesture.x, event.clientY - pointerGesture.y) >= 4) pointerGesture.moved = true;
  if (dragging || armedSource) { pointerPosition = {x: event.clientX, y: event.clientY}; scheduleWires(); }
});
document.addEventListener("pointerup", event => {
  if (!pointerGesture || event.pointerId !== pointerGesture.id) return;
  const gesture = pointerGesture;
  pointerGesture = dragging = null;
  if (gesture.moved) {
    armedSource = gesture.source;
    suppressPointerClick = true;
    const port = document.elementFromPoint(event.clientX, event.clientY)?.closest(".target-port");
    if (port) connectTarget(port);
  }
  if (!armedSource) pointerPosition = null;
  updatePendingConnection();
});
document.addEventListener("pointercancel", () => {
  if (pointerGesture) armedSource = pointerGesture.previous;
  dragging = pointerGesture = null;
  if (!armedSource) pointerPosition = null;
  updatePendingConnection();
});
document.addEventListener("keydown", event => {
  if (event.key !== "Escape") return;
  if (armedSource || dragging || selectedWire) event.preventDefault();
  cancelPendingConnection();
  if (selectedWire) {
    selectedWire = null;
    renderOutputs(); renderMappingEditor(); scheduleWires();
  }
});
document.addEventListener("keydown", event => {
  if (event.key !== "Delete" || event.defaultPrevented || event.isComposing
      || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey
      || $("mapping-page").hidden
      || event.target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])")) return;
  if (removeSelectedConnection()) event.preventDefault();
});
$("add-schema").addEventListener("click", guidedAddSchema);
$("add-message").addEventListener("click", guidedAddMessage);
$("add-index").addEventListener("click", guidedAddIndex);
$("add-group").addEventListener("click", () => guidedAddElement("group"));
$("import-schema").addEventListener("change", guidedImportSchema);
$("import-mapping-button").addEventListener("click", () => $("import-mapping").click());
$("import-mapping").addEventListener("change", guidedImportMapping);
$("export-schema").addEventListener("click", () => { const schema = schemaById(selectedSchema); if (schema) download(schema.id + ".json", schema.document); });
$("delete-schema").addEventListener("click", guidedDeleteSchema);
$("reload").addEventListener("click", async () => {
  if (saving) return;
  try { clearTimeout(saveTimer); state = await request("/api/state"); workspace = state.draft; resetSchemaHistory(); generation = savedGeneration = 0; selectedWire = selectedOutput = pendingMessage = null; message(""); status(); render(); } catch (error) { message(error.message, true); }
});
attachStaticHelp();
document.querySelector(".mapping-toolbar strong").after(helpButton(
  "Translation map",
  "Drag a CoT source to a VMF target, or click a source and then a target. The dashed wire follows your pointer while a connection is pending. Escape cancels pending connections and clears wire selection. Select a wire to edit its conversion or press Delete to remove it."
));
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
