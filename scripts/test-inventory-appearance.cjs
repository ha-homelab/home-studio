// Exercise the installed viewer's real save handler without a GPU or HA server.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

const source = fs.readFileSync('viewer.js', 'utf8');
const functions = source.slice(source.indexOf('function inventoryAppearance('), source.indexOf('try{items=reconcileStoredAppearance('));
const saveHandler = source.slice(source.indexOf("$('itemForm').onsubmit="), source.indexOf('function exportInventoryJson('));
const item = () => ({ id: 'chair_1', name: 'Reading chair', type: 'furniture', room: 'study',
  position_m: { x: 1, y: 0, z: 2 }, dimensions_m: { width: .8, depth: .8, height: .9 },
  rotation_deg: 0, entity_id: '', notes: '', model_id: 'armchair', style_id: 'natural', color: '#4E9C99', pattern_id: 'checks', pattern_color: '#FFEEDD' });

function fixture(canEdit = true) {
  const initial = item();
  const values = { name: 'Renamed chair', kind: 'furniture', room: 'study', x: '3', y: '0', z: '4',
    w: '.9', d: '.8', h: '.9', rotation: '45', entity: '', notes: 'Beside the window' };
  const elements = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value }]));
  elements.itemForm = {};
  const context = vm.createContext({ items: [initial], editing: initial.id, presets: { furniture: [], lamp: [] },
    model: { rooms: [{ id: 'study' }], inventory: [initial] }, embedded: false, canEdit, $: id => elements[id],
    persistInventory() {}, rebuildInventoryView() {}, cancelInventoryEdit() {}, setEditorStatus() {} });
  vm.runInContext(functions + saveHandler, context);
  return { context, elements, submit: () => elements.itemForm.onsubmit({ preventDefault() {} }) };
}

test('editing placement and name retains catalog model, finish and custom color', () => {
  const { context, submit } = fixture();
  submit();
  const saved = JSON.parse(JSON.stringify(context.items[0]));
  assert.equal(saved.model_id, 'armchair');
  assert.equal(saved.style_id, 'natural');
  assert.equal(saved.color, '#4E9C99');
  assert.equal(saved.pattern_id, 'checks'); assert.equal(saved.pattern_color, '#FFEEDD');
  assert.equal(saved.name, 'Renamed chair');
  assert.deepEqual(saved.position_m, { x: 3, y: 0, z: 4 });
  assert.equal(saved.rotation_deg, 45);
});

test('changing semantic type clears an incompatible catalog appearance', () => {
  const { context, elements, submit } = fixture();
  elements.kind.value = 'lamp';
  submit();
  assert.equal(context.items[0].type, 'lamp');
  for (const key of ['model_id', 'style_id', 'color', 'pattern_id', 'pattern_color']) assert(!Object.hasOwn(context.items[0], key));
});

test('a family view cannot submit placement or appearance changes', () => {
  const { context, submit } = fixture(false);
  const before = JSON.stringify(context.items);
  submit();
  assert.equal(JSON.stringify(context.items), before);
});

test('legacy inventory is preserved and malformed appearance is rejected', () => {
  const { context } = fixture();
  const legacy = item();
  delete legacy.model_id; delete legacy.style_id; delete legacy.color; delete legacy.pattern_id; delete legacy.pattern_color;
  assert.equal(context.validateInventoryItems([legacy])[0], legacy);
  for (const mutation of [{ model_id: '../chair' }, { style_id: {} }, { color: 'url(https://example.invalid)' },
    { color: '#fff' }, { pattern_id: 'bad/path' }, { pattern_color: 'red' }, { pattern_id: 'none' }, { model_id: 'x'.repeat(65) }]) {
    assert.throws(() => context.validateInventoryItems([{ ...item(), ...mutation }]));
  }
  assert.throws(() => context.validateInventoryItems([{ ...legacy, color: '#ffffff' }]));
});

test('placement imports cannot silently claim an appearance absent from compiled assets', () => {
  const { context } = fixture();
  const moved = { ...item(), position_m: { x: 3, y: 0, z: 4 }, color: '#4e9c99' };
  assert.equal(context.validateImportedAppearance([moved])[0], moved);
  for (const mutation of [{ model_id: 'sofa_3' }, { style_id: 'monochrome' }, { color: '#ffffff' }, { id: 'new_chair' }, { pattern_id: 'stripes' }, { pattern_color: '#123456' }]) {
    assert.throws(() => context.validateImportedAppearance([{ ...item(), ...mutation }]), /rebuild and install/);
  }
});

test('rebuilding refreshes saved appearances while preserving positions and bindings', () => {
  const { context } = fixture();
  context.model.inventory[0] = { ...item(), model_id: 'sofa_2', style_id: 'monochrome', color: '#ffffff' };
  const saved = { ...item(), name: 'My moved chair', entity_id: 'light.reading', position_m: { x: 8, y: 0, z: 3 } };
  const [restored] = context.reconcileStoredAppearance([saved]);
  assert.equal(restored.model_id, 'sofa_2'); assert.equal(restored.color, '#ffffff');
  assert.equal(restored.style_id, 'monochrome'); assert.equal(restored.entity_id, saved.entity_id);
  assert.equal(restored.name, saved.name); assert.deepEqual(restored.position_m, saved.position_m);
  assert.equal(saved.model_id, 'armchair', 'The saved source remains unmodified');
  const [missing] = context.reconcileStoredAppearance([{ ...saved, id: 'deleted_design' }]);
  assert(!Object.hasOwn(missing, 'model_id')); assert.equal(missing.entity_id, saved.entity_id);
  const basic = { ...saved }; delete basic.model_id; delete basic.style_id; delete basic.color; delete basic.pattern_id; delete basic.pattern_color;
  assert.equal(context.reconcileStoredAppearance([basic])[0], basic, 'An intentionally generic object remains generic');
});


test('generated publication keeps commissioned geometry references and publishes a new catalog appearance', () => {
  // Feed the real generated adapter's output to the unchanged installed viewer.
  // The fixture is deliberately synthetic and lives entirely in a temporary directory.
  const publication = JSON.parse(execFileSync(process.env.PYTHON || 'python3', ['-B', '-c', `
import asyncio, copy, importlib.util, json, tempfile
from pathlib import Path
from unittest.mock import patch
spec = importlib.util.spec_from_file_location("generated_fixture", "scripts/test-ha-generated.py")
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
async def main():
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        component = root / "component"
        site, models, inventory = fixture.fixture(component)
        hass = fixture.support.Hass(root)
        with patch.object(fixture.generated, "compiler", return_value=fixture.compiler), patch.object(fixture.native, "compiler", return_value=fixture.compiler):
            adapter = fixture.generated.GeneratedProject(hass, component, site, models, inventory)
            await adapter.load()
            draft = copy.deepcopy(adapter.document["project"])
            item = draft["floors"][0]["items"][0]
            item.update(type="furniture", model_id="sofa_2", style_id="contemporary", color="#2A8E91",
                        entity_id="light.rebound_lamp", rotation_deg=92)
            item["position_m"]["x"] = 2.7
            await adapter.save(0, draft)
            assets, _, _, current, _ = await adapter.publish(1)
            print(json.dumps({"original": models["upper"]["inventory"][0],
                              "runtime": fixture.embedded_model(assets / "upper/index.html")["inventory"],
                              "current": current["upper"]["items"]}))
asyncio.run(main())
`], { encoding: 'utf8', timeout: 60000 }));
  const { context } = fixture();
  context.model.inventory = publication.runtime;
  const restored = JSON.parse(JSON.stringify(context.reconcileStoredAppearance(publication.current)));
  assert.deepEqual(restored, publication.current, 'Viewer reconciliation must retain the explicitly published appearance');
  assert.equal(restored[0].model_id, 'sofa_2');
  assert.equal(restored[0].style_id, 'contemporary');
  assert.equal(restored[0].color, '#2A8E91');
  assert.equal(publication.runtime[0].type, restored[0].type);
  assert.deepEqual(publication.runtime[0].position_m, publication.original.position_m);
  assert.deepEqual(publication.runtime[0].dimensions_m, publication.original.dimensions_m);
  assert.equal(publication.runtime[0].rotation_deg, publication.original.rotation_deg);
  assert.equal(publication.runtime[0].entity_id, publication.original.entity_id);
  assert.equal(restored[0].position_m.x, 2.7);
  assert.equal(restored[0].rotation_deg, 92);
  assert.equal(restored[0].entity_id, 'light.rebound_lamp');
});
