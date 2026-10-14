import assert from 'node:assert/strict';
import { projectOnWall, wallPieces, signedArea, pointInPolygon, validateProject } from '../planner/model.js';
import { CATALOG, supportsFurniturePattern } from '../planner/furniture.js';
import { assertFloorBounds, near } from './bounds-oracle.mjs';

export function fuzz(data) {
  if (data.length < 14 || data.length > 4096) return;
  const unit = i => data[i % data.length] / 255;
  const x = unit(0) * 80 - 40, z = unit(1) * 80 - 40;
  const width = 1 + unit(2) * 30, depth = 1 + unit(3) * 30;
  const height = 1 + unit(4) * 10;
  const angle = unit(5) * Math.PI * 2;
  const start = [x, z], end = [x + width * Math.cos(angle), z + width * Math.sin(angle)];
  const wall = { id: 'wall_a', start, end, thickness_m: 0.15 };
  const t = unit(6) * 3 - 1;
  const projection = projectOnWall([x + t * (end[0] - x), z + t * (end[1] - z)], wall);
  near(projection.offset, Math.max(0, Math.min(1, t)) * width);
  near(projection.length, width);
  near(projection.distance, Math.abs(t - Math.max(0, Math.min(1, t))) * width);
  const openingWidth = width * (0.1 + unit(7) * 0.3);
  const offset = unit(8) * (width - openingWidth);
  const sill = unit(9) * height * 0.3;
  const head = sill + height * (0.1 + unit(10) * 0.4);
  const opening = { id: 'window_a', wall_id: wall.id, type: 'window', offset_m: offset, width_m: openingWidth, sill_m: sill, head_m: head };
  const polygon = [[x,z], [x+width,z], [x+width,z+depth], [x,z+depth]];
  const project = { schema_version: 1, title: 'Fictional fuzz room', floors: [{ id: 'ground', name: 'Ground', elevation_m: 0, height_m: height, rooms: [{ id: 'room_a', name: 'Room', polygon, material: 'floor' }], walls: [wall], openings: [opening], items: [] }] };
  const model = CATALOG.models[data[11] % CATALOG.models.length];
  const item = {
    id: 'item_a', name: 'Fictional furniture', type: model.type, room: 'room_a',
    model_id: model.id, style_id: CATALOG.styles[data[12] % CATALOG.styles.length].id,
    color: '#' + data.subarray(0, 3).toString('hex'),
    position_m: { x, y: 0, z },
    dimensions_m: { width: 0.01 + unit(12) * 30, depth: 0.01 + unit(13) * 30, height: height / 2 },
    rotation_deg: unit(13) * 72000 - 36000, entity_id: '', notes: '',
  };
  if (supportsFurniturePattern(model)) {
    item.pattern_id = ['stripes', 'checks', 'diamonds', 'dots', 'herringbone', 'chevrons'][data[10] % 6];
    item.pattern_color = '#aabbcc';
  }
  project.floors[0].items.push(item);
  validateProject(project, { complete: true });
  const floor = project.floors[0];
  assertFloorBounds(floor);
  // Check items separately so a larger room cannot mask an incorrect item box.
  const isolated = { rooms: [], walls: [], items: [item] };
  const bounds = assertFloorBounds(isolated);
  const translated = structuredClone(isolated);
  translated.items[0].position_m.x += 7;
  translated.items[0].position_m.z -= 9;
  const moved = assertFloorBounds(translated);
  near(moved.minX, bounds.minX + 7); near(moved.maxX, bounds.maxX + 7);
  near(moved.minZ, bounds.minZ - 9); near(moved.maxZ, bounds.maxZ - 9);
  const pieces = wallPieces(wall, [opening], height);
  near(pieces.reduce((area, piece) => area + piece.width * piece.height, 0), width * height - openingWidth * (head - sill));
  for (const piece of pieces) {
    assert.ok(piece.offset >= -1e-8 && piece.offset + piece.width <= width + 1e-7);
    assert.ok(piece.bottom >= 0 && piece.bottom + piece.height <= height + 1e-7);
  }
  near(signedArea(polygon), width * depth);
  near(signedArea([...polygon].reverse()), -width * depth);
  assert.equal(pointInPolygon([x + width / 2, z + depth / 2], polygon), true);
  assert.equal(pointInPolygon([x - 1, z - 1], polygon), false);
  assert.equal(pointInPolygon(start, polygon, true), true);
  assert.equal(pointInPolygon(start, polygon, false), false);
}
