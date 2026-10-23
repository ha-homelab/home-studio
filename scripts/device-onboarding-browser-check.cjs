const assert = require('node:assert/strict');

module.exports = async function checkDeviceOnboarding(context, origin, errors) {
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(String(error)));
  await page.addInitScript(() => {
    const entity = (id, extra = {}) => ({ entity_id: id, domain: id.split('.')[0], name: id, area_id: 'living', ...extra });
    window.catalogOverride = {
      floors: [{ id: 'ground', name: 'Ground floor' }],
      areas: [{ id: 'living', name: 'Living', floor_id: 'ground' }, { id: 'kitchen', name: 'Kitchen', floor_id: 'ground' }],
      entities: [entity('media_player.speaker', { device_class: 'speaker', attributes: { token: 'PRIVATE_STATE' } }),
        entity('media_player.television', { device_class: 'tv' }), entity('media_player.unknown'),
        entity('sensor.temperature', { device_class: 'temperature' }), entity('sensor.battery', { device_class: 'battery', entity_category: 'diagnostic' }),
        entity('light.hidden', { hidden: true }), entity('switch.config', { entity_category: 'config' }),
        ...Array.from({ length: 90 }, (_, i) => entity(`light.fixture_${i}`))],
    };
  });
  await page.goto(origin + '/fixture'); await page.waitForFunction(() => window.host?._ready);
  const frame = page.frames().find(frame => frame.url().includes('embed='));
  assert.equal(await page.evaluate(() => JSON.stringify(host._catalog).includes('PRIVATE_STATE')), false);
  assert.deepEqual(await page.evaluate(() => host._catalog.entities.slice(0, 3).map(e => e.device_class)), ['speaker', 'tv', '']);
  await frame.locator('#start-ha-areas').click();
  const starter = frame.getByRole('dialog', { name: 'Start rooms from Home Assistant areas' });
  assert.equal(await starter.getByRole('button', { name: 'Create selected rooms' }).isDisabled(), true);
  await starter.getByLabel('Living · living', { exact: true }).check();
  assert.equal(await starter.getByLabel('Living width (m)', { exact: true }).inputValue(), '', 'No dimensions are inferred from HA');
  await starter.getByLabel('Living width (m)', { exact: true }).fill('5');
  await starter.getByLabel('Living depth (m)', { exact: true }).fill('4');
  await starter.getByLabel('Kitchen · kitchen', { exact: true }).check();
  await starter.getByLabel('Kitchen width (m)', { exact: true }).fill('3');
  await starter.getByLabel('Kitchen depth (m)', { exact: true }).fill('2');
  await starter.getByRole('button', { name: 'Create selected rooms' }).click();
  await starter.waitFor({ state: 'hidden' });
  let project = await frame.evaluate(() => planner.getProject());
  assert.equal(project.floors[0].rooms.length, 2); assert.equal(project.floors[0].walls.length, 8);
  await frame.getByRole('button', { name: 'Choose multiple devices…' }).click();
  const devices = frame.getByRole('dialog', { name: 'Add devices to Living' });
  assert.equal(await devices.getByRole('checkbox').count(), 81, 'Only 80 device matches are rendered plus the Other entities toggle');
  assert.equal(await devices.getByLabel('sensor.battery · sensor.battery', { exact: true }).count(), 0);
  assert.equal(await devices.getByLabel('light.hidden · light.hidden', { exact: true }).count(), 0);
  assert.equal(await devices.getByLabel('switch.config · switch.config', { exact: true }).count(), 0);
  for (const name of ['speaker', 'television', 'unknown']) await devices.getByLabel(`media_player.${name} · media_player.${name}`, { exact: true }).check();
  await devices.getByLabel('media_player.unknown controls', { exact: true }).selectOption('tv');
  await devices.getByLabel('Find a device', { exact: true }).fill('fixture_89');
  await devices.getByLabel('light.fixture_89 · light.fixture_89', { exact: true }).check();
  await devices.getByRole('button', { name: 'Add selected devices' }).click();
  await devices.waitFor({ state: 'hidden' });
  project = await frame.evaluate(() => planner.getProject());
  assert.deepEqual(project.floors[0].items.map(item => item.type), ['appliance', 'tv', 'tv', 'lamp']);
  assert.equal(new Set(project.floors[0].items.map(item => `${item.position_m.x}:${item.position_m.z}`)).size, 4);
  await frame.getByRole('button', { name: 'Choose multiple devices…' }).click();
  await devices.getByLabel('Find a device', { exact: true }).fill('media_player');
  assert.equal(await devices.getByRole('checkbox').count(), 1, 'All previously linked players are excluded');
  await devices.getByRole('button', { name: 'Cancel', exact: true }).click();
  await frame.getByLabel('Add device to this room', { exact: true }).selectOption('sensor.temperature');
  await frame.getByRole('button', { name: 'Add linked item', exact: true }).click();
  assert.equal(await frame.evaluate(() => planner.getProject().floors[0].items.length), 5, 'Individual add remains available');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await page.waitForFunction(() => !host._busy && !host._unsaved());
  assert.equal(await page.evaluate(() => server.project.floors[0].items[0].type), 'appliance');
  await page.close();
};
