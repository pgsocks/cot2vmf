const { test, expect } = require('@playwright/test');
const dgram = require('node:dgram');

const empty = { format: 'cot-vmf-workspace/1', schemas: [], outputs: [] };
const schema = {
  format: 'vmf-schema/1', envelope: 'C', standard_version: 0,
  messages: [{ message_number: 'K01.1', elements: [
    { key: 'sent', number_of_bits: 64 },
    { key: 'battery', number_of_bits: 32 },
  ] }],
};

async function state(request) {
  const response = await request.get('/api/state');
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function reset(request) {
  await expect.poll(async () => {
    try { return (await request.get('/health')).status(); } catch { return 0; }
  }, { timeout: 30000 }).toBe(200);
  const current = await state(request);
  expect((await request.post('/api/state', { data: {
    revision: current.draft_revision, workspace: empty,
  } })).ok()).toBeTruthy();
}

async function saved(page) {
  await expect(page.locator('#save-status')).toContainText(/saved/i);
}

async function drag(page, source, target) {
  await source.scrollIntoViewIfNeeded();
  await target.scrollIntoViewIfNeeded();
  const a = await source.boundingBox(), b = await target.boundingBox();
  expect(a).not.toBeNull(); expect(b).not.toBeNull();
  await page.mouse.move(a.x + a.width - 12, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + 12, b.y + b.height / 2, { steps: 12 });
  await page.mouse.up();
}

function receiveEvent() {
  const xml = '<event version="2.0" uid="browser-synthetic" type="a-f-G" ' +
    'how="m-g" time="2026-10-23T08:00:00Z" start="2026-10-23T08:00:00Z" ' +
    'stale="2026-10-23T09:00:00Z"><point lat="1" lon="2" hae="3" ' +
    'ce="4" le="5"/><detail><status battery="95"/></detail></event>';
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    socket.send(Buffer.from(xml), Number(process.env.COT_PORT || 9001),
      process.env.COT_HOST || 'translator', error => {
        socket.close(); error ? reject(error) : resolve();
      });
  });
}

test.beforeEach(async ({ request }) => { await reset(request); });

test('Delete removes only the selected wire and preserves text editing',
  async ({ page, request }) => {
    await draft(request, [output('keyboard', { fields: [
      { cot: 'send_time_ms', vmf: { key: 'sent' }, factor: 123 },
      { cot: 'detail.status.battery', vmf: { key: 'battery' } },
    ] })]);
    await page.goto('/');
    const wire = page.getByRole('button', { name: 'send_time_ms to sent', exact: true });
    await wire.focus(); await page.keyboard.press('Enter');
    const factor = page.locator('#mapping-editor [data-property="factor"]');
    await factor.focus(); await factor.press('Home');
    await factor.press('Delete'); await factor.press('Tab');
    await saved(page);
    expect((await state(request)).draft.outputs[0].mapping.fields[0].factor)
      .toBe(23);
    await expect(page.locator('path.wire')).toHaveCount(2);
    const search = page.locator('#source-search');
    await search.fill('battery'); await search.press('Home');
    await search.press('Delete'); await expect(search).toHaveValue('attery');
    await search.fill('');
    await wire.focus(); await page.keyboard.press('Enter');
    await page.keyboard.press('Delete');
    await saved(page);
    await expect(page.locator('path.wire')).toHaveCount(1);
    expect((await state(request)).draft.outputs[0].mapping.fields.map(x => x.cot))
      .toEqual(['detail.status.battery']);
    await page.reload();
    await expect(page.locator('path.wire')).toHaveCount(1);
  });

function output(id, mapping = {}, enabled = false) {
  return { id, enabled, mapping: {
    format: 'cot-vmf-mapping-config/1', schema: 'repair',
    message: 0, envelope: 'C', fields: [], ...mapping,
  } };
}

test('clicked sources carry a preview wire until connected or cancelled',
  async ({ page, request }) => {
    await draft(request, []);
    await page.goto('/');
    const source = page.locator('.source-port[data-source-path="send_time_ms"]');
    const target = page.locator('.target-port[data-target-index="1"]');
    await source.click();
    const preview = page.locator('path.drag-wire');
    await expect(preview).toHaveCount(1);
    await expect(source).toHaveAttribute('aria-pressed', 'true');
    const initialPath = await preview.getAttribute('d');
    await page.mouse.move(650, 500);
    await expect.poll(() => preview.getAttribute('d')).not.toBe(initialPath);
    await target.focus(); await page.keyboard.press('Enter');
    await saved(page);
    await expect(preview).toHaveCount(0);
    await expect(page.locator('path.wire')).toHaveCount(1);
    await source.click(); await target.click();
    await expect(page.locator('#toast')).toContainText('already has a value');
    await expect(preview).toHaveCount(1);
    await source.click();
    await expect(preview).toHaveCount(0);
    await source.focus(); await page.keyboard.press('Enter');
    await expect(preview).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(preview).toHaveCount(0);
    const wire = page.locator('path.wire');
    await wire.focus();
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await expect(wire).toBeFocused();
    await source.click();
    await page.locator('[data-tab="schemas"]').click();
    await page.locator('[data-tab="mapping"]').click();
    await expect(preview).toHaveCount(0);
    expect((await state(request)).draft.outputs[0].mapping.fields).toHaveLength(1);
  });

async function draft(request, outputs) {
  const current = await state(request);
  const response = await request.post('/api/state', { data: {
    revision: current.draft_revision, workspace: {
      ...empty, schemas: [{ id: 'repair', document: schema }], outputs,
    },
  } });
  expect(response.ok()).toBeTruthy();
}

test('Escape deselects a wire without changing mappings or unrelated input',
  async ({ page, request }) => {
    await draft(request, [output('escape', { fields: [
      { cot: 'send_time_ms', vmf: { key: 'sent' } },
    ] })]);
    await page.goto('/');
    const wire = page.locator('path.wire');
    await wire.focus(); await page.keyboard.press('Enter');
    await expect(wire).toHaveClass(/selected/);
    await expect(page.locator('#mapping-inspector-title'))
      .toHaveText('Connection properties');
    const revision = (await state(request)).draft_revision;
    const search = page.locator('#source-search');
    await search.fill('send_time'); await search.press('Escape');
    await expect(search).toHaveValue('send_time');
    await expect(search).toBeFocused();
    await expect(wire).not.toHaveClass(/selected/);
    await expect(wire).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#mapping-inspector-title'))
      .toHaveText('Make a connection');
    expect((await state(request)).draft_revision).toBe(revision);
    await expect(wire).toHaveCount(1);
    const source = page.locator('.source-port[data-source-path="send_time_ms"]');
    const box = await source.boundingBox();
    await page.mouse.move(box.x + box.width - 12, box.y + box.height / 2);
    await page.mouse.down(); await page.keyboard.press('Escape');
    await page.mouse.up();
    await expect(page.locator('path.drag-wire')).toHaveCount(0);
    await expect(source).toHaveAttribute('aria-pressed', 'false');
  });

async function expandMapping(page) {
  const summaries = page.locator('#mapping-editor details:not([open]) > summary');
  while (await summaries.count()) await summaries.first().click();
}

test('orphaned outputs remain selectable for repair and removal after reload',
  async ({ page, request }) => {
    const orphan = output('orphan-schema', { schema: 'missing' });
    const header = output('orphan-header');
    header.mapping.message = 9;
    await draft(request, [orphan, header]);
    await page.goto('/');
    await page.reload();
    let writes = 0;
    page.on('request', request => {
      if (request.method() === 'POST' && request.url().endsWith('/api/state')) writes++;
    });
    const outputs = page.locator('#output-list .output-select');
    await expect(outputs).toHaveText(['orphan-schema', 'orphan-header']);
    await expect(page.locator('#output-list .output-unresolved')).toHaveCount(2);
    const revision = (await state(request)).draft_revision;
    await outputs.first().click();
    await expect(page.locator('#mapping-inspector-title')).toHaveText('Message output');
    await page.waitForTimeout(250);
    expect((await state(request)).draft_revision).toBe(revision);
    expect(writes).toBe(0);
    const schemaId = page.locator('#mapping-editor [data-property="schema"]');
    await schemaId.fill('repair'); await schemaId.press('Tab');
    await saved(page);
    await expect(page.locator('#output-list .output-select.selected'))
      .toHaveText('orphan-schema');
    await expect(page.locator('#output-list .output-unresolved')).toHaveCount(1);
    const selectedRevision = (await state(request)).draft_revision;
    const selectedWrites = writes;
    await page.locator('.message-info').first().click();
    await page.locator('.target-port').first().click();
    await page.getByRole('button', { name: 'Header & controls', exact: true }).click();
    await page.waitForTimeout(250);
    expect((await state(request)).draft_revision).toBe(selectedRevision);
    expect(writes).toBe(selectedWrites);
    expect((await state(request)).draft.outputs).toHaveLength(2);
    await outputs.nth(1).click();
    await expandMapping(page);
    const number = page.locator('#mapping-editor [data-property="message"]');
    await number.fill('0'); await number.press('Tab');
    await saved(page);
    await expect(page.locator('#output-list .output-unresolved')).toHaveCount(0);
    await page.locator('#output-list [aria-label="Enable output orphan-header"]').check();
    await saved(page);
    expect((await state(request)).draft.outputs[1].enabled).toBe(true);
    await page.getByRole('button', { name: 'Remove output', exact: true }).click();
    await saved(page);
    await expect(outputs).toHaveText(['orphan-schema']);
    await expect(page.locator('#mapping-inspector-title')).toHaveText('Make a connection');
    await outputs.first().click();
    await page.locator('#reload').click();
    await expect(page.locator('#mapping-inspector-title')).toHaveText('Make a connection');
    expect((await state(request)).draft.outputs.map(item => item.id))
      .toEqual(['orphan-schema']);
  });

test('disabled malformed mappings preserve values and healthy wires until repaired',
  async ({ page, request }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const malformed = output('malformed', {
      fields: { preserve: 'fields' }, vmf_constants: { preserve: 'constants' },
    });
    const bindings = output('bindings', { fields: [null, 7,
      { cot: 'send_time_ms', vmf: { key: 'sent' } },
      { cot: 'send_time_ms', vmf: null },
    ] });
    await draft(request, [malformed, bindings]);
    expect((await state(request)).valid).toBe(true);
    await page.goto('/');
    await expect(page.locator('path.wire')).toHaveCount(1);
    await page.locator('#output-list [data-output-id="malformed"]').click();
    await expandMapping(page);
    await expect(page.getByRole('button', { name: 'Replace with array', exact: true }))
      .toHaveCount(2);
    await page.locator('.source-port[data-source-path="detail.status.battery"]').click();
    await page.locator('.target-port[data-target-index="2"]').click();
    await expect(page.locator('#toast')).toContainText('Repair');
    expect((await state(request)).draft.outputs[0].mapping.fields)
      .toEqual({ preserve: 'fields' });
    await page.getByRole('button', { name: 'Replace with array', exact: true })
      .first().click();
    await saved(page);
    expect((await state(request)).draft.outputs[0].mapping.fields).toEqual([]);
    expect((await state(request)).draft.outputs[0].mapping.vmf_constants)
      .toEqual({ preserve: 'constants' });
    await expect(page.locator('path.wire')).toHaveCount(1);
    await page.locator('#output-list [data-output-id="bindings"]').click();
    await expandMapping(page);
    await page.getByRole('button', { name: 'Set value', exact: true }).first().click();
    await saved(page);
    expect((await state(request)).draft.outputs[1].mapping.fields[0])
      .toEqual({ cot: '', vmf: {key: ''} });
    await page.getByRole('button', { name: 'Replace with object', exact: true }).click();
    await saved(page);
    expect((await state(request)).draft.outputs[1].mapping.fields[1])
      .toEqual({ cot: '', vmf: {key: ''} });
    await expect(page.locator('path.wire')).toHaveCount(1);
    const mapping = output('mapping'); mapping.mapping = 'preserve mapping';
    await draft(request, [...(await state(request)).draft.outputs, mapping]);
    await page.reload();
    await page.locator('#output-list [data-output-id="mapping"]').click();
    await page.getByRole('button', { name: 'Replace with object', exact: true }).click();
    await saved(page);
    expect((await state(request)).draft.outputs[2].mapping).toEqual({});
    await expect(page.locator('path.wire')).toHaveCount(1);
    expect(errors).toEqual([]);
  });

test('autosave preserves pending input and its editor bindings',
  async ({ page, request }) => {
    const current = await state(request);
    await request.post('/api/state', { data: {
      revision: current.draft_revision,
      workspace: { ...empty, schemas: [{ id: 'editing', document: schema }] },
    } });
    await page.goto('/');
    await page.locator('[data-tab="schemas"]').click();
    await page.locator('#schema-list [data-schema-id="editing"]').click();
    await page.locator('.tree-select.field').first().click();

    let releaseSave, notifySave;
    const heldSave = new Promise(resolve => { releaseSave = resolve; });
    const saveStarted = new Promise(resolve => { notifySave = resolve; });
    await page.route('**/api/state', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      const response = await route.fetch();
      notifySave();
      await heldSave;
      await route.fulfill({ response });
    });
    const initialKey = page.locator('#schema-editor [data-property="key"]');
    await initialKey.fill('saved-name');
    await initialKey.press('Tab');
    await saveStarted;
    const key = page.locator('#schema-editor [data-property="key"]');
    await key.fill('pending-name');
    releaseSave();
    await saved(page);
    await expect(key).toHaveValue('pending-name');
    await expect(key).toBeFocused();
    await key.press('Tab');
    await expect.poll(async () => {
      const value = await state(request);
      return value.draft.schemas[0].document.messages[0].elements[0].key;
    }).toBe('pending-name');
    expect((await state(request)).valid).toBeTruthy();
  });

test('deleting a schema removes its outputs and retains unrelated outputs',
  async ({ page, request }) => {
    const current = await state(request);
    const output = (id, schemaId, enabled) => ({ id, enabled, mapping: {
      format: 'cot-vmf-mapping-config/1', schema: schemaId,
      message: 0, envelope: 'C', fields: [],
    } });
    const response = await request.post('/api/state', { data: {
      revision: current.draft_revision, workspace: {
        ...empty,
        schemas: ['removed', 'retained'].map(id => ({ id, document: schema })),
        outputs: [output('enabled', 'removed', true),
          output('disabled', 'removed', false),
          output('retained', 'retained', true)],
      },
    } });
    expect((await response.json()).valid).toBeTruthy();
    await page.goto('/');
    await page.locator('[data-tab="schemas"]').click();
    await page.locator('#schema-list [data-schema-id="removed"]').click();
    await page.locator('#delete-schema').click();
    await saved(page);
    const next = await state(request);
    expect(next.valid).toBeTruthy();
    expect(next.active_revision).toBe(next.draft_revision);
    expect(next.draft.schemas.map(item => item.id)).toEqual(['retained']);
    expect(next.draft.outputs.map(item => item.id)).toEqual(['retained']);
    await page.reload();
    expect((await state(request)).draft.outputs.map(item => item.id))
      .toEqual(['retained']);
    await expect(page.locator('#output-list input:checked')).toHaveCount(1);
  });

test('author a native schema visually and retain it across reload',
  async ({ page, request }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/');
    await page.locator('[data-tab="schemas"]').click();
    await page.locator('#add-schema').click();
    await saved(page);
    await page.locator('#add-message').click();
    const message = page.locator('#schema-editor [data-property="message_number"]');
    await message.fill('K01.1'); await message.press('Tab');
    await page.locator('#add-index').click();
    await payloadStep(page, '2. Encoding');
    await payloadStep(page, '3. Size & length');
    const width = page.locator('#schema-editor [data-property="number_of_bits"]');
    await width.fill('16'); await width.press('Tab');
    await saved(page);
    await expect.poll(async () => {
      const value = await state(request);
      return value.draft.schemas[0]?.document.messages[0]?.elements[0]?.number_of_bits;
    }).toBe(16);
    expect((await state(request)).valid).toBeTruthy();
    await page.reload();
    await page.locator('[data-tab="schemas"]').click();
    await expect(page.locator('#schema-list [data-schema-id]')).toHaveCount(1);
    expect(errors).toEqual([]);
  });

test('wire fields by dragging, persist edits, and highlight live traffic',
  async ({ page, request }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/');
    await page.locator('[data-tab="schemas"]').click();
    await page.locator('#import-schema').setInputFiles({
      name: 'synthetic.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(schema)),
    });
    await saved(page);
    await page.locator('[data-tab="mapping"]').click();
    await expect(page.locator('.source-port')).toHaveCount(32);
    await expect(page.locator('.target-port')).toHaveCount(2);
    const sent = page.locator('.source-port[data-source-path="send_time_ms"]');
    const target = page.locator('.target-port[data-target-index="1"]');
    await drag(page, sent, target);
    await saved(page);
    await page.locator('#source-search').fill('detail.status.battery');
    await drag(page,
      page.locator('.source-port[data-source-path="detail.status.battery"]'),
      page.locator('.target-port[data-target-index="2"]'));
    await saved(page);
    await page.locator('#source-search').fill('');
    await expect(page.locator('path.wire')).toHaveCount(2);
    const persisted = await state(request);
    expect(persisted.valid).toBeTruthy();
    expect(persisted.draft.outputs[0].mapping.fields).toHaveLength(2);
    await page.reload();
    await expect(page.locator('path.wire')).toHaveCount(2);
    await receiveEvent();
    await expect(page.locator('.source-port[data-source-path="send_time_ms"]'))
      .toHaveClass(/live/);
    await expect(page.locator('.source-port[data-source-path="detail.status.battery"]'))
      .toHaveClass(/live/);
    await expect(page.locator('path.wire.live')).toHaveCount(2);
    await page.screenshot({ path: '/tests/test-results/live-mapping.png',
      fullPage: true });
    await expect.poll(async () => (await state(request)).activity.received).toBeGreaterThan(0);
    await page.setViewportSize({ width: 820, height: 1000 });
    await expect(page.locator('path.wire')).toHaveCount(2);
    expect(errors).toEqual([]);
  });

test('source fanout supports visual conversion properties and wire removal',
  async ({ page, request }) => {
    const current = await state(request);
    const document = {
      format: 'cot-vmf-workspace/1', schemas: [{ id: 'fanout', document: {
        ...schema, messages: [{ message_number: 'K01.1', elements: [
          { key: 'sent', number_of_bits: 64 },
          { key: 'battery', number_of_bits: 64 },
        ] }],
      } }], outputs: [],
    };
    await request.post('/api/state', { data: {
      revision: current.draft_revision, workspace: document,
    } });
    await page.goto('/');
    const source = page.locator('.source-port[data-source-path="send_time_ms"]');
    await source.click();
    await page.locator('.target-port[data-target-index="1"]').click();
    await saved(page);
    await source.click();
    await page.locator('.target-port[data-target-index="2"]').click();
    await saved(page);
    await expect(page.locator('path.wire')).toHaveCount(2);
    expect((await state(request)).draft.outputs[0].mapping.fields.map(
      field => field.cot)).toEqual(['send_time_ms', 'send_time_ms']);
    const properties = page.locator('#mapping-editor > .object-editor');
    const add = properties.locator(':scope > .add-property');
    await add.locator('select').selectOption('factor');
    await add.getByRole('button', { name: '+ Add', exact: true }).click();
    await page.locator('#mapping-editor [data-property="factor"]').fill('1000');
    await page.locator('#mapping-editor [data-property="factor"]').press('Tab');
    await saved(page);
    expect((await state(request)).draft.outputs[0].mapping.fields[1].factor)
      .toBe(1000);
    await page.getByRole('button', { name: 'Remove connection' }).click();
    await saved(page);
    await expect(page.locator('path.wire')).toHaveCount(1);
    expect((await state(request)).draft.outputs[0].mapping.fields).toHaveLength(1);
  });

test('duplicate field keys are blocked before changing the draft or active revision',
  async ({ page, request }) => {
    const current = await state(request);
    const document = {
      format: 'cot-vmf-workspace/1',
      schemas: [{ id: 'synthetic', document: schema }], outputs: [],
    };
    await request.post('/api/state', { data: {
      revision: current.draft_revision, workspace: document,
    } });
    const before = await state(request);
    await page.goto('/');
    await page.locator('[data-tab="schemas"]').click();
    await page.locator('#schema-list [data-schema-id="synthetic"]').click();
    await page.locator('.tree-select.field[data-field-key="sent"]').click();
    const key = page.locator('#schema-editor [data-property="key"]');
    await key.fill('battery'); await key.press('Tab');
    await expect.poll(() => key.evaluate(input => input.validationMessage))
      .toContain('Choose a unique key');
    await expect(key).toHaveValue('battery');
    const after = await state(request);
    expect(after.valid).toBe(true);
    expect(after.draft_revision).toBe(before.draft_revision);
    expect(after.active_revision).toBe(before.active_revision);
    expect(after.draft).toEqual(before.draft);
    await expect(page.locator('#draft-error')).toBeHidden();
    await page.reload();
    expect((await state(request)).draft.schemas[0].document).toEqual(schema);
  });

test('native schema import and export preserve exact integers and metadata',
  async ({ page, request }) => {
    const source = '{"format":"vmf-schema/1","envelope":"C",' +
      '"standard_version":0,"messages":[{"message_number":"K01.1",' +
      '"octet_order":"msb_first","elements":[{' +
      '"key":"exact","number_of_bits":64,' +
      '"bit_order":"msb_first","constant":18446744073709551615,' +
      '"allowed":[{"first":0,"last":18446744073709551615}],' +
      '"scale":{"factor":{"numerator":1,"denominator":3},' +
      '"bias":{"numerator":-9223372036854775808,"denominator":1},' +
      '"sentinels":[18446744073709551614]}},{"key":"gate",' +
      '"type":"bool","when":{"all":' +
      '[{"field":"exact","values":[{"first":0,' +
      '"last":18446744073709551615}],"mask":18446744073709551615}]}}]}]}';
    await page.goto('/');
    await page.locator('[data-tab="schemas"]').click();
    await page.locator('#import-schema').setInputFiles({
      name: 'exact.json', mimeType: 'application/json',
      buffer: Buffer.from(source),
    });
    await saved(page);
    await expect.poll(async () => (await state(request)).valid).toBe(true);
    await page.locator('.tree-select.field').first().click();
    await payloadStep(page, '2. Encoding');
    await payloadStep(page, '3. Size & length');
    await payloadStep(page, '4. Constraints');
    await expect(page.locator('[data-property="constant"]'))
      .toHaveValue('18446744073709551615');
    const event = page.waitForEvent('download');
    await page.locator('#export-schema').click();
    const download = await event;
    const stream = await download.createReadStream(), chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const exported = Buffer.concat(chunks).toString('utf8');
    expect(exported).toContain('18446744073709551615');
    expect(exported).toContain('-9223372036854775808');
    expect(exported).toContain('"octet_order": "msb_first"');
    expect(exported).toContain('"all": [');
    expect(exported).not.toContain('index_number');
    expect(exported).not.toContain('encode_type');
    expect(exported).not.toContain('18446744073709552000');
    await page.screenshot({ path: '/tests/test-results/schema-authoring.png',
      fullPage: true });
  });

test('stimulated authoring accepts a subset and explains each test result',
  async ({ page, request }) => {
    const definition = structuredClone(schema);
    definition.messages[0].elements.push({optional: {
      key: 'optional', number_of_bits: 16,
    }});
    await page.goto('/');
    await expect(page.getByRole('region', { name: 'Mapping authoring' }))
      .toContainText('Translate only the data your message needs');
    await page.getByRole('button', { name: '▤ Payload schemas' }).click();
    await page.locator('#import-schema').setInputFiles({
      name: 'subset.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(definition)),
    });
    await saved(page);
    await page.getByRole('button', { name: '⌘ Field mapping' }).click();
    await page.locator('.source-port[data-source-path="send_time_ms"]').click();
    await page.locator('.target-port[data-target-index="1"]').click();
    await saved(page);
    const created = (await state(request)).draft.outputs[0];
    expect(created.enabled).toBe(false);
    expect(created.mapping).not.toHaveProperty('envelope');
    await page.locator('#output-list [data-output-id="' + created.id + '"]').click();
    await page.getByRole('combobox', { name: 'Output envelope', exact: true }).selectOption('C');
    await saved(page);
    await page.getByRole('checkbox', { name: 'Enable output ' + created.id }).check();
    await saved(page);
    const results = page.getByRole('region', { name: 'Live test results' });
    await expect(results).toContainText(/Waiting for traffic|Waiting for the next event after your edit/);
    expect((await state(request)).draft.outputs[0].enabled).toBe(true);
    await receiveEvent();
    await expect(results).toContainText('Not encoded for this event');
    await expect(results.locator('.result-diagnostic')).not.toBeEmpty();
    await expect(page.locator('#save-status')).toHaveText('Changes saved');
    await expect(page.locator('#draft-error')).toBeHidden();
    const historicalFailures = (await state(request)).activity.outputs_failed;
    expect(historicalFailures).toBeGreaterThan(0);

    await page.locator('.source-port[data-source-path="detail.status.battery"]')
      .click();
    await page.locator('.target-port[data-target-index="2"]').click();
    await saved(page);
    await expect(results).toContainText('Waiting for the next event after your edit');
    await receiveEvent();
    await expect(results.locator('.result-state')).toHaveText('VMF sent');
    await expect(results).not.toContainText(/unmapped|incomplete|missing work/i);
    await expect(page.locator('.target-port[data-target-index="3.1"]'))
      .not.toHaveClass(/diagnostic-target/);
    await expect(page.locator('body')).not.toContainText('browser-synthetic');
    expect((await state(request)).activity.outputs_failed).toBe(historicalFailures);
    await page.reload();
    await expect(results.locator('.result-state')).toHaveText('VMF sent');
    const outputId = (await state(request)).draft.outputs[0].id;
    await page.getByRole('checkbox', { name: 'Enable output ' + outputId })
      .uncheck();
    await saved(page);
    await expect(results.locator('.result-state')).toHaveText('Paused');
    await page.getByRole('checkbox', { name: 'Enable output ' + outputId })
      .check();
    await saved(page);
    await expect(results).toContainText('Waiting for the next event after your edit');
    await receiveEvent();
    await expect(results.locator('.result-state')).toHaveText('VMF sent');
  });

test('diagnostic locations never attach old active results to an edited draft',
  async ({ page, request }) => {
    const broken = output('diagnostic', { fields: [
      { cot: 'send_time_ms', vmf: { key: 'sent' }, factor: 1e-300 },
      { cot: 'detail.status.battery', vmf: { key: 'battery' } },
    ] }, true);
    await draft(request, [broken]);
    await page.goto('/');
    await receiveEvent();
    const results = page.getByRole('region', { name: 'Live test results' });
    await expect(results).toContainText('Not encoded for this event');
    const review = results.getByRole('button', { name: 'Review connection' });
    await review.focus();
    await receiveEvent();
    await expect(review).toBeFocused();
    await review.click();
    await expect(page.locator('#mapping-inspector-title'))
      .toHaveText('Connection properties');
    await expect(page.locator('.target-port[data-target-index="1"]'))
      .toHaveClass(/diagnostic-target/);
    const current = await state(request);
    const invalid = structuredClone(current.draft);
    invalid.schemas[0].document.envelope = 'INVALID';
    expect((await request.post('/api/state', { data: {
      revision: current.draft_revision, workspace: invalid,
    } })).ok()).toBeTruthy();
    await page.reload();
    await expect(results).toContainText('Testing previous active revision');
    await expect(results.getByRole('button', { name: /Review connection|Review target/ }))
      .toHaveCount(0);
    await expect(page.locator('.diagnostic-target')).toHaveCount(0);
    const fix = structuredClone(current.draft);
    delete fix.outputs[0].mapping.fields[0].factor;
    const latest = await state(request);
    expect((await request.post('/api/state', { data: {
      revision: latest.draft_revision, workspace: fix,
    } })).ok()).toBeTruthy();
    await page.reload();
    await expect(results).toContainText('Waiting for the next event after your edit');
    await expect(results.locator('.result-diagnostic')).toHaveCount(0);
    await receiveEvent();
    await expect(results.locator('.result-state')).toHaveText('VMF sent');
    const after = await state(request);
    after.draft.outputs = [];
    expect((await request.post('/api/state', { data: {
      revision: after.draft_revision, workspace: after.draft,
    } })).ok()).toBeTruthy();
    await page.reload();
    await expect(results.locator('.output-result')).toHaveCount(0);
  });

test('publication and message-level diagnostics give the appropriate next action',
  async ({ page, request }) => {
    await draft(request, [output('transport', { fields: [
      { cot: 'send_time_ms', vmf: { key: 'sent' } },
      { cot: 'detail.status.battery', vmf: { key: 'battery' } },
    ] }, true)]);
    const current = await state(request);
    const snapshot = { ...current.activity,
      sequence: current.activity.sequence + 1, received: 1, decoded: 1,
      outputs: [{ id: 'transport', enabled: true,
        revision: current.active_revision, event: 1, status: 'send_failed',
        code: 'publication', message: 'VMF output publication failed',
        config_path: '', target_index: '', cot_field_id: 0 }],
    };
    await page.route('**/api/events', route => route.fulfill({
      contentType: 'text/event-stream',
      body: 'event: activity\ndata: ' + JSON.stringify(snapshot) + '\n\n',
    }));
    await page.goto('/');
    const results = page.getByRole('region', { name: 'Live test results' });
    await expect(results).toContainText('Encoded; send failed');
    await expect(results).toContainText('Check the VMF destination and transport');
    await expect(results.getByRole('button', { name: /Review/ })).toHaveCount(0);
    await expect(page.locator('.diagnostic-target')).toHaveCount(0);
    snapshot.outputs[0].status = 'not_encoded';
    snapshot.outputs[0].code = 'vmf_encode';
    snapshot.outputs[0].message = 'VMF length_required; descriptor 0, bit 0';
    await page.reload();
    await expect(results).toContainText('Not encoded for this event');
    await results.getByRole('button', { name: 'Review message controls' }).click();
    await expect(page.locator('#mapping-inspector-title')).toHaveText('Message output');
    await expect(page.locator('.diagnostic-target')).toHaveCount(0);
  });

test('SSE reconnection replaces results when the service sequence restarts',
  async ({ page, request }) => {
    await draft(request, [output('restart', {}, true)]);
    const current = await state(request);
    let connections = 0;
    await page.route('**/api/events', route => {
      const first = connections++ === 0;
      const snapshot = { ...current.activity, sequence: first ? 10000 : 0,
        received: first ? 9 : 0, decoded: first ? 9 : 0,
        outputs: [{ id: 'restart', enabled: true,
          revision: current.active_revision, event: first ? 9 : 0,
          status: first ? 'not_encoded' : 'waiting',
          code: first ? 'vmf_encode' : '',
          message: first ? 'VMF length_required; descriptor 0, bit 0' : '',
          config_path: '', target_index: '', cot_field_id: 0 }],
      };
      return route.fulfill({ contentType: 'text/event-stream',
        body: 'retry: 1000\nevent: activity\ndata: '
          + JSON.stringify(snapshot) + '\n\n',
      });
    });
    await page.goto('/');
    const results = page.getByRole('region', { name: 'Live test results' });
    await expect(results).toContainText('Not encoded for this event');
    await expect(results).toContainText('Waiting for traffic');
    await expect(results.locator('.result-diagnostic')).toHaveCount(0);
    expect(connections).toBeGreaterThan(1);
  });

test('a null schema document stays intact until repaired through the browser',
  async ({ page, request }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const current = await state(request);
    const document = { ...empty, schemas: [
      { id: 'healthy', document: schema }, { id: 'broken', document: null },
    ] };
    const response = await request.post('/api/state', { data: {
      revision: current.draft_revision, workspace: document,
    } });
    expect((await response.json()).valid).toBe(false);
    await page.goto('/');
    await page.reload();
    const repair = page.getByRole('region', { name: 'Repair workspace' });
    await expect(repair).toBeVisible();
    await expect(page.locator('#connection-status')).toHaveText('Service connected');
    const schemas = repair.locator('[data-property-name="schemas"]');
    await schemas.locator(':scope > details > summary').click();
    const id = schemas.locator('[data-property="id"]').nth(1);
    await id.fill('pending-repair-name');
    await page.keyboard.press('Escape');
    await expect(id).toHaveValue('pending-repair-name');
    await expect(id).toBeFocused();
    await id.fill('broken');
    expect((await state(request)).draft).toEqual(document);
    await schemas.getByRole('button', { name: 'Set value', exact: true }).click();
    await expect(repair).toBeHidden();
    await expect.poll(async () => (await state(request)).valid).toBe(true);
    const saved = await state(request);
    expect(saved.draft.schemas[0]).toEqual(document.schemas[0]);
    expect(saved.draft.schemas[1]).toEqual({ id: 'broken', document: {
      format: 'vmf-schema/1', messages: [],
    } });
    expect(saved.active_revision).toBe(saved.draft_revision);
    await page.reload();
    await expect(repair).toBeHidden();
    await page.locator('[data-tab="schemas"]').click();
    await expect(page.locator('#schema-list [data-schema-id]')).toHaveCount(2);
    expect(errors).toEqual([]);
  });

for (const collection of ['schemas', 'outputs']) {
  test(`a malformed ${collection} collection requires an explicit replacement`,
    async ({ page, request }) => {
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      let current = await state(request);
      const previous = output('previous'); previous.mapping.schema = 'healthy';
      const healthy = { ...empty, schemas: [{ id: 'healthy', document: schema }],
        outputs: [previous] };
      await request.post('/api/state', { data: {
        revision: current.draft_revision, workspace: healthy,
      } });
      current = await state(request);
      const document = { ...healthy,
        [collection]: { preserve: 'untouched draft data' } };
      expect((await request.post('/api/state', { data: {
        revision: current.draft_revision, workspace: document,
      } })).ok()).toBeTruthy();
      await page.goto('/');
      const repair = page.getByRole('region', { name: 'Repair workspace' });
      await expect(repair).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(repair).toBeVisible();
      await page.locator('[data-tab="schemas"]').click();
      await expect(repair).toBeVisible();
      await expect(page.locator('#schemas-page')).toBeHidden();
      expect((await state(request)).draft).toEqual(document);
      const property = repair.locator(`[data-property-name="${collection}"]`);
      await property.locator(':scope > details > summary').click();
      await property.getByRole('button', { name: 'Replace with array', exact: true })
        .click();
      await expect(repair).toBeHidden();
      await expect.poll(async () => (await state(request)).valid).toBe(true);
      const next = await state(request);
      expect(next.draft).toEqual({ ...document, [collection]: [] });
      await page.reload();
      await expect(repair).toBeHidden();
      expect(errors).toEqual([]);
    });
}

test('missing collections and null entries can be repaired without losing siblings',
  async ({ page, request }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let current = await state(request);
    expect((await request.post('/api/state', { data: {
      revision: current.draft_revision,
      workspace: { format: 'cot-vmf-workspace/1' },
    } })).ok()).toBeTruthy();
    await page.goto('/');
    const repair = page.getByRole('region', { name: 'Repair workspace' });
    await expect(repair).toBeVisible();
    for (const name of ['schemas', 'outputs']) {
      const addition = repair.locator('#workspace-editor > .object-editor > .add-property');
      await addition.locator('select').selectOption(name);
      await addition.getByRole('button', { name: '+ Add', exact: true }).click();
    }
    await expect(repair).toBeHidden();
    await expect.poll(async () => (await state(request)).valid).toBe(true);
    current = await state(request);
    const retainedOutput = output('retained');
    retainedOutput.mapping.schema = 'healthy';
    const previous = output('previous'); previous.mapping.schema = 'healthy';
    await request.post('/api/state', { data: {
      revision: current.draft_revision, workspace: { ...empty,
        schemas: [{ id: 'healthy', document: schema }], outputs: [previous] },
    } });
    current = await state(request);
    const document = { ...empty,
      schemas: [{ id: 'healthy', document: schema }, null],
      outputs: [retainedOutput, null],
    };
    expect((await request.post('/api/state', { data: {
      revision: current.draft_revision, workspace: document,
    } })).ok()).toBeTruthy();
    await page.reload();
    await expect(repair).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(repair).toBeVisible();
    expect((await state(request)).draft).toEqual(document);
    for (const name of ['schemas', 'outputs']) {
      const property = repair.locator(`[data-property-name="${name}"]`);
      await property.locator(':scope > details > summary').click();
      const items = property.locator(':scope > details > .object-editor > .array-item');
      await items.nth(1).locator(':scope > .array-heading > .array-actions')
        .getByRole('button', { name: '×', exact: true }).click();
    }
    await expect(repair).toBeHidden();
    await expect.poll(async () => (await state(request)).valid).toBe(true);
    current = await state(request);
    expect(current.draft.schemas).toEqual([document.schemas[0]]);
    expect(current.draft.outputs).toEqual([retainedOutput]);
    expect(current.active_revision).toBe(current.draft_revision);
    expect(errors).toEqual([]);
  });

test('an activation failure retains the new draft revision and pending input',
  async ({ page, request }) => {
    const current = await state(request);
    await request.post('/api/state', { data: {
      revision: current.draft_revision,
      workspace: { ...empty, schemas: [{ id: 'editing', document: schema }] },
    } });
    await page.goto('/');
    await page.locator('[data-tab="schemas"]').click();
    await page.locator('#schema-list [data-schema-id="editing"]').click();
    await page.locator('.tree-select.field').first().click();
    let releaseSave, notifySave, writes = 0;
    const heldSave = new Promise(resolve => { releaseSave = resolve; });
    const saveStarted = new Promise(resolve => { notifySave = resolve; });
    await page.route('**/api/state', async route => {
      if (route.request().method() !== 'POST' || writes++ > 0)
        return route.continue();
      const response = await route.fetch();
      const saved = await response.json();
      notifySave();
      await heldSave;
      await route.fulfill({ status: 500, contentType: 'application/json',
        body: JSON.stringify({ ...saved, valid: false,
          active_revision: current.active_revision,
          error: 'Cannot persist active configuration' }),
      });
    });
    const initialKey = page.locator('#schema-editor [data-property="key"]');
    await initialKey.fill('saved-name'); await initialKey.press('Tab');
    await saveStarted;
    const key = page.locator('#schema-editor [data-property="key"]');
    await key.fill('pending-after-failure');
    releaseSave();
    await expect(page.locator('#save-status')).toContainText('Draft not active');
    await expect(key).toHaveValue('pending-after-failure');
    await expect(key).toBeFocused();
    await key.press('Tab');
    await expect.poll(async () => (await state(request)).draft.schemas[0]
      .document.messages[0].elements[0].key).toBe('pending-after-failure');
    await expect(page.locator('#save-status')).toHaveText('Changes saved');
    const saved = await state(request);
    expect(saved.draft.schemas[0].document.messages[0].elements[0].key)
      .toBe('pending-after-failure');
    expect(saved.active_revision).toBe(saved.draft_revision);
    await expect(page.locator('#toast')).not.toContainText('another window');
  });

test('question-mark help supports hover, focus, click and Escape', async ({ page }) => {
  await page.goto('/');
  const help = page.getByRole('button', { name: 'Help for Translation map', exact: true });
  const tooltip = page.getByRole('tooltip');
  await help.hover();
  await expect(tooltip).toBeVisible();
  await expect(help).toHaveAttribute('aria-describedby', 'context-help-tooltip');
  const box = await tooltip.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  await page.keyboard.press('Escape');
  await expect(tooltip).toBeHidden();
  await expect(help).not.toHaveAttribute('aria-describedby');
  await page.mouse.move(0, 0);
  await help.focus();
  await expect(tooltip).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(help).toBeFocused();
  await expect(tooltip).toBeHidden();
  await help.click();
  await expect(tooltip).toBeVisible();
  await help.click();
  await expect(tooltip).toBeHidden();
});


async function payloadDefinition(page, id = 'payload') {
  await page.locator('[data-tab="schemas"]').click();
  await page.locator('#schema-list [data-schema-id="' + id + '"]').click();
}
async function payloadStep(page, name) {
  await page.locator('#schema-editor > div > .guided-form > .guided-steps')
    .getByRole('button', {name, exact: true}).click();
}
async function payloadDraft(request, document = schema, outputs = []) {
  const current = await state(request);
  expect((await request.post('/api/state', {data: {
    revision: current.draft_revision,
    workspace: {...empty, schemas: [{id: 'payload', document}], outputs},
  }})).ok()).toBeTruthy();
}

test('guided payload encoding changes remove dependent settings in one undo',
  async ({page, request}) => {
    const document = JSON.parse(JSON.stringify(schema));
    Object.assign(document.messages[0].elements[0], {
      number_of_bits: 32, type: 'twos_complement',
      scale: {factor: {numerator: 1, denominator: 100},
        bias: {numerator: 0, denominator: 1}},
      constant: 1, allowed: [{first: 0, last: 100}],
    });
    await payloadDraft(request, document);
    await page.goto('/'); await payloadDefinition(page);
    await page.locator('.tree-select.field').first().click();
    await payloadStep(page, '2. Encoding');
    await page.locator('#schema-editor [data-property="type"]')
      .selectOption('text');
    await expect(page.locator('.guided-explanation')).toContainText('scale');
    await saved(page);
    let field = (await state(request)).draft.schemas[0].document.messages[0].elements[0];
    expect(field.type).toBe('text');
    for (const key of ['scale', 'constant', 'allowed', 'number_of_bits']) {
      expect(field).not.toHaveProperty(key);
    }
    await payloadStep(page, '3. Size & length');
    const width = page.locator('#schema-editor [data-property="number_of_bits"]');
    await width.fill('14'); await width.press('Tab'); await saved(page);
    await payloadStep(page, '4. Constraints');
    await expect(page.getByRole('button', {name: '+ Add Scale', exact: true}))
      .toHaveCount(0);
    await page.locator('#schema-undo').click(); await saved(page);
    await page.locator('#schema-undo').click(); await saved(page);
    field = (await state(request)).draft.schemas[0].document.messages[0].elements[0];
    expect(field).toEqual(document.messages[0].elements[0]);
    await page.reload();
    expect((await state(request)).draft.schemas[0].document).toEqual(document);
  });

test('schema defaults preserve semantic standards and undo restores selectors',
  async ({page, request}) => {
    const document = JSON.parse(JSON.stringify(schema));
    document.messages[0].message_standard = 'MIL-STD-6017A';
    await payloadDraft(request, document);
    await page.goto('/'); await payloadDefinition(page);
    await page.locator('#schema-editor [data-property="envelope"]').selectOption('B');
    await saved(page);
    let next = (await state(request)).draft.schemas[0].document;
    expect(next.standard_version).toBe(0);
    expect(next.messages[0].message_standard).toBe('MIL-STD-6017A');
    await page.locator('#schema-undo').click(); await saved(page);
    expect((await state(request)).draft.schemas[0].document).toEqual(document);
    await payloadStep(page, '2. Standard');
    await page.locator('[data-property="standard_selection"]').selectOption('raw');
    await page.locator('#schema-editor [data-property="standard_version"]').selectOption('9');
    await saved(page);
    expect((await state(request)).draft.schemas[0].document.standard_version).toBe(9);
    await page.locator('[data-property="standard_selection"]').selectOption('edition');
    await expect(page.locator('[data-property="message_standard"] option').filter({hasText: 'MIL-STD-6017D'})).toHaveCount(1);
  });

test('repeat wrappers keep count mechanisms explicit and undo named sources',
  async ({page, request}) => {
    const document = structuredClone(schema);
    const battery = document.messages[0].elements[1];
    document.messages[0].elements[1] = {repeat: {count: 2, body: battery}};
    await payloadDraft(request, document);
    await page.goto('/'); await payloadDefinition(page);
    await page.locator('.tree-select[data-node-path="/messages/0/elements/1"]')
      .click();
    await page.getByLabel('Repeat count mechanism', {exact: true})
      .selectOption('scalar');
    await expect(page.locator('#schema-editor [data-property="count"]'))
      .toHaveCount(0);
    await page.locator('#schema-editor [data-property="count_from"]')
      .selectOption('sent');
    const maximum = page.locator('#schema-editor [data-property="maximum"]');
    await maximum.fill('4'); await maximum.press('Tab'); await saved(page);
    expect((await state(request)).draft.schemas[0].document.messages[0]
      .elements[1]).toEqual({repeat: {
        count_from: 'sent', maximum: 4, body: battery,
      }});
    for (let index = 0; index < 3; index++) {
      await page.locator('#schema-undo').click(); await saved(page);
    }
    expect((await state(request)).draft.schemas[0].document).toEqual(document);
  });

test('schema undo preserves unrelated mapping edits and restores cascade deletion',
  async ({page, request}) => {
    const related = output('related', {schema: 'payload'});
    const unrelated = output('unrelated', {schema: 'missing', name: 'before'});
    await payloadDraft(request, schema, [related, unrelated]);
    await page.goto('/'); await payloadDefinition(page);
    await page.locator('#delete-schema').click(); await saved(page);
    await page.locator('[data-tab="mapping"]').click();
    await page.locator('#output-list [data-output-id="unrelated"]').click();
    const name = page.locator('#mapping-editor [data-property="name"]');
    await name.fill('intervening edit'); await name.press('Tab'); await saved(page);
    await page.locator('[data-tab="schemas"]').click();
    await page.locator('#schema-undo').click(); await saved(page);
    const next = (await state(request)).draft;
    expect(next.schemas[0].id).toBe('payload');
    expect(next.outputs.find(item => item.id === 'related')).toEqual(related);
    expect(next.outputs.find(item => item.id === 'unrelated').mapping.name)
      .toBe('intervening edit');
  });

test('undo importing a schema removes outputs created for it and keeps others',
  async ({page, request}) => {
    await payloadDraft(request, schema, [output('retained')]);
    const imported = structuredClone(schema);
    imported.messages[0].message_number = 'K01.2';
    await page.goto('/');
    await page.locator('[data-tab="schemas"]').click();
    await page.locator('#import-schema').setInputFiles({
      name: 'new-import.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(imported)),
    });
    await saved(page);
    await page.locator('[data-tab="mapping"]').click();
    await page.locator('.message-group:has(.target-port[data-schema-id="new-import"]) .message-info').click();
    await saved(page);
    expect((await state(request)).draft.outputs).toHaveLength(2);
    await page.locator('[data-tab="schemas"]').click();
    await page.locator('#schema-undo').click(); await saved(page);
    const next = (await state(request)).draft;
    expect(next.schemas.map(item => item.id)).toEqual(['payload']);
    expect(next.outputs.map(item => item.id)).toEqual(['retained']);
  });


test('named condition steps save raw ranges and retain completed navigation',
  async ({page, request}) => {
    await payloadDraft(request);
    await page.goto('/'); await payloadDefinition(page);
    await page.locator('.tree-select.field[data-field-key="battery"]').click();
    for (const step of ['2. Encoding', '3. Size & length', '4. Constraints',
      '5. Condition']) await payloadStep(page, step);
    await page.getByRole('button', {name: '+ Add When', exact: true}).click();
    const condition = page.locator('[data-guided-form$="/when"]');
    await condition.getByRole('button', {name: '+ Add term', exact: true}).click();
    const term = page.locator('[data-guided-form$="/when/all/0"]');
    await term.locator('[data-property="field"]').selectOption('sent');
    await term.getByRole('button', {name: '2. Raw values', exact: true}).click();
    await term.getByRole('button', {name: '+ Add item', exact: true}).click();
    const last = term.locator('[data-property="last"]');
    await last.fill('1'); await last.press('Tab');
    await term.getByRole('button', {name: '3. Mask & negation', exact: true}).click();
    await term.getByRole('button', {name: '+ Add Negate', exact: true}).click();
    await term.locator('[data-property="negate"]').check(); await saved(page);
    await term.getByRole('button', {name: '1. Source', exact: true}).click();
    await term.getByRole('button', {name: '3. Mask & negation', exact: true}).click();
    await expect(term.locator('[data-property="negate"]')).toBeChecked();
    const expected = {all: [
      {field: 'sent', values: [{first: 0, last: 1}], negate: true},
    ]};
    expect((await state(request)).draft.schemas[0].document.messages[0]
      .elements[1].when).toEqual(expected);
    expect((await state(request)).valid).toBe(true);
    await page.reload();
    expect((await state(request)).draft.schemas[0].document.messages[0]
      .elements[1].when).toEqual(expected);
  });

test('making a field optional derives its indicator and preserves data in one undo',
  async ({page, request}) => {
    const document = structuredClone(schema);
    Object.assign(document.messages[0].elements[0], {
      number_of_bits: 32, type: 'twos_complement', bit_order: 'msb_first',
      scale: {factor: {numerator: 1, denominator: 10},
        bias: {numerator: 0, denominator: 1}},
      allowed: [{first: 0, last: 10}], constant: 1,
    });
    await payloadDraft(request, document);
    await page.goto('/'); await payloadDefinition(page);
    await page.locator('.tree-select.field[data-field-key="sent"]').click();
    await page.getByRole('button', {name: 'Make optional', exact: true}).click();
    await saved(page);
    expect((await state(request)).draft.schemas[0].document.messages[0]
      .elements[0]).toEqual({optional: document.messages[0].elements[0]});
    expect((await state(request)).valid).toBe(true);
    await expect(page.locator('#schema-editor [data-property="indicator"]'))
      .toHaveCount(0);
    await expect(page.locator('#schema-editor [data-property="target"]'))
      .toHaveCount(0);
    await page.locator('#schema-undo').click(); await saved(page);
    expect((await state(request)).draft.schemas[0].document).toEqual(document);
  });

test('invalid boolean widths have undoable one-bit repair inside wrappers',
  async ({page, request}) => {
    const document = structuredClone(schema);
    document.messages[0].elements = [
      {optional: {key: 'gate', type: 'bool', number_of_bits: 0}},
      {key: 'flag', type: 'bool', number_of_bits: 2},
    ];
    await payloadDraft(request, document);
    await page.goto('/'); await payloadDefinition(page);
    for (const key of ['gate', 'flag']) {
      await page.locator('.tree-select.field[data-field-key="' + key + '"]').click();
      await payloadStep(page, '2. Encoding');
      await payloadStep(page, '3. Size & length');
      await page.getByRole('button', {name: 'Use implied one-bit width', exact: true})
        .click();
      await saved(page);
    }
    const repaired = (await state(request)).draft.schemas[0].document;
    expect(repaired.messages[0].elements[0].optional).not.toHaveProperty('number_of_bits');
    expect(repaired.messages[0].elements[1]).not.toHaveProperty('number_of_bits');
    expect((await state(request)).catalog.schemas[0].messages[0].fields
      .filter(field => field.key).map(field => [field.key, String(field.bits)]))
      .toEqual([['gate', '1'], ['flag', '1']]);
    expect((await state(request)).valid).toBe(true);
    await page.locator('#schema-undo').click(); await saved(page);
    expect((await state(request)).draft.schemas[0].document.messages[0]
      .elements[1].number_of_bits).toBe(2);
    expect((await state(request)).valid).toBe(false);
    await page.getByRole('button', {name: 'Use implied one-bit width', exact: true}).click();
    await saved(page);
    expect((await state(request)).valid).toBe(true);
  });

test('key edits preserve untouched invalid imported settings and undo them',
  async ({page, request}) => {
    const document = structuredClone(schema);
    Object.assign(document.messages[0].elements[0], {
      text_encoding: 'ascii_8',
      scale: {factor: {numerator: 1, denominator: 2},
        bias: {numerator: 0, denominator: 1}},
    });
    await payloadDraft(request, document);
    await page.goto('/'); await payloadDefinition(page);
    const initialRevision = (await state(request)).draft_revision;
    await page.locator('.tree-select.field[data-field-key="sent"]').click();
    expect((await state(request)).draft_revision).toBe(initialRevision);
    const key = page.locator('#schema-editor [data-property="key"]');
    await key.fill('renamed'); await key.press('Tab'); await saved(page);
    const current = (await state(request)).draft.schemas[0].document.messages[0]
      .elements[0];
    expect(current).toEqual({...document.messages[0].elements[0], key: 'renamed'});
    expect((await state(request)).valid).toBe(false);
    await page.locator('#schema-undo').click(); await saved(page);
    expect((await state(request)).draft.schemas[0].document).toEqual(document);
  });

test('field and message deletion undo restores native definitions',
  async ({page, request}) => {
    await payloadDraft(request);
    await page.goto('/'); await payloadDefinition(page);
    await page.locator('.tree-select.field').first().click();
    await page.getByRole('button', {name: 'Delete element', exact: true}).click();
    await saved(page);
    expect((await state(request)).draft.schemas[0].document.messages[0].elements)
      .toHaveLength(1);
    await page.locator('#schema-undo').click(); await saved(page);
    expect((await state(request)).draft.schemas[0].document).toEqual(schema);
    await page.locator('.tree-message > .tree-select:not(.field)').click();
    await page.getByRole('button', {name: 'Delete message', exact: true}).click();
    await saved(page);
    expect((await state(request)).draft.schemas[0].document.messages).toEqual([]);
    await page.locator('#schema-undo').click(); await saved(page);
    expect((await state(request)).draft.schemas[0].document).toEqual(schema);
  });

test('CoT purpose help covers every source without arming connections', async ({ page }) => {
  await page.goto('/');
  const sources = page.locator('#source-fields .source-port');
  await expect(sources).toHaveCount(32);
  await expect(page.locator('#source-fields .help-button')).toHaveCount(32);
  const tooltip = page.getByRole('tooltip');
  const latitude = page.getByRole('button', { name: 'Help for point.latitude', exact: true });
  await latitude.click();
  await expect(tooltip).toContainText('WGS84');
  await expect(page.locator('.source-port.armed')).toHaveCount(0);
  await expect(page.locator('.drag-wire')).toHaveCount(0);
  await page.keyboard.press('Escape');
  const residual = page.getByRole('button', { name: 'Help for detail.xml', exact: true });
  await residual.click();
  await expect(tooltip).toContainText('cannot be connected directly');
  await page.locator('#source-search').fill('point.latitude');
  await expect(tooltip).toBeHidden();
  await expect(page.locator('[aria-describedby="context-help-tooltip"]')).toHaveCount(0);
  await expect(page.locator('#source-fields .help-button')).toHaveCount(1);
  await page.locator('.source-port[data-source-path="point.latitude"]').hover();
  await expect(tooltip).toBeHidden();
});

test('output controls explain exact identity and conversion semantics', async ({ page, request }) => {
  await draft(request, [output('help-output', { fields: [
    { cot: 'send_time_ms', vmf: { key: 'sent' }, factor: 1 },
  ] })]);
  await page.goto('/');
  await page.locator('#output-list [data-output-id="help-output"]').click();
  const schemaHelp = page.locator('#mapping-editor').getByRole('button', {
    name: 'Help for schema', exact: true,
  });
  await schemaHelp.click();
  await expect(page.getByRole('tooltip')).toContainText('workspace schema ID');
  await page.keyboard.press('Escape');
  await page.locator('path.wire').focus();
  await page.keyboard.press('Enter');
  await page.locator('#mapping-editor').getByRole('button', {
    name: 'Help for factor', exact: true,
  }).click();
  await expect(page.getByRole('tooltip')).toContainText('cot_value = physical_vmf');
  await expect(page.locator('#mapping-editor [data-property="factor"]')).toHaveValue('1');
  expect((await state(request)).draft.outputs[0].mapping.fields[0].factor).toBe(1);
});

test('guided controls retain contextual help across form navigation',
  async ({ page, request }) => {
    await payloadDraft(request);
    await page.goto('/'); await payloadDefinition(page);
    await page.locator('.tree-select.field').first().click();
    const authoring = page.getByRole('button', {
      name: 'Help for Payload authoring', exact: true,
    });
    await expect(authoring).toHaveCount(1);
    const revision = (await state(request)).draft_revision;
    await payloadStep(page, '2. Encoding');
    const help = page.getByRole('button', {
      name: 'Help for type', exact: true,
    });
    await help.focus();
    await expect(page.getByRole('tooltip')).toContainText('wire data type');
    await page.keyboard.press('Escape');
    await expect(help).toBeFocused();
    await expect(page.getByRole('tooltip')).toBeHidden();
    await expect(authoring).toHaveCount(1);
    expect((await state(request)).draft_revision).toBe(revision);
  });

test('repair-form help distinguishes workspace and mapping formats',
  async ({ page, request }) => {
    const current = await state(request);
    expect((await request.post('/api/state', { data: {
      revision: current.draft_revision, workspace: { ...empty, outputs: null },
    } })).ok()).toBeTruthy();
    await page.goto('/');
    await page.locator('#workspace-editor').getByRole('button', {
      name: 'Help for format', exact: true,
    }).click();
    await expect(page.getByRole('tooltip')).toContainText('cot-vmf-workspace/1');
    expect((await state(request)).draft.outputs).toBeNull();
  });

function portableDefinition() {
  const definition = structuredClone(schema);
  delete definition.envelope;
  delete definition.standard_version;
  definition.message_standard = 'MIL-STD-6017B';
  return definition;
}

test('one portable payload serves explicit outputs in every envelope',
  async ({page, request}) => {
    test.setTimeout(60000);
    const definition = portableDefinition();
    await payloadDraft(request, definition);
    await page.goto('/');
    const catalog = (await state(request)).catalog.schemas[0].messages[0];
    expect(catalog.fields).toHaveLength(2);
    expect(Object.keys(catalog.profiles)).toEqual(['B', 'C', 'D', 'D1']);
    const ids = [];
    for (const envelope of ['B', 'C', 'D', 'D1', 'C']) {
      await page.getByRole('button', {
        name: 'Add output for payload message 0', exact: true,
      }).click();
      await saved(page);
      const created = (await state(request)).draft.outputs.at(-1);
      ids.push(created.id);
      expect(created.enabled).toBe(false);
      expect(created.mapping.message).toBe(0);
      expect(created.mapping).not.toHaveProperty('envelope');
      expect(created.mapping).not.toHaveProperty('vmf_header');
      const enable = page.getByRole('checkbox', {
        name: 'Enable output ' + created.id, exact: true,
      });
      await expect(enable).toBeDisabled();
      await page.getByRole('combobox', {name: 'Output envelope', exact: true})
        .selectOption(envelope);
      await saved(page);
      const identity = JSON.parse(await page.locator('.derived-identity')
        .textContent());
      if (envelope === 'B') expect(identity).not.toHaveProperty('standard_version');
      else expect(identity.standard_version).toBe(envelope === 'C' ? 8 : 7);
      await expect(page.locator('#mapping-editor [data-property="id"]'))
        .toHaveCount(0);
      for (const [source, target] of [
        ['send_time_ms', '1'], ['detail.status.battery', '2'],
      ]) {
        await page.locator('.source-port[data-source-path="' + source + '"]')
          .click();
        await page.locator('.target-port[data-target-index="' + target + '"]')
          .click();
        await saved(page);
      }
      await enable.check();
      await saved(page);
    }
    let snapshot = await state(request);
    expect(snapshot.valid).toBe(true);
    expect(new Set(ids).size).toBe(5);
    expect(snapshot.draft.schemas[0].document).toEqual(definition);
    expect(snapshot.draft.outputs.map(item => item.mapping.envelope))
      .toEqual(['B', 'C', 'D', 'D1', 'C']);
    expect(snapshot.draft.outputs.every(item =>
      !Object.hasOwn(item.mapping, 'vmf_header'))).toBe(true);
    await receiveEvent();
    await expect.poll(async () => (await state(request)).activity.outputs_succeeded)
      .toBeGreaterThanOrEqual(5);
    await page.reload();
    await expect(page.locator('#output-list .output-select')).toHaveCount(5);
    snapshot = await state(request);
    expect(snapshot.draft.outputs.map(item => item.id)).toEqual(ids);
  });

test('shared message connections require a chosen output and keep duplicates',
  async ({page, request}) => {
    await draft(request, [output('first'), output('second')]);
    await page.goto('/');
    await page.locator('.source-port[data-source-path="send_time_ms"]').click();
    await page.locator('.target-port[data-target-index="1"]').click();
    await expect(page.locator('#mapping-inspector-title'))
      .toHaveText('Choose an output');
    expect((await state(request)).draft.outputs).toHaveLength(2);
    await page.locator('#mapping-editor').getByRole('button', {
      name: 'second · C', exact: true,
    }).click();
    await page.locator('.target-port[data-target-index="1"]').click();
    await saved(page);
    const outputs = (await state(request)).draft.outputs;
    expect(outputs[0].mapping.fields).toEqual([]);
    expect(outputs[1].mapping.fields).toHaveLength(1);
    expect(outputs.every(item => item.enabled === false)).toBe(true);
    await expect(page.locator('#output-list .output-select')).toHaveCount(2);
  });

test('unsupported selected envelopes keep shared fields and remain repairable',
  async ({page, request}) => {
    const definition = portableDefinition();
    definition.message_standard = 'MIL-STD-6017D';
    const selected = output('unsupported', {schema: 'payload', envelope: 'C',
      fields: [{cot: 'send_time_ms', vmf: {key: 'sent'}}]});
    await payloadDraft(request, definition, [selected]);
    await page.goto('/');
    await expect(page.locator('.target-port')).toHaveCount(2);
    await expect(page.locator('path.wire')).toHaveCount(1);
    await page.locator('#output-list [data-output-id="unsupported"]').click();
    const choice = page.getByRole('combobox', {name: 'Output envelope', exact: true});
    await expect(choice).toHaveValue('C');
    await expect(page.locator('#mapping-editor .schema-invalid')).not.toBeEmpty();
    await expect(page.getByRole('checkbox', {name: 'Enable output unsupported'}))
      .toBeDisabled();
    expect((await state(request)).draft.outputs[0]).toEqual(selected);
    await choice.selectOption('D1');
    await saved(page);
    await expect(page.locator('.derived-identity')).toContainText('9');
    expect((await state(request)).draft.schemas[0].document).toEqual(definition);
    await expect(page.locator('#output-list .output-select.selected'))
      .toHaveAttribute('data-output-id', 'unsupported');
  });

test('message moves and deletion update ordinals and undo restores references',
  async ({page, request}) => {
    const definition = portableDefinition();
    definition.messages = [1, 2, 3].map(number => ({
      ...structuredClone(definition.messages[0]), message_number: 'K01.' + number,
    }));
    const outputs = [0, 1, 2].map(ordinal => output('ordinal-' + ordinal,
      {schema: 'payload', message: ordinal}, true));
    await payloadDraft(request, definition, outputs);
    await page.goto('/');
    await payloadDefinition(page);
    await page.locator('.tree-select').filter({hasText: /^K01\.1$/}).click();
    await page.getByRole('button', {name: 'Move message down', exact: true}).click();
    await saved(page);
    expect((await state(request)).draft.outputs.map(item => item.mapping.message))
      .toEqual([1, 0, 2]);
    await page.locator('[data-tab="mapping"]').click();
    await page.locator('#output-list [data-output-id="ordinal-2"]').click();
    const properties = page.locator('#mapping-editor > .object-editor');
    await properties.locator(':scope > .add-property select').selectOption('name');
    await properties.locator(':scope > .add-property').getByRole('button', {
      name: '+ Add', exact: true,
    }).click();
    await page.locator('#mapping-editor [data-property="name"]').fill('keep edit');
    await page.locator('#mapping-editor [data-property="name"]').press('Tab');
    await saved(page);
    await page.locator('[data-tab="schemas"]').click();
    await page.locator('#schema-undo').click();
    await saved(page);
    expect((await state(request)).draft.outputs.map(item => item.mapping.message))
      .toEqual([0, 1, 2]);
    expect((await state(request)).draft.outputs[2].mapping.name).toBe('keep edit');
    await page.locator('.tree-select').filter({hasText: /^K01\.2$/}).click();
    await page.getByRole('button', {name: 'Delete message', exact: true}).click();
    await saved(page);
    let snapshot = await state(request);
    expect(snapshot.draft.outputs[1].enabled).toBe(false);
    expect(snapshot.draft.outputs[1].mapping).not.toHaveProperty('message');
    expect(snapshot.draft.outputs[2].mapping.message).toBe(1);
    await page.locator('#schema-undo').click();
    await saved(page);
    snapshot = await state(request);
    expect(snapshot.draft.outputs.map(item => item.mapping.message))
      .toEqual([0, 1, 2]);
    expect(snapshot.draft.outputs[1].enabled).toBe(true);
    expect(snapshot.draft.outputs[2].mapping.name).toBe('keep edit');
  });

test('nested optional and recurrence groups are authored in order and undone',
  async ({page, request}) => {
    await payloadDraft(request);
    await page.goto('/'); await payloadDefinition(page);
    await page.locator('.tree-select.field[data-field-key="battery"]').click();
    await page.getByRole('button', {name: 'Wrap in group', exact: true}).click();
    await saved(page);
    const root = page.locator('.tree-select[data-node-path="/messages/0/elements/1"]');
    await root.click();
    await page.getByRole('button', {name: 'Make optional', exact: true}).click();
    await saved(page);
    await root.click();
    await page.getByRole('button', {name: 'Repeat with indicator', exact: true}).click();
    await saved(page);
    const maximum = page.locator('#schema-editor [data-property="maximum"]');
    await maximum.fill('4'); await maximum.press('Tab'); await saved(page);
    let node = (await state(request)).draft.schemas[0].document.messages[0].elements[1];
    expect(node).toEqual({recurrence: {maximum: 4, body: {
      optional: [schema.messages[0].elements[1]],
    }}});
    await page.locator('.tree-select[data-node-path="/messages/0/elements/1/recurrence/body/optional"]')
      .click();
    await page.locator('#add-index').click();
    const key = page.locator('#schema-editor [data-property="key"]');
    await key.fill('status'); await key.press('Tab');
    await payloadStep(page, '2. Encoding');
    await payloadStep(page, '3. Size & length');
    const width = page.locator('#schema-editor [data-property="number_of_bits"]');
    await width.fill('7'); await width.press('Tab'); await saved(page);
    const beforeMove = (await state(request)).draft.schemas[0].document;
    await page.getByRole('button', {name: 'Move element up', exact: true}).click();
    await saved(page);
    node = (await state(request)).draft.schemas[0].document.messages[0].elements[1];
    expect(node.recurrence.body.optional.map(field => field.key))
      .toEqual(['status', 'battery']);
    await page.locator('#schema-undo').click(); await saved(page);
    expect((await state(request)).draft.schemas[0].document).toEqual(beforeMove);
    expect((await state(request)).valid).toBe(true);
    await page.reload();
    expect((await state(request)).draft.schemas[0].document).toEqual(beforeMove);
  });

test('key renames update count length condition and mapping references only in their message',
  async ({page, request}) => {
    const document = structuredClone(schema);
    const elements = [
      {key: 'count', number_of_bits: 3},
      {key: 'length', number_of_bits: 3},
      {repeat: {count_from: 'count', maximum: 4, body: [
        {key: 'marker', number_of_bits: 1},
        {key: 'payload', type: 'bits', number_of_bits: 8,
          length_from: 'length', when: {all: [
            {field: 'count', values: [{first: 0, last: 4}]},
          ]},
        },
      ]}},
    ];
    document.messages = ['K01.1', 'K01.2'].map(message_number => ({
      message_number, elements: structuredClone(elements),
    }));
    const outputs = [0, 1].map(message => output('rename-' + message, {
      schema: 'payload', message,
      fields: [{cot: 'send_time_ms', vmf: {key: 'count'}}],
    }));
    await payloadDraft(request, document, outputs);
    expect((await state(request)).valid).toBe(true);
    await page.goto('/'); await payloadDefinition(page);
    await page.locator('.tree-select.field[data-node-path="/messages/0/elements/0"]')
      .click();
    const key = page.locator('#schema-editor [data-property="key"]');
    await key.fill('sample_count'); await key.press('Tab'); await saved(page);
    let snapshot = await state(request);
    const repeated = snapshot.draft.schemas[0].document.messages[0].elements[2].repeat;
    expect(repeated.count_from).toBe('sample_count');
    expect(repeated.body[1].when.all[0].field).toBe('sample_count');
    expect(snapshot.draft.outputs[0].mapping.fields[0].vmf).toEqual({key: 'sample_count'});
    expect(snapshot.draft.outputs[1].mapping.fields[0].vmf).toEqual({key: 'count'});
    expect(snapshot.draft.schemas[0].document.messages[1]).toEqual(document.messages[1]);
    await page.locator('.tree-select.field[data-node-path="/messages/0/elements/1"]')
      .click();
    await key.fill('payload_size'); await key.press('Tab'); await saved(page);
    snapshot = await state(request);
    expect(snapshot.draft.schemas[0].document.messages[0].elements[2].repeat.body[1]
      .length_from).toBe('payload_size');
    expect(snapshot.valid).toBe(true);
    await page.locator('#schema-undo').click(); await saved(page);
    await page.locator('#schema-undo').click(); await saved(page);
    snapshot = await state(request);
    expect(snapshot.draft.schemas[0].document).toEqual(document);
    expect(snapshot.draft.outputs).toEqual(outputs);
  });

test('moving and wrapping fields cannot silently retarget keyed mappings',
  async ({page, request}) => {
    const binding = output('stable', {schema: 'payload', fields: [
      {cot: 'send_time_ms', vmf: {key: 'battery'}},
    ]});
    await payloadDraft(request, schema, [binding]);
    await page.goto('/'); await payloadDefinition(page);
    await page.locator('.tree-select.field[data-field-key="battery"]').click();
    await page.getByRole('button', {name: 'Move element up', exact: true}).click();
    await saved(page);
    expect((await state(request)).draft.outputs[0]).toEqual(binding);
    expect((await state(request)).draft.schemas[0].document.messages[0].elements
      .map(field => field.key)).toEqual(['battery', 'sent']);
    await page.locator('[data-tab="mapping"]').click();
    const target = page.locator('.target-port[data-target-key="battery"]');
    await expect(target).toHaveAttribute('data-target-index', '1');
    await expect(page.getByRole('button', {name: 'send_time_ms to battery', exact: true}))
      .toHaveCount(1);
    await page.locator('[data-tab="schemas"]').click();
    await page.locator('.tree-select.field[data-field-key="battery"]').click();
    await page.getByRole('button', {name: 'Make optional', exact: true}).click();
    await saved(page);
    expect((await state(request)).draft.outputs[0]).toEqual(binding);
    await page.locator('[data-tab="mapping"]').click();
    await expect(target).toHaveAttribute('data-target-index', '1.1');
    await expect(page.locator('path.wire')).toHaveCount(1);
    await page.locator('[data-tab="schemas"]').click();
    await page.locator('#schema-undo').click(); await saved(page);
    await page.locator('#schema-undo').click(); await saved(page);
    expect((await state(request)).draft.schemas[0].document).toEqual(schema);
    expect((await state(request)).draft.outputs[0]).toEqual(binding);
    await page.reload();
    await expect(page.locator('.target-port[data-target-key="battery"]'))
      .toHaveAttribute('data-target-index', '2');
    await expect(page.locator('path.wire')).toHaveCount(1);
  });

test('retired flat payload JSON stays an invalid draft without replacing active state',
  async ({page, request}) => {
    await payloadDraft(request);
    const active = (await state(request)).active_revision;
    const retired = {format: 'vmf-schema/1', messages: [{
      message_number: 'K01.2', indexes: [
        {index_number: '1.', key: 'old', number_of_bits: 8},
      ],
    }]};
    await page.goto('/'); await payloadDefinition(page);
    await page.locator('#import-schema').setInputFiles({
      name: 'retired.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(retired)),
    });
    await expect.poll(async () => (await state(request)).valid).toBe(false);
    const snapshot = await state(request);
    expect(snapshot.active_revision).toBe(active);
    expect(snapshot.draft.schemas.find(item => item.id === 'retired').document)
      .toEqual(retired);
    await expect(page.locator('#draft-error')).toBeVisible();
  });

test('undoing a repeat move preserves controls added afterward on their logical repeat',
  async ({page, request}) => {
    const document = structuredClone(schema);
    document.messages[0].elements = ['a', 'b'].map(key => ({
      recurrence: {maximum: 4, body: {key, number_of_bits: 64}},
    }));
    const original = output('new-control', {schema: 'payload', fields: [
      {cot: 'send_time_ms', vmf: {key: 'b'}, factor: 7,
        occurrences: [{repeat: 2, index: 0}]},
    ]});
    await payloadDraft(request, document, [original]);
    await page.goto('/'); await payloadDefinition(page);
    await page.locator('.tree-select[data-node-path="/messages/0/elements/1"]')
      .click();
    await page.getByRole('button', {name: 'Move element up', exact: true}).click();
    await saved(page);
    expect((await state(request)).draft.outputs[0].mapping.fields[0].occurrences)
      .toEqual([{repeat: 1, index: 0}]);
    await page.locator('[data-tab="mapping"]').click();
    await page.locator('#output-list [data-output-id="new-control"]').click();
    const properties = page.locator('#mapping-editor > .object-editor');
    const addition = properties.locator(':scope > .add-property');
    await addition.locator('select').selectOption('repeat_counts');
    await addition.getByRole('button', {name: '+ Add', exact: true}).click();
    await expandMapping(page);
    const counts = page.locator('#mapping-editor [data-property-name="repeat_counts"]');
    await counts.getByRole('button', {name: '+ Add item', exact: true}).click();
    const repeat = counts.locator('[data-property="repeat"]');
    await repeat.fill('1'); await repeat.press('Tab');
    const count = counts.locator('[data-property="count"]');
    await count.fill('2'); await count.press('Tab'); await saved(page);
    expect((await state(request)).draft.outputs[0].mapping.repeat_counts)
      .toEqual([{repeat: 1, count: 2}]);
    await page.locator('[data-tab="schemas"]').click();
    await page.locator('#schema-undo').click(); await saved(page);
    const restored = (await state(request)).draft;
    expect(restored.schemas[0].document).toEqual(document);
    expect(restored.outputs[0].mapping.fields[0]).toEqual(original.mapping.fields[0]);
    const retained = restored.outputs[0].mapping.repeat_counts || [];
    if (retained.length) expect(retained).toEqual([{repeat: 2, count: 2}]);
    else {
      expect(restored.outputs[0].enabled).toBe(false);
      await expect(page.locator('#schema-editor')).toContainText(/disabled|review/i);
    }
  });

test('undoing a field rename updates bindings created after the rename',
  async ({page, request}) => {
    await payloadDraft(request, schema, [output('new-binding', {schema: 'payload'})]);
    await page.goto('/'); await payloadDefinition(page);
    await page.locator('.tree-select.field[data-field-key="sent"]').click();
    const key = page.locator('#schema-editor [data-property="key"]');
    await key.fill('renamed'); await key.press('Tab'); await saved(page);
    await page.locator('[data-tab="mapping"]').click();
    await page.locator('.source-port[data-source-path="send_time_ms"]').click();
    await page.locator('.target-port[data-target-key="renamed"]').click();
    await saved(page);
    const wire = page.getByRole('button', {name: 'send_time_ms to renamed', exact: true});
    await wire.focus(); await page.keyboard.press('Enter');
    const properties = page.locator('#mapping-editor > .object-editor');
    const addition = properties.locator(':scope > .add-property');
    await addition.locator('select').selectOption('factor');
    await addition.getByRole('button', {name: '+ Add', exact: true}).click();
    const factor = page.locator('#mapping-editor [data-property="factor"]');
    await factor.fill('3'); await factor.press('Tab'); await saved(page);
    expect((await state(request)).draft.outputs[0].mapping.fields[0])
      .toEqual({cot: 'send_time_ms', vmf: {key: 'renamed'}, factor: 3});
    await page.locator('[data-tab="schemas"]').click();
    await page.locator('#schema-undo').click(); await saved(page);
    const snapshot = await state(request);
    expect(snapshot.draft.schemas[0].document).toEqual(schema);
    expect(snapshot.draft.outputs[0].mapping.fields[0])
      .toEqual({cot: 'send_time_ms', vmf: {key: 'sent'}, factor: 3});
    expect(snapshot.valid).toBe(true);
    await page.locator('[data-tab="mapping"]').click();
    await expect(page.getByRole('button', {name: 'send_time_ms to sent', exact: true}))
      .toHaveCount(1);
  });

test('reimporting an identical exported schema selects the existing definition and keeps mappings',
  async ({page, request}) => {
    await page.goto('/');
    await page.locator('[data-tab="schemas"]').click();
    await page.locator('#import-schema').setInputFiles({
      name: 'payload.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(schema)),
    });
    await saved(page);
    await expect(page.locator('#schema-list [data-schema-id]')).toHaveCount(1);
    await page.locator('[data-tab="mapping"]').click();
    await page.locator('.source-port[data-source-path="send_time_ms"]').click();
    await page.locator('.target-port[data-target-key="sent"]').click();
    await saved(page);
    await expect(page.locator('path.wire')).toHaveCount(1);
    const before = await state(request);
    expect(before.draft.outputs).toHaveLength(1);
    expect(before.draft.outputs[0].mapping.fields[0].vmf).toEqual({key: 'sent'});
    await page.locator('[data-tab="schemas"]').click();
    await page.locator('#schema-list [data-schema-id="payload"]').click();
    const event = page.waitForEvent('download');
    await page.locator('#export-schema').click();
    const download = await event;
    const stream = await download.createReadStream(), chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    await page.locator('#import-schema').setInputFiles({
      name: 'copied-export.json', mimeType: 'application/json',
      buffer: Buffer.concat(chunks),
    });
    await expect(page.locator('#toast')).toContainText(/already/i);
    await expect(page.locator('#toast')).toContainText('payload');
    await expect(page.locator('#schema-list [data-schema-id]')).toHaveCount(1);
    await expect(page.locator('#schema-list [data-schema-id="payload"]'))
      .toHaveClass(/selected/);
    const after = await state(request);
    expect(after.draft.schemas).toEqual(before.draft.schemas);
    expect(after.draft.outputs).toEqual(before.draft.outputs);
    await page.locator('[data-tab="mapping"]').click();
    await expect(page.locator('.target-port')).toHaveCount(2);
    await expect(page.locator('path.wire')).toHaveCount(1);
  });

test('repairing one duplicated field key preserves references to the remaining owner',
  async ({page, request}) => {
    const document = structuredClone(schema);
    document.messages[0].elements = [
      {key: 'n', number_of_bits: 3},
      {key: 'n', number_of_bits: 4},
      {key: 'data', type: 'bits', number_of_bits: 8, length_from: 'n'},
    ];
    const retained = output('duplicate-key', {schema: 'payload', fields: [
      {cot: 'detail.status.battery', vmf: {key: 'n'}, factor: 2},
    ]});
    await payloadDraft(request, document, [retained]);
    expect((await state(request)).valid).toBe(false);
    await page.goto('/'); await payloadDefinition(page);
    await page.locator('.tree-select.field[data-node-path="/messages/0/elements/1"]')
      .click();
    const key = page.locator('#schema-editor [data-property="key"]');
    await key.fill('repaired'); await key.press('Tab'); await saved(page);
    const snapshot = await state(request);
    expect(snapshot.draft.schemas[0].document.messages[0].elements).toEqual([
      document.messages[0].elements[0],
      {...document.messages[0].elements[1], key: 'repaired'},
      document.messages[0].elements[2],
    ]);
    expect(snapshot.draft.outputs[0]).toEqual(retained);
    expect(snapshot.valid).toBe(true);
    expect(snapshot.active_revision).toBe(snapshot.draft_revision);
    await expect(page.locator('.guided-explanation'))
      .toContainText(/duplicat|ambig|review/i);
  });

test('pending schema edits explain how to save',
  async ({page, request}) => {
    await payloadDraft(request);
    await page.goto('/'); await payloadDefinition(page);
    await page.locator('.tree-select').filter({hasText: /^K01\.1$/}).click();
    const number = page.locator('#schema-editor [data-property="message_number"]');
    await number.fill('K01.2');
    const pending = page.getByText('Press Tab or leave this field to save', {exact: true});
    await expect(pending).toBeVisible();
    expect((await state(request)).draft.schemas[0].document.messages[0]
      .message_number).toBe('K01.1');
    await number.press('Tab');
    await expect.poll(async () => (await state(request)).draft.schemas[0]
      .document.messages[0].message_number).toBe('K01.2');
    await saved(page);
    await expect(pending).toBeHidden();
    expect((await state(request)).valid).toBe(true);
  });
