const { test, expect } = require('@playwright/test');
const dgram = require('node:dgram');

const empty = { format: 'cot-vmf-workspace/1', schemas: [], outputs: [] };
const schema = {
  format: 'vmf-schema/1', envelope: 'C', standard_version: 0,
  messages: [{ message_number: 'K01.1', indexes: [
    { index_number: '1.', key: 'sent', number_of_bits: 64 },
    { index_number: '2.', key: 'battery', number_of_bits: 32 },
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
      { cot: 'send_time_ms', vmf: { index: '1.' }, factor: 123 },
      { cot: 'detail.status.battery', vmf: { index: '2.' } },
    ] })]);
    await page.goto('/');
    const wire = page.getByRole('button', { name: 'send_time_ms to 1', exact: true });
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
    vmf_header: { fields: { messages: [{ id: {
      user_message_format: 2, standard_version: 0,
      identification: { functional_area: 1, message_number: 1 },
    } }] } }, fields: [], ...mapping,
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
      { cot: 'send_time_ms', vmf: { index: '1.' } },
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
    header.mapping.vmf_header.fields.messages[0].id.identification.message_number = 9;
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
    const number = page.locator('#mapping-editor [data-property="message_number"]');
    await number.fill('1'); await number.press('Tab');
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
      { cot: 'send_time_ms', vmf: { index: '1.' } },
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
      .toEqual({ cot: '', vmf: {} });
    await page.getByRole('button', { name: 'Replace with object', exact: true }).click();
    await saved(page);
    expect((await state(request)).draft.outputs[1].mapping.fields[1])
      .toEqual({ cot: '', vmf: {} });
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
    const width = page.locator('#schema-editor [data-property="number_of_bits"]');
    await width.fill('16');
    await width.press('Tab');
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
      return value.draft.schemas[0].document.messages[0].indexes[0].key;
    }).toBe('pending-name');
    expect((await state(request)).valid).toBeTruthy();
  });

test('deleting a schema removes its outputs and retains unrelated outputs',
  async ({ page, request }) => {
    const current = await state(request);
    const output = (id, schemaId, enabled) => ({ id, enabled, mapping: {
      format: 'cot-vmf-mapping-config/1', schema: schemaId,
      vmf_header: { fields: { messages: [{ id: {
        user_message_format: 2, standard_version: 0,
        identification: { functional_area: 1, message_number: 1 },
      } }] } }, fields: [],
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
    await expect(page.locator('.message-enable input:checked')).toHaveCount(1);
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
    const width = page.locator('#schema-editor [data-property="number_of_bits"]');
    await width.fill('16'); await width.press('Tab');
    await saved(page);
    await expect.poll(async () => {
      const value = await state(request);
      return value.draft.schemas[0]?.document.messages[0]?.indexes[0]?.number_of_bits;
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
        ...schema, messages: [{ message_number: 'K01.1', indexes: [
          { index_number: '1.', number_of_bits: 64 },
          { index_number: '2.', number_of_bits: 64 },
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

test('invalid visual draft remains editable while active revision survives',
  async ({ page, request }) => {
    const current = await state(request);
    const document = {
      format: 'cot-vmf-workspace/1',
      schemas: [{ id: 'synthetic', document: schema }], outputs: [],
    };
    await request.post('/api/state', { data: {
      revision: current.draft_revision, workspace: document,
    } });
    const active = (await state(request)).active_revision;
    await page.goto('/');
    await page.locator('[data-tab="schemas"]').click();
    await page.locator('#schema-list [data-schema-id="synthetic"]').click();
    await page.locator('.tree-select.field').first().click();
    const width = page.locator('#schema-editor [data-property="number_of_bits"]');
    await width.fill('0'); await width.press('Tab');
    await expect.poll(async () => (await state(request)).valid).toBe(false);
    expect((await state(request)).active_revision).toBe(active);
    await expect(page.locator('#draft-error')).toBeVisible();
    await page.reload();
    expect((await state(request)).draft.schemas[0].document.messages[0]
      .indexes[0].number_of_bits).toBe(0);
  });

test('native schema import and export preserve exact integers and metadata',
  async ({ page, request }) => {
    const source = '{"format":"vmf-schema/1","envelope":"C",' +
      '"standard_version":0,"messages":[{"message_number":"K01.1",' +
      '"octet_order":"msb_first","indexes":[{"index_number":"1.",' +
      '"key":"exact","number_of_bits":64,"encode_type":"scaled",' +
      '"bit_order":"msb_first","constant":18446744073709551615,' +
      '"allowed":[{"first":0,"last":18446744073709551615}],' +
      '"scale":{"factor":{"numerator":1,"denominator":3},' +
      '"bias":{"numerator":-9223372036854775808,"denominator":1},' +
      '"sentinels":[18446744073709551614]}},{"index_number":"2.",' +
      '"number_of_bits":1,"encode_type":"bool","when":{"mode":"all",' +
      '"terms":[{"field":"1.","values":[{"first":0,' +
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
    expect(exported).toContain('"mode": "all"');
    expect(exported).not.toContain('18446744073709552000');
    await page.screenshot({ path: '/tests/test-results/schema-authoring.png',
      fullPage: true });
  });

test('stimulated authoring accepts a subset and explains each test result',
  async ({ page, request }) => {
    const definition = structuredClone(schema);
    definition.messages[0].indexes.push(
      { index_number: '3.', indicator: 'fpi', target: '3.1' },
      { index_number: '3.1', key: 'optional', number_of_bits: 16 });
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
      { cot: 'send_time_ms', vmf: { index: '1.' }, factor: 1e-300 },
      { cot: 'detail.status.battery', vmf: { index: '2.' } },
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
      { cot: 'send_time_ms', vmf: { index: '1.' } },
      { cot: 'detail.status.battery', vmf: { index: '2.' } },
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
      format: 'vmf-schema/1', envelope: 'B', messages: [],
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
    const width = page.locator('#schema-editor [data-property="number_of_bits"]');
    await width.fill('16'); await width.press('Tab');
    await saveStarted;
    const key = page.locator('#schema-editor [data-property="key"]');
    await key.fill('pending-after-failure');
    releaseSave();
    await expect(page.locator('#save-status')).toContainText('Draft not active');
    await expect(key).toHaveValue('pending-after-failure');
    await expect(key).toBeFocused();
    await key.press('Tab');
    await expect.poll(async () => (await state(request)).draft.schemas[0]
      .document.messages[0].indexes[0].key).toBe('pending-after-failure');
    await expect(page.locator('#save-status')).toHaveText('Changes saved');
    const saved = await state(request);
    expect(saved.draft.schemas[0].document.messages[0].indexes[0].number_of_bits)
      .toBe(16);
    expect(saved.active_revision).toBe(saved.draft_revision);
    await expect(page.locator('#toast')).not.toContainText('another window');
  });
