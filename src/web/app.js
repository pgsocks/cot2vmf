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
  format: "The native document format identifier. Payload definitions use vmf-schema/1.",
  envelope: "The VMF envelope profile. This choice determines which standard versions and header properties are valid.",
  message_standard: "A named standard edition. It is an alternative to a raw standard_version at this level; a message-level selection replaces the schema-level selection.",
  standard_version: "An exact raw standard-version code, or absent where the profile permits it. It is an alternative to message_standard, not an automatic latest-version choice.",
  message_number: "The VMF K-series message number, such as K01.1. Standard-version and subtype presence also participate in the exact message identity.",
  messages: "The message definitions supplied by this schema. The application does not supply assigned operational layouts.",
  subtype: "The optional exact message subtype. Present zero and an absent subtype are different identities.",
  indexes: "Fields and structural indicators in wire order. Array order determines encoding order; index numbers do not sort the definitions.",
  index_number: "The field's numeric index address, such as 3.1. Numeric addresses with and without a trailing dot identify the same index.",
  number_of_bits: "The fixed wire width, or the finite capacity for a variable field. Width alone does not enable text or variable-length encoding.",
  key: "An optional application binding key, unique within this message, which a mapping can use instead of the numeric index.",
  encode_type: "The kind of value encoded by the field. This choice determines which representation, text, length and scale properties apply.",
  indicator: "A structural control: FPI controls one field's presence, GPI a group's presence, and FRI/GRI a repeated field or group. Indicators are one bit and are not ordinary mapping targets.",
  target: "The field index controlled by FPI, or group ID controlled by GPI. The indicator must immediately precede its target in the logical sequence.",
  group_code: "The field's group membership path, such as G1/G2. Group membership adds no wire bits by itself.",
  repeat_code: "The repeat membership path, such as R1/R2. An FRI or GRI controller also declares a finite maximum, for example R1(4).",
  representation: "The integer bit representation. Signed fields need an explicit compatible signed representation.",
  bit_order: "The logical significance of bits within the field. This is independent of the message's physical octet packing.",
  octet_order: "The message's physical octet packing order, independent of individual field bit significance. Overrides do not add alignment padding.",
  text_encoding: "The encoding of text on the wire. Text capacity must be divisible by the encoding's seven- or eight-bit code-unit width.",
  length_from: "An earlier scalar field that supplies this field's length in wire units. The reference must be available in the same or an enclosing scope.",
  length_bias: "A checked signed adjustment to the length read from length_from. This property applies only when length_from is selected.",
  when: "A condition over preceding scalar raw codes that determines whether this field is active.",
  mode: "Require all condition terms to match, or at least one term to match.",
  negate: "Invert this condition or condition term's result.",
  terms: "The nonempty collection of raw-code tests that make up this condition.",
  field: "The earlier scalar index tested by this condition term. Future or unavailable fields cannot supply its value.",
  values: "Inclusive raw-code intervals that satisfy this condition term.",
  mask: "An optional raw-bit mask applied for this condition term. Omitting it uses all raw bits.",
  allowed: "Disjoint inclusive intervals of permitted raw wire codes. These remain raw-code constraints for signed and scaled fields.",
  first: "The first included raw code in this interval.",
  last: "The last included raw code in this interval.",
  constant: "A required raw scalar code. This constrains a supplied value; it does not automatically supply a value to an output.",
  scale: "Exact rational factor and bias describing physical_value = raw_code × factor + bias. Scaled fields require this metadata.",
  factor: "The exact rational multiplier used by this field's scale.",
  bias: "The exact rational offset used by this field's scale, or the checked signed adjustment to a scalar repeat count.",
  numerator: "The signed numerator of this exact rational value.",
  denominator: "The unsigned, nonzero denominator of this exact rational value.",
  sentinels: "Raw codes reserved as scale sentinel values, rather than ordinary physical measurements.",
  repeats: "Message-level declarations for fixed or preceding-scalar repeats. A repeat cannot also have an FRI/GRI controller.",
  count: "The fixed number of occurrences. Zero is valid for a fixed repeat.",
  count_from: "An earlier scalar field that supplies the occurrence count. Its value is supplied normally and is not backpatched by the encoder.",
  maximum: "The finite maximum permitted occurrence count for this repeat.",
  minimum: "The minimum permitted count for a scalar-count repeat.",
};

const mappingPropertyHelp = {
  format: "The native mapping format identifier. Outputs use cot-vmf-mapping-config/1.",
  name: "An optional human-readable name for this output mapping.",
  schema: "The workspace schema ID containing this output's message definition. It is not a filesystem path.",
  cot: "The canonical CoT source path. Only standard individually mappable catalog fields can supply a connection.",
  vmf: "The target VMF field, selected by a unique key or a numeric index within this output's exact message.",
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
  vmf_header: "The native VMF envelope header. Its exact message identity chooses the payload definition; absent version or subtype values are not wildcards.",
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
    mapping: "The output's schema reference, exact header identity, and field mappings.",
  }[key];
  if (path.startsWith("workspace/")
      && !/^workspace\/outputs\/\d+\/mapping(?:\/|$)/.test(path)) return undefined;
  if (key === "fields" && path.includes("vmf_header"))
    return "The native envelope header fields, including its addresses and exact message identity.";
  if (key === "messages" && path.includes("vmf_header"))
    return "Native message header descriptors. An output selects exactly one payload message identity.";
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
      name.append(el("code", "", key));
      const description = propertyHelp(key, path);
      if (description) name.append(helpButton(key, description));
      name.append(button("×", () => { delete value[key]; changed(); renderEditors(); }, "remove-property"));
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
// Payload authoring keeps native documents exact and UI state outside them.
const schemaUndoHistory = [];
const schemaSteps = new Map();
const schemaStepReach = new Map();
let schemaExplanation = "";
const guidedOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const guidedLabel = key => key.replace(/_/g, " ").replace(/^./, char => char.toUpperCase());
const guidedControllerKeys = ["indicator", "encode_type", "representation", "text_encoding", "length_from"];
const guidedScalarTypes = ["default", "bool", "unsigned", "signed", "enum", "scaled"];
const guidedStandardNames = {
  C: ["MIL-STD-6017", "MIL-STD-6017A", "MIL-STD-6017B", "MIL-STD-6017C", "TIDP-TE-R2", "TIDP-TE-R3", "TIDP-TE-R4", "TIDP-TE-R5", "TIDP-TE-R6", "TIDP-TE-R7"],
  D: ["MIL-STD-6017", "MIL-STD-6017A", "MIL-STD-6017B", "MIL-STD-6017C", "MIL-STD-6017D", "MIL-STD-6017E", "TIDP-TE-R2", "TIDP-TE-R3", "TIDP-TE-R4", "TIDP-TE-R5", "TIDP-FTE-R6"]
};
function resetSchemaHistory() {
  schemaUndoHistory.length = 0; schemaSteps.clear(); schemaStepReach.clear(); schemaExplanation = "";
}
function schemaSelection() {
  return {schema: selectedSchema, message: selectedMessage, index: selectedIndex};
}
function schemaChange(label, action, refresh = true) {
  const before = clone(workspace.schemas), selection = schemaSelection();
  const steps = [...schemaSteps], reach = [...schemaStepReach];
  const outputs = draftOutputs().map((entry, index) => ({entry, index}));
  action();
  if (json(before) === json(workspace.schemas)) return false;
  const removedOutputs = outputs.filter(({entry}) => !workspace.outputs.includes(entry))
    .map(({entry, index}) => ({entry: clone(entry), index}));
  schemaUndoHistory.push({label, schemas: before, selection, removedOutputs, steps, reach});
  changed();
  if (refresh) render();
  else { renderSchemas(); updateSchemaUndo(); scheduleWires(); }
  return true;
}
function updateSchemaUndo() {
  const node = $("schema-undo");
  if (!node) return;
  const entry = schemaUndoHistory[schemaUndoHistory.length - 1];
  node.disabled = !entry;
  node.textContent = entry ? "Undo: " + entry.label : "Undo";
}
function undoSchemaChange() {
  if ($("schema-editor").contains(document.activeElement)) document.activeElement.blur();
  const entry = schemaUndoHistory.pop(); if (!entry) return;
  const restored = new Set(entry.schemas.map(schema => schema.id));
  const removed = new Set(draftSchemas().filter(schema => !restored.has(schema.id)).map(schema => schema.id));
  workspace.outputs = draftOutputs().filter(output => !removed.has(output.mapping?.schema));
  for (const {entry: output, index} of entry.removedOutputs) {
    if (!workspace.outputs.some(current => current.id === output.id)) workspace.outputs.splice(Math.min(index, workspace.outputs.length), 0, clone(output));
  }
  workspace.schemas = clone(entry.schemas);
  selectedSchema = entry.selection.schema;
  selectedMessage = entry.selection.message; selectedIndex = entry.selection.index;
  selectedWire = selectedOutput = null;
  schemaSteps.clear(); schemaStepReach.clear();
  for (const [key, value] of entry.steps) schemaSteps.set(key, value);
  for (const [key, value] of entry.reach) schemaStepReach.set(key, value);
  schemaExplanation = "Undid " + entry.label + ". Edits will be saved automatically.";
  changed(); render();
}
function guidedHelp(name, description) {
  return typeof helpButton === "function" ? helpButton(name, description) : el("span", "property-help", description);
}
function guidedNote(container, text) { container.append(el("p", "property-help", text)); }
function guidedRemove(owner, keys, removed) {
  for (const key of keys) if (guidedOwn(owner, key)) { delete owner[key]; removed.push(key); }
}
function guidedPruneStandard(owner, envelope, removed) {
  const names = envelope === "B" ? [] : guidedStandardNames[envelope === "C" ? "C" : "D"] || [];
  if (guidedOwn(owner, "message_standard") && !names.includes(owner.message_standard)) guidedRemove(owner, ["message_standard"], removed);
  if (guidedOwn(owner, "standard_version")) {
    const value = owner.standard_version;
    const valid = value === "absent" ? envelope === "B" || envelope === "C" : Number.isInteger(value) && value >= 0 && value <= (envelope === "C" ? 9 : 10) && envelope !== "B";
    if (!valid) guidedRemove(owner, ["standard_version"], removed);
  }
}
function guidedIndexKeys(field) {
  const keys = ["index_number", "number_of_bits", "key", "group_code", "repeat_code", "indicator"];
  const role = field.indicator || "none", type = field.encode_type || "default";
  if (role !== "none") {
    if (role === "fpi" || role === "gpi") keys.push("target");
    return keys;
  }
  keys.push("encode_type", "when");
  if (guidedScalarTypes.includes(type)) {
    keys.push("representation", "bit_order", "allowed", "constant");
    if (type === "scaled") keys.push("scale");
  } else if (["bits", "octets", "text", "literal"].includes(type)) {
    if (type !== "bits") keys.push("bit_order");
    if (type === "text" || type === "literal") keys.push("text_encoding");
    if (type !== "literal") {
      keys.push("length_from");
      if (guidedOwn(field, "length_from")) keys.push("length_bias");
    }
  }
  return keys;
}
function guidedPruneField(field, removed) {
  const known = Object.keys(indexSpec.properties), applicable = guidedIndexKeys(field);
  guidedRemove(field, known.filter(key => !applicable.includes(key)), removed);
  const role = field.indicator || "none", type = field.encode_type || "default";
  if (role !== "none") {
    if (field.number_of_bits !== 1) { field.number_of_bits = 1; removed.push("previous width (indicators use one bit)"); }
    if (field.target && ((role === "gpi") !== /^G/.test(field.target))) guidedRemove(field, ["target"], removed);
    return;
  }
  if (guidedScalarTypes.includes(type) && guidedOwn(field, "representation")) {
    const choices = type === "signed" ? ["twos_complement", "ones_complement", "sign_magnitude"] : type === "scaled" ? ["default", "unsigned", "twos_complement", "ones_complement", "sign_magnitude"] : ["default", "unsigned"];
    if (!choices.includes(field.representation)) guidedRemove(field, ["representation"], removed);
  }
  if (type === "scaled" && !field.scale) field.scale = {factor: {numerator: 1, denominator: 1}, bias: {numerator: 0, denominator: 1}};
  if (type === "bool" && field.number_of_bits !== 1) { field.number_of_bits = 1; removed.push("previous width (booleans use one bit)"); }
  if (type === "literal" && field.text_encoding && !["default", "ascii_7"].includes(field.text_encoding)) guidedRemove(field, ["text_encoding"], removed);
  if (guidedOwn(field, "number_of_bits")) {
    const width = field.number_of_bits, unit = type === "octets" ? 8 : type === "literal" || type === "text" && (!field.text_encoding || ["default", "ascii_7"].includes(field.text_encoding)) ? 7 : type === "text" ? 8 : 1;
    const valid = Number.isInteger(width) || typeof width === "bigint";
    if (valid && (BigInt(width) < 0n || BigInt(width) % BigInt(unit) || type === "bool" && BigInt(width) !== 1n || guidedScalarTypes.includes(type) && (BigInt(width) < BigInt(type === "signed" || ["twos_complement", "ones_complement", "sign_magnitude"].includes(field.representation) ? 2 : 1) || BigInt(width) > 64n) || !guidedScalarTypes.includes(type) && type !== "literal" && !field.length_from && BigInt(width) === 0n)) guidedRemove(field, ["number_of_bits"], removed);
  }
}
function guidedController(label, action) {
  const removed = [];
  schemaChange(label, () => { action(removed); schemaExplanation = removed.length ? "Removed settings incompatible with this choice: " + [...new Set(removed)].join(", ") + ". Use Undo to restore the previous choice and its settings." : ""; });
}
function guidedDefault(spec, key) {
  if (key === "scale") return {factor: {numerator: 1, denominator: 1}, bias: {numerator: 0, denominator: 1}};
  return initial(spec);
}
function guidedInteger(source) {
  if (!/^-?(?:0|[1-9]\d*)$/.test(source)) throw new Error("Enter an integer without decimals or exponents.");
  const value = parseJSON(source);
  if (BigInt(value) < -9223372036854775808n || BigInt(value) > 18446744073709551615n) throw new Error("Enter an integer in the native 64-bit range.");
  return value;
}
function guidedCheckInteger(key, next, owner, context) {
  const value = BigInt(next);
  const signed = ["numerator", "length_bias", "bias"].includes(key);
  if (!signed && value < 0n) throw new Error("Enter an unsigned integer.");
  if (signed && value > 9223372036854775807n) throw new Error("Enter a signed 64-bit integer.");
  if (key === "denominator" && value === 0n) throw new Error("Denominator must be nonzero.");
  if (key === "subtype" && value > 127n) throw new Error("Subtype must be between 0 and 127.");
  if (key === "number_of_bits") {
    const type = owner.encode_type || "default", role = owner.indicator || "none";
    if (role !== "none" && value !== 1n) throw new Error("Indicators use one bit.");
    if (type === "bool" && value !== 1n) throw new Error("Boolean fields use one bit.");
    if (guidedScalarTypes.includes(type) && (value < BigInt(type === "signed" || ["twos_complement", "ones_complement", "sign_magnitude"].includes(owner.representation) ? 2 : 1) || value > 64n)) throw new Error("Enter a scalar width between its representation minimum and 64 bits.");
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
  if (spec.kind === "object" || spec.kind === "array") {
    if (options.required && (spec.kind === "object" ? !isObject(current) : !Array.isArray(current))) row.dataset.requiredInvalid = "true";
    row.append(guidedValue(current, spec, next => { owner[key] = next; }, path + "/" + key, context));
    return row;
  }
  const validType = current === undefined || spec.kind === "enum" ? current === undefined || spec.kind !== "enum" || spec.values.includes(current) : spec.kind === "integer" ? (typeof current === "bigint" || Number.isSafeInteger(current)) : spec.kind === "boolean" ? typeof current === "boolean" : typeof current === "string";
  if (!validType) { if (options.required) row.dataset.requiredInvalid = "true"; row.append(guidedRepairValue(current, spec, next => { owner[key] = next; if (context.field === owner && guidedControllerKeys.includes(key)) guidedPruneField(owner, []); }, path + "/" + key, context)); return row; }
  let input;
  if (spec.kind === "enum") {
    input = el("select");
    if (current === undefined) input.add(new Option("Choose…", ""));
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
  if (current !== undefined && spec.kind === "integer") {
    try { guidedCheckInteger(key, guidedInteger(String(current)), owner, context); }
    catch (error) { input.setCustomValidity(error.message); }
  }
  input.addEventListener("input", () => input.setCustomValidity(""));
  input.addEventListener("change", () => {
    try {
      let next = spec.kind === "boolean" ? input.checked : spec.kind === "enum" ? spec.values.find(option => String(option) === input.value) : input.value;
      if (spec.kind === "integer") { next = guidedInteger(input.value); guidedCheckInteger(key, next, owner, context); }
      if (options.required && next === "") throw new Error("Enter " + guidedLabel(key).toLowerCase() + ".");
      if (key === "message_number" && !/^K(?:0?[0-9]|10)\.(?:[1-9]|[1-9][0-9]|1[01][0-9]|12[0-7])$/.test(next)) throw new Error("Enter a K-number with functional area 0–10 and message number 1–127, such as K01.1.");
      input.setCustomValidity("");
      if (options.controller) guidedController("change " + guidedLabel(key), removed => {
        owner[key] = next;
        if (options.setValue) options.setValue(next);
        if (key === "envelope") {
          guidedPruneStandard(owner, next, removed);
          for (const msg of Array.isArray(owner.messages) ? owner.messages : []) if (isObject(msg)) guidedPruneStandard(msg, next, removed);
        }
        if (context.field === owner && guidedControllerKeys.includes(key)) guidedPruneField(owner, removed);
        if (options.after) options.after(removed);
      });
      else schemaChange("change " + guidedLabel(key), () => { owner[key] = next; if (options.setValue) options.setValue(next); }, false);
    } catch (error) { input.setCustomValidity(error.message); input.reportValidity(); }
  });
  row.append(input); return row;
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
  const names = envelope === "B" ? [] : guidedStandardNames[envelope === "C" ? "C" : "D"] || [];
  const hasNamed = guidedOwn(owner, "message_standard"), hasRaw = guidedOwn(owner, "standard_version");
  const mode = hasNamed && hasRaw ? "conflict" : hasNamed ? "edition" : hasRaw ? owner.standard_version === "absent" ? "absent" : "raw" : "inherit";
  const row = el("div", "property"), select = el("select");
  select.setAttribute("aria-label", "Standard selection"); select.dataset.property = "standard_selection";
  select.add(new Option(isMessage ? "Inherit schema selection" : "No shared standard selection", "inherit"));
  if (envelope === "B" || envelope === "C") select.add(new Option("Explicitly absent", "absent"));
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
    const codes = Array.from({length: envelope === "C" ? 10 : envelope === "B" ? 0 : 11}, (_, index) => index);
    const control = guidedField(owner, "standard_version", {kind: "enum", values: codes}, path, {}, {required: true});
    // Native version codes are numbers, despite HTML option values being strings.
    const input = control.querySelector("select");
    if (input) input.addEventListener("change", () => { if (typeof owner.standard_version === "string" && /^\d+$/.test(owner.standard_version)) owner.standard_version = Number(owner.standard_version); });
    target.append(control);
  }
  if (mode === "conflict") guidedNote(target, "Choose one selection mechanism to replace these conflicting saved properties.");
  guidedNote(target, envelope === "B" ? "Envelope B carries no standard version." : envelope === "C" ? "C supports an absent version or codes 0–9." : "D and D1 require a resolved version for each message. Select a shared version or override it on every message.");
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
  if (spec === indexSpec) return guidedIndex(value, path, context);
  if (spec === repeatSpec) return guidedRepeat(value, path, context);
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
  node.append(guidedStepper(path, [
    {title: "Envelope", render: target => { guidedNote(target, "The envelope determines which standard selections and headers are valid."); target.append(guidedField(value, "envelope", schemaSpec.properties.envelope, path, {}, {required: true, controller: true})); target.append(guidedField(value, "format", schemaSpec.properties.format, path, {}, {required: true})); }},
    {title: "Standard", render: target => guidedStandard(target, value, path, value.envelope, false)},
    {title: "Messages", render: target => { guidedNote(target, "Use + Message and the outline to edit message identities, fields, and repeat definitions."); if (!Array.isArray(value.messages)) target.append(guidedField(value, "messages", schemaSpec.properties.messages, path, {}, {required: true})); else { guidedNote(target, value.messages.length + " message definitions."); guidedMalformedItems(target, value.messages, nativeMessageSpec, path + "/messages", {}); } }}
  ]));
  guidedRepairProperties(node, value, schemaSpec, Object.keys(schemaSpec.properties), path, {});
  return node;
}
function guidedMessage(value, path) {
  const node = el("div"), context = {message: value};
  node.append(guidedStepper(path, [
    {title: "Identity", render: target => { guidedFields(target, value, nativeMessageSpec, ["message_number", "subtype"], path, context); guidedStandard(target, value, path, selectedDefinition()?.envelope || "C", true); }},
    {title: "Packing", render: target => { guidedFields(target, value, nativeMessageSpec, ["octet_order"], path, context); guidedNote(target, "Use + Add field to message and the outline to define fields in wire order."); if (!Array.isArray(value.indexes)) target.append(guidedField(value, "indexes", nativeMessageSpec.properties.indexes, path, context, {required: true})); else guidedMalformedItems(target, value.indexes, indexSpec, path + "/indexes", context); }},
    {title: "Repeats", render: target => guidedFields(target, value, nativeMessageSpec, ["repeats"], path, context)}
  ]));
  guidedRepairProperties(node, value, nativeMessageSpec, Object.keys(nativeMessageSpec.properties), path, context);
  return node;
}
function guidedFixedBitWidth(target, value, indicator = false) {
  guidedNote(target, "This field uses a fixed width of one bit.");
  const valid = indicator ? !guidedOwn(value, "number_of_bits") || value.number_of_bits === 0 || value.number_of_bits === 1 : value.number_of_bits === 1;
  if (!valid) {
    const repair = el("div", "guided-repair"); repair.dataset.requiredInvalid = "true";
    repair.append(el("code", "repair-value", "Saved width: " + (json(value.number_of_bits) ?? "missing")), button("Use one-bit width", () => schemaChange("repair one-bit width", () => { value.number_of_bits = 1; })));
    target.append(repair);
  }
}
function guidedIndex(value, path, context) {
  const node = el("div"), role = value.indicator || "none", type = value.encode_type || "default";
  context = {...context, field: value};
  const stages = [{title: "Role & identity", render: target => {
    target.append(guidedField(value, "indicator", indexSpec.properties.indicator, path, context, {required: true, controller: true, defaultValue: "none"}));
    guidedFields(target, value, indexSpec, ["index_number", "key"], path, context);
  }}];
  if (role === "none") {
    stages.push({title: "Encoding", render: target => {
      target.append(guidedField(value, "encode_type", indexSpec.properties.encode_type, path, context, {required: true, controller: true, defaultValue: "default"}));
      if (guidedScalarTypes.includes(type)) {
        const values = type === "signed" ? ["twos_complement", "ones_complement", "sign_magnitude"] : type === "scaled" ? ["default", "unsigned", "twos_complement", "ones_complement", "sign_magnitude"] : ["default", "unsigned"];
        target.append(guidedField(value, "representation", {kind: "enum", values}, path, context, {required: type === "signed", controller: true}));
      }
      if (type === "text" || type === "literal") target.append(guidedField(value, "text_encoding", type === "literal" ? enumeration("default", "ascii_7") : indexSpec.properties.text_encoding, path, context, {controller: true}));
    }});
    stages.push({title: "Size & length", render: target => {
      if (["bits", "octets", "text"].includes(type)) target.append(guidedField(value, "length_from", text, path, context, {controller: true}));
      if (type === "bool") guidedFixedBitWidth(target, value);
      else target.append(guidedField(value, "number_of_bits", integer, path, context, {required: true}));
      if (value.length_from !== undefined && type !== "literal") target.append(guidedField(value, "length_bias", integer, path, context));
      if (type !== "bits") target.append(guidedField(value, "bit_order", order, path, context));
      guidedNote(target, type === "literal" || value.length_from !== undefined ? "Capacity is finite; zero capacity is allowed. Lengths use wire code units." : "Set the fixed wire width. Octets and text must contain whole wire code units.");
    }});
    stages.push({title: "Constraints", render: target => {
      if (guidedScalarTypes.includes(type)) guidedFields(target, value, indexSpec, ["allowed", "constant", ...(type === "scaled" ? ["scale"] : [])], path, context, type === "scaled" ? ["scale"] : []);
      else guidedNote(target, "Raw scalar ranges, constants, and scale do not apply to this encoding.");
    }});
    stages.push({title: "Structure & condition", render: target => guidedFields(target, value, indexSpec, ["group_code", "repeat_code", "when"], path, context)});
  } else {
    stages.push({title: "Controller", render: target => {
      guidedNote(target, "Indicators control structure rather than an ordinary mapped value.");
      guidedFixedBitWidth(target, value, true);
      if (role === "fpi" || role === "gpi") target.append(guidedField(value, "target", text, path, context, {required: true}));
      else { target.append(guidedField(value, "repeat_code", text, path, context, {required: true})); guidedNote(target, "Declare a finite positive maximum on the controlled repeat, for example R1(4)."); }
    }});
    stages.push({title: "Membership", render: target => guidedFields(target, value, indexSpec, role === "fpi" || role === "gpi" ? ["group_code", "repeat_code"] : ["group_code"], path, context)});
  }
  node.append(guidedStepper(path, stages));
  guidedRepairProperties(node, value, indexSpec, guidedIndexKeys(value), path, context);
  return node;
}
function guidedRepeat(value, path, context) {
  const node = el("div"), fixed = guidedOwn(value, "count") || !guidedOwn(value, "count_from");
  node.append(guidedStepper(path, [
    {title: "Count mechanism", render: target => {
      target.append(guidedField(value, "repeat_code", text, path, context, {required: true}));
      const select = el("select"); select.setAttribute("aria-label", "Repeat count mechanism"); select.add(new Option("Fixed count", "fixed")); select.add(new Option("Preceding scalar", "scalar")); select.value = fixed ? "fixed" : "scalar";
      select.addEventListener("change", () => guidedController("change repeat count mechanism", removed => {
        if (select.value === "fixed") { guidedRemove(value, ["count_from", "maximum", "minimum", "bias"], removed); value.count = 0; }
        else { guidedRemove(value, ["count"], removed); value.count_from = ""; value.maximum = 0; }
      }));
      const label = el("label", "property-label", "Count mechanism");
      label.append(helpButton("repeat count mechanism", "Use a fixed count, including zero, or read the count from an earlier scalar with explicit bounds. A declaration cannot also use an FRI or GRI controller."));
      target.append(label, select);
    }},
    {title: fixed ? "Fixed count" : "Source & bounds", render: target => guidedFields(target, value, repeatSpec, fixed ? ["count"] : ["count_from", "maximum", "minimum", "bias"], path, context, fixed ? ["count"] : ["count_from", "maximum"])}
  ]));
  guidedRepairProperties(node, value, repeatSpec, fixed ? ["repeat_code", "count"] : ["repeat_code", "count_from", "maximum", "minimum", "bias"], path, context);
  return node;
}
function guidedCondition(value, path, context) {
  const node = el("div");
  node.append(guidedStepper(path, [
    {title: "Match mode", render: target => guidedFields(target, value, conditionSpec, ["mode", "negate"], path, context)},
    {title: "Terms", render: target => {
      guidedNote(target, "Terms compare raw codes from preceding scalar fields. At least one term and one range per term are required. Native validation checks scope and ordering.");
      target.append(guidedConditionTerms(value, path, context));
    }}
  ]));
  guidedRepairProperties(node, value, conditionSpec, Object.keys(conditionSpec.properties), path, context);
  return node;
}
function guidedConditionTerms(value, path, context) {
  if (!Array.isArray(value.terms)) return guidedRepairValue(value.terms, conditionSpec.properties.terms, next => { value.terms = next; }, path + "/terms", context);
  const node = el("div", "guided-array"), spec = conditionSpec.properties.terms.item;
  value.terms.forEach((term, index) => {
    const row = el("section", "array-item"), termPath = path + "/terms/" + index;
    row.append(el("h4", "", "Term " + (index + 1)), button("Delete term", () => schemaChange("delete condition term", () => value.terms.splice(index, 1)), "text-button danger"));
    if (!isObject(term)) row.append(guidedRepairValue(term, spec, next => { value.terms[index] = next; }, termPath, context));
    else {
      row.append(guidedStepper(termPath, [
        {title: "Source", render: target => { target.append(guidedField(term, "field", text, termPath, context, {required: true})); guidedNote(target, "Enter the index of a preceding scalar, such as 1. Native validation checks that it is available in this scope."); }},
        {title: "Raw values", render: target => guidedFields(target, term, spec, ["values"], termPath, context)},
        {title: "Mask & negation", render: target => guidedFields(target, term, spec, ["mask", "negate"], termPath, context)}
      ]));
      guidedRepairProperties(row, term, spec, Object.keys(spec.properties), termPath, context);
    }
    node.append(row);
  });
  node.append(button("+ Add term", () => schemaChange("add condition term", () => value.terms.push({field: "", values: []}))));
  return node;
}
function renderSchemaEditor() {
  const target = $("schema-editor"), definition = selectedDefinition(); target.replaceChildren();
  const undo = button("Undo", undoSchemaChange, "button small schema-undo"); undo.id = "schema-undo";
  const history = el("div", "schema-history");
  history.append(undo, helpButton("schema Undo", "Restore the previous schema edit from this browser session. Unrelated Mapping edits are retained. Restoring a deleted schema restores its removed outputs; undoing schema creation removes outputs that depend on it. Reloading clears this history."));
  target.append(history); updateSchemaUndo();
  if (schemaExplanation) target.append(el("p", "guided-explanation", schemaExplanation));
  if (!definition) { $("schema-inspector-title").textContent = "Select a definition"; guidedNote(target, "Choose or create a schema. Undo restores schema edits from this editing session."); return; }
  let current = definition, spec = schemaSpec, title = "Schema properties", context = {};
  if (selectedMessage !== null) {
    current = definition.messages?.[selectedMessage]; spec = nativeMessageSpec; title = "Message properties";
    if (!current) { selectedMessage = selectedIndex = null; return renderSchemaEditor(); }
    context.message = current;
    if (selectedIndex !== null) { current = current.indexes?.[selectedIndex]; spec = indexSpec; title = "Field properties"; context.field = current; }
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
  target.append(guidedValue(current, spec, setCurrent, "schema/" + selectedSchema + "/" + selectedMessage + "/" + selectedIndex, context));
  if (selectedMessage !== null) {
    const actions = el("div", "button-row");
    if (selectedIndex !== null) {
      const up = button("Move field up", () => { if (selectedIndex) schemaChange("move field", () => { const fields = definition.messages[selectedMessage].indexes; [fields[selectedIndex - 1], fields[selectedIndex]] = [fields[selectedIndex], fields[selectedIndex - 1]]; selectedIndex--; }); }); up.disabled = selectedIndex === 0;
      actions.append(up, button("Delete field", () => schemaChange("delete field", () => { definition.messages[selectedMessage].indexes.splice(selectedIndex, 1); selectedIndex = null; }), "text-button danger"));
    } else actions.append(button("Delete message", () => schemaChange("delete message", () => { definition.messages.splice(selectedMessage, 1); selectedMessage = selectedIndex = null; }), "text-button danger"));
    target.append(el("hr", "section-divider"), actions);
  }
}
function guidedAddSchema() {
  schemaChange("new schema (also removes its outputs)", () => {
    const schema = {id: uid("schema"), document: {format: "vmf-schema/1", envelope: "C", messages: []}};
    workspace.schemas.push(schema); selectedSchema = schema.id; selectedMessage = selectedIndex = null; schemaExplanation = "";
  });
}
function guidedAddMessage() {
  const definition = selectedDefinition(); if (!definition) return;
  if (!Array.isArray(definition.messages)) { message("Repair the messages array before adding a message.", true); return; }
  schemaChange("new message", () => { definition.messages.push({message_number: "", indexes: []}); selectedMessage = definition.messages.length - 1; selectedIndex = null; schemaExplanation = ""; });
}
function guidedAddIndex() {
  const msg = selectedDefinition()?.messages?.[selectedMessage]; if (!msg) return;
  if (!Array.isArray(msg.indexes)) { message("Repair the indexes array before adding a field.", true); return; }
  schemaChange("new field", () => {
    const used = new Set(msg.indexes.filter(isObject).map(field => String(field.index_number).replace(/\.$/, "")));
    let number = 1; while (used.has(String(number))) number++;
    msg.indexes.push({index_number: number + ".", number_of_bits: 1}); selectedIndex = msg.indexes.length - 1; schemaExplanation = "";
  });
}
async function guidedImportSchema(event) {
  const file = event.target.files[0]; if (!file) return;
  try {
    if (file.size > 16 * 1024 * 1024) throw new Error("Schema exceeds 16 MiB.");
    const document = parseJSON(await file.text());
    if (document.format !== "vmf-schema/1" || !Array.isArray(document.messages)) throw new Error("Choose a native vmf-schema/1 definition.");
    let id = file.name.replace(/\.json$/i, "") || uid("schema");
    while (schemaById(id)) id = uid(id);
    schemaChange("import schema (also removes its outputs)", () => { workspace.schemas.push({id, document}); selectedSchema = id; selectedMessage = selectedIndex = null; schemaExplanation = ""; });
    message("Schema imported. Native validation runs when the draft is saved.");
  } catch (error) { message(error.message, true); }
  event.target.value = "";
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
    selectedWire = selectedOutput = null;
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
    node.setAttribute("role", "button"); node.setAttribute("tabindex", "0"); node.setAttribute("aria-label", wire.binding.cot + " to " + wire.field.index);
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
  if (name !== "mapping") cancelPendingConnection();
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
$("import-schema").addEventListener("change", guidedImportSchema);
$("export-schema").addEventListener("click", () => { const schema = schemaById(selectedSchema); if (schema) download(schema.id + ".json", schema.document); });
$("delete-schema").addEventListener("click", guidedDeleteSchema);
$("reload").addEventListener("click", async () => {
  if (saving) return;
  try { clearTimeout(saveTimer); state = await request("/api/state"); workspace = state.draft; resetSchemaHistory(); generation = savedGeneration = 0; selectedWire = selectedOutput = null; message(""); status(); render(); } catch (error) { message(error.message, true); }
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
