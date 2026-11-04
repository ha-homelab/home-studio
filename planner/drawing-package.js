// Deterministic drawing documents from one accepted metric project. No I/O.
import { validateProject, signedArea, pointInPolygon } from './model.js';
import { validateDocumentation, measurementState } from './documentation-model.js';

const EPS = 1e-7;
const MAX_BYTES = 2_000_000;
const MAX_SHEETS = 256;
const MAX_SVG_BYTES = 8 * 1024 * 1024;
const enc = new TextEncoder();
const fail = message => { throw new Error(message); };
const check = (value, message) => { if (!value) fail(message); };
const clean = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const n = value => Math.round(value * 1e6) / 1e6;
const fmt = value => String(n(value));
const label = value => String(value).slice(0, 80);
const distance = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);

function canonical(value) {
  let nodes = 0;
  const active = new Set();
  function visit(v, depth) {
    check(++nodes <= 100_000 && depth <= 24, 'Drawing input exceeds the structural limit.');
    if (v === null || typeof v === 'boolean') return JSON.stringify(v);
    if (typeof v === 'number') { check(Number.isFinite(v), 'Drawing input contains a nonfinite number.'); return JSON.stringify(v); }
    if (typeof v === 'string') { check(v.length <= MAX_BYTES, 'Drawing text is too large.'); return JSON.stringify(v); }
    check(typeof v === 'object' && !active.has(v), 'Drawing input must be acyclic JSON.');
    active.add(v);
    let result;
    if (Array.isArray(v)) {
      check(v.length <= 10_000, 'Drawing input array is too large.');
      result = '[' + v.map(x => visit(x, depth + 1)).join(',') + ']';
    } else {
      check(Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null, 'Drawing input must contain plain objects.');
      const keys = Object.keys(v).sort();
      check(keys.length <= 2048, 'Drawing input object is too large.');
      result = '{' + keys.map(k => JSON.stringify(k) + ':' + visit(v[k], depth + 1)).join(',') + '}';
    }
    active.delete(v);
    check(result.length <= MAX_BYTES, 'Drawing input exceeds 2 MB.');
    return result;
  }
  const result = visit(value, 0);
  check(enc.encode(result).length <= MAX_BYTES, 'Drawing input exceeds 2 MB.');
  return result;
}

// FNV-1a is a reproducibility label, never a signature or authorization check.
function fingerprint(text) {
  let hash = 0xcbf29ce484222325n;
  for (const byte of enc.encode(text)) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  return 'fnv1a64-' + hash.toString(16).padStart(16, '0');
}

function optionsFor(raw, project) {
  check(raw && typeof raw === 'object' && !Array.isArray(raw), 'Drawing options must be an object.');
  const allowed = ['revision', 'floorIds', 'roomIds', 'scale', 'paper', 'includeFurniture', 'wallProjectionDepthM', 'wastePercent'];
  check(Object.keys(raw).every(k => allowed.includes(k)), 'Unknown drawing option.');
  check(Number.isSafeInteger(raw.revision) && raw.revision >= 0, 'An accepted project revision is required.');
  const o = { revision: raw.revision, scale: raw.scale ?? 'auto', paper: raw.paper ?? 'A3',
    includeFurniture: raw.includeFurniture ?? false, wallProjectionDepthM: raw.wallProjectionDepthM ?? 1,
    wastePercent: raw.wastePercent ?? 0 };
  check(['auto', 50, 100, 200].includes(o.scale), 'Choose auto, 1:50, 1:100 or 1:200 scale.');
  check(['A3', 'A4'].includes(o.paper), 'Choose A3 or A4 paper.');
  check(typeof o.includeFurniture === 'boolean', 'Furniture projection must be true or false.');
  check(Number.isFinite(o.wallProjectionDepthM) && o.wallProjectionDepthM > 0 && o.wallProjectionDepthM <= 10, 'Projection depth must be greater than 0 and at most 10 m.');
  check(Number.isFinite(o.wastePercent) && o.wastePercent >= 0 && o.wastePercent <= 100, 'Waste must be between 0 and 100 percent.');
  for (const [key, valid] of [['floorIds', project.floors.map(f => f.id)],
    ['roomIds', project.floors.flatMap(f => f.rooms.map(r => f.id + '/' + r.id))]]) {
    const ids = raw[key] ?? valid;
    check(Array.isArray(ids) && ids.length > 0 && ids.length <= valid.length && new Set(ids).size === ids.length
      && ids.every(id => typeof id === 'string' && valid.includes(id)), 'Drawing selection contains an unknown or repeated ' + key + '.');
    o[key] = [...ids].sort();
  }
  return o;
}

function intervalLength(intervals) {
  const sorted = intervals.filter(([a, b]) => b > a + EPS).sort((a, b) => a[0] - b[0]);
  let total = 0, end = -Infinity;
  for (const [a, b] of sorted) { total += Math.max(0, b - Math.max(a, end)); end = Math.max(end, b); }
  return total;
}

function rectangleArea(rectangles) {
  const xs = [...new Set(rectangles.flatMap(r => [r.x0, r.x1]))].sort((a, b) => a - b);
  let result = 0;
  for (let i = 1; i < xs.length; i++) {
    const middle = (xs[i - 1] + xs[i]) / 2;
    result += (xs[i] - xs[i - 1]) * intervalLength(rectangles.filter(r => r.x0 < middle && r.x1 > middle).map(r => [r.y0, r.y1]));
  }
  return result;
}

function roomEdges(floor, room) {
  return room.polygon.map((a, index) => {
    const b = room.polygon[(index + 1) % room.polygon.length], length = distance(a, b);
    const u = [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
    const at = p => (p[0] - a[0]) * u[0] + (p[1] - a[1]) * u[1];
    const away = p => (p[0] - a[0]) * -u[1] + (p[1] - a[1]) * u[0];
    const spans = [], openings = [], walls = [];
    for (const wall of floor.walls) {
      if (Math.abs(away(wall.start)) > EPS || Math.abs(away(wall.end)) > EPS) continue;
      const start = at(wall.start), end = at(wall.end), low = Math.max(0, Math.min(start, end)), high = Math.min(length, Math.max(start, end));
      if (high <= low + EPS) continue;
      spans.push([low, high]); walls.push(wall);
      for (const opening of floor.openings.filter(v => v.wall_id === wall.id)) {
        const direction = Math.sign(end - start);
        const p = start + direction * opening.offset_m, q = p + direction * opening.width_m;
        const x0 = Math.max(0, Math.min(p, q)), x1 = Math.min(length, Math.max(p, q));
        const y0 = Math.max(0, opening.sill_m), y1 = Math.min(floor.height_m, opening.head_m);
        if (x1 > x0 + EPS && y1 > y0 + EPS) openings.push({ ...opening, x0, x1, y0, y1 });
      }
    }
    return { index, a, b, u, at, away, length, walls, openings,
      uncovered: Math.max(0, length - intervalLength(spans)), openingArea: rectangleArea(openings) };
  });
}

function statusFor(project, floor, type, id) {
  const row = project.documentation?.measurements.find(v => v.floor_id === floor.id && v.target_type === type && v.target_id === id);
  return row ? measurementState(project, row) : 'unknown';
}
function combined(states) {
  return ['stale', 'unknown', 'estimated', 'imported', 'measured'].find(state => states.includes(state)) || 'unknown';
}

function footprint(item) {
  const angle = item.rotation_deg * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, z]) => {
    x *= item.dimensions_m.width / 2; z *= item.dimensions_m.depth / 2;
    return [item.position_m.x + c * x + s * z, item.position_m.z - s * x + c * z];
  });
}

function clippedSegment(a, b, width, height) {
  let start = 0, end = 1;
  const delta = [b[0] - a[0], b[1] - a[1]];
  for (const [p, q] of [[-delta[0], a[0]], [delta[0], width - a[0]], [-delta[1], a[1]], [delta[1], height - a[1]]]) {
    if (Math.abs(p) < EPS) { if (q < -EPS) return null; continue; }
    const t = q / p;
    if (p < 0) start = Math.max(start, t); else end = Math.min(end, t);
    if (start > end) return null;
  }
  return [a.map((v, i) => v + start * delta[i]), a.map((v, i) => v + end * delta[i])];
}

const text = (x, y, value, size = 3, more = '') => `<text x="${fmt(x)}" y="${fmt(y)}" font-size="${fmt(size)}" ${more}>${clean(value)}</text>`;
const line = (x1, y1, x2, y2, more = '') => `<line x1="${fmt(x1)}" y1="${fmt(y1)}" x2="${fmt(x2)}" y2="${fmt(y2)}" ${more}/>`;

function sheet(meta, width, height, draw, options, identity, footer) {
  const [pageWidth, pageHeight] = options.paper === 'A3' ? [420, 297] : [297, 210];
  const usableWidth = pageWidth - 44, usableHeight = pageHeight - 78;
  const scales = options.scale === 'auto' ? [50, 100, 200] : [options.scale];
  const scale = scales.find(v => width * 1000 / v <= usableWidth && height * 1000 / v <= usableHeight);
  check(scale, 'Drawing ' + meta.title + ' does not fit the selected paper/scale. Select fewer rooms, larger paper or a smaller drawing scale.');
  const k = 1000 / scale;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${pageWidth}mm" height="${pageHeight}mm" viewBox="0 0 ${pageWidth} ${pageHeight}" role="img"><title>${clean(meta.title)}</title>` +
    `<rect x="0" y="0" width="${pageWidth}" height="${pageHeight}" fill="white"/><g font-family="sans-serif" fill="#182327">` +
    text(12, 14, label(meta.title), 4.5) + text(12, 21, `Revision ${options.revision} · ${identity} · 1:${scale} · dimensions in metres`, 2.5) +
    text(12, 27, `Geometry evidence: ${meta.measurementStatus}. Confirm dimensions before construction or procurement.`, 2.5) +
    `<g transform="translate(22 39) scale(${fmt(k)})" stroke="#182327" stroke-width="${fmt(.25 / k)}" fill="none">${draw(k)}</g>` +
    `<g stroke="#182327" stroke-width=".4">${line(12, pageHeight - 21, 12 + k, pageHeight - 21)}${line(12, pageHeight - 23, 12, pageHeight - 19)}${line(12 + k, pageHeight - 23, 12 + k, pageHeight - 19)}</g>` +
    text(12, pageHeight - 24, 'Scale bar: 1 m', 2.5) + text(12, pageHeight - 13, footer, 2.4) +
    text(12, pageHeight - 7, 'Print at 100% / actual size. Verify the scale bar. Quantities follow documented assumptions.', 2.4) + '</g></svg>';
  return { ...meta, filename: meta.id + '.svg', scale, paper: options.paper, svg };
}

function planSheet(floor, rooms, edgesByRoom, ceiling, options, identity, fixtures, measurementStatus) {
  const points = rooms.flatMap(r => r.polygon), minX = Math.min(...points.map(p => p[0])), minZ = Math.min(...points.map(p => p[1]));
  const width = Math.max(...points.map(p => p[0])) - minX, depth = Math.max(...points.map(p => p[1])) - minZ;
  const local = p => [p[0] - minX, p[1] - minZ];
  const id = floor.id + (ceiling ? '-ceiling' : '-plan');
  return sheet({ id, kind: ceiling ? 'ceiling' : 'floor-plan', floorId: floor.id, measurementStatus,
    title: `${floor.name} — ${ceiling ? 'Ceiling fixture plan' : 'Floor plan'}` }, width, depth, k => {
    const out = [];
    for (const room of rooms) {
      const poly = room.polygon.map(local);
      out.push(`<polygon points="${poly.map(p => p.map(fmt).join(',')).join(' ')}" fill="#f3f5f5"/>`);
      // Label at a boundary vertex; a concave polygon's centroid can lie outside it.
      out.push(text(poly[0][0] + .1, poly[0][1] + .2, label(room.name), 3 / k, 'fill="#182327" stroke="none"'));
      for (const edge of edgesByRoom.get(room.id)) {
        const a = local(edge.a), b = local(edge.b), mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        if (!ceiling) {
          out.push(text(mid[0], mid[1] - 2 / k, fmt(edge.length) + ' m', 2.5 / k, 'text-anchor="middle" fill="#182327" stroke="none"'));
        }
      }
    }
    if (!ceiling) for (const wall of floor.walls) {
      const segment = clippedSegment(local(wall.start), local(wall.end), width, depth);
      if (!segment) continue;
      out.push(line(...segment[0], ...segment[1], `stroke="#64747a" stroke-width="${fmt(wall.thickness_m)}"`));
      const length = distance(wall.start, wall.end), ux = (wall.end[0] - wall.start[0]) / length, uz = (wall.end[1] - wall.start[1]) / length;
      for (const o of floor.openings.filter(v => v.wall_id === wall.id)) {
        const p = local([wall.start[0] + ux * o.offset_m, wall.start[1] + uz * o.offset_m]);
        const q = [p[0] + ux * o.width_m, p[1] + uz * o.width_m];
        const opening = clippedSegment(p, q, width, depth);
        if (opening) out.push(line(...opening[0], ...opening[1], `stroke="${o.type === 'window' ? '#216185' : '#8d4b1d'}" stroke-width="${fmt(wall.thickness_m + .02)}"`));
      }
    }
    const selected = new Set(rooms.map(r => r.id));
    for (const item of floor.items.filter(i => selected.has(i.room))) {
      const p = local([item.position_m.x, item.position_m.z]);
      if (ceiling && fixtures.has(floor.id + '/' + item.id)) {
        if (p[0] < 0 || p[0] > width || p[1] < 0 || p[1] > depth) continue;
        out.push(`<circle cx="${fmt(p[0])}" cy="${fmt(p[1])}" r="${fmt(1.8 / k)}"/>`, line(p[0] - 2 / k, p[1], p[0] + 2 / k, p[1]),
          text(p[0] + 3 / k, p[1], label(item.name), 2.5 / k, 'fill="#182327" stroke="none"'));
      } else if (!ceiling && options.includeFurniture) {
        out.push(`<g clip-path="url(#${id}-bounds)"><polygon points="${footprint(item).map(local).map(v => v.map(fmt).join(',')).join(' ')}" stroke="#68747a" stroke-dasharray="${fmt(1 / k)} ${fmt(1 / k)}"/></g>`);
      }
    }
    return `<defs><clipPath id="${id}-bounds"><rect width="${fmt(width)}" height="${fmt(depth)}"/></clipPath></defs>` + out.join('');
  }, options, identity, ceiling ? `Ceiling datum ${fmt(floor.height_m)} m above floor; explicit fixture designations only. No soffit or service design inferred.` :
    'Room boundaries are authored metric outlines; colored segments indicate openings. Furniture is a projected envelope.');
}

function elevationSheet(floor, room, edge, options, identity, measurementStatus) {
  const id = `${floor.id}-${room.id}-elevation-${edge.index + 1}`;
  return sheet({ id, kind: 'elevation', floorId: floor.id, roomId: room.id, edgeIndex: edge.index, measurementStatus,
    title: `${floor.name} / ${room.name} — wall face ${edge.index + 1}` }, edge.length, floor.height_m, k => {
    const out = [`<rect x="0" y="0" width="${fmt(edge.length)}" height="${fmt(floor.height_m)}"/>`,
      text(edge.length / 2, -3 / k, `${fmt(edge.length)} m wide × ${fmt(floor.height_m)} m high`, 3 / k, 'text-anchor="middle" fill="#182327" stroke="none"')];
    for (const o of edge.openings) {
      out.push(`<rect x="${fmt(o.x0)}" y="${fmt(floor.height_m - o.y1)}" width="${fmt(o.x1 - o.x0)}" height="${fmt(o.y1 - o.y0)}" fill="#e8f1f5"/>`,
        text((o.x0 + o.x1) / 2, floor.height_m - (o.y0 + o.y1) / 2, `${o.type} ${fmt(o.x1 - o.x0)} × ${fmt(o.y1 - o.y0)} m; sill ${fmt(o.y0)} m`, 2.4 / k, 'text-anchor="middle" fill="#182327" stroke="none"'));
    }
    if (options.includeFurniture) for (const item of floor.items.filter(i => i.room === room.id)) {
      const corners = footprint(item), side = Math.sign(signedArea(room.polygon)), offsets = corners.map(p => side * edge.away(p));
      if (Math.min(...offsets) > options.wallProjectionDepthM || Math.max(...offsets) < -EPS) continue;
      const xs = corners.map(edge.at), x0 = Math.max(0, Math.min(...xs)), x1 = Math.min(edge.length, Math.max(...xs));
      if (x1 <= x0 + EPS) continue;
      out.push(`<rect x="${fmt(x0)}" y="${fmt(floor.height_m - item.position_m.y - item.dimensions_m.height)}" width="${fmt(x1 - x0)}" height="${fmt(item.dimensions_m.height)}" stroke="#68747a" stroke-dasharray="${fmt(1 / k)} ${fmt(1 / k)}"/>`);
    }
    return out.join('');
  }, options, identity, `Interior face along polygon edge ${edge.index + 1}; opening rectangles clipped to this face. Dashed furniture is an envelope, not joinery.`);
}

function csv(rows) {
  if (!rows.length) return '';
  const columns = Object.keys(rows[0]);
  const cell = value => {
    let s = String(value ?? '');
    if (typeof value !== 'number' && (/^[\s\u0000-\u001f]*[=+\-@]/.test(s) || /^[\t\r\n]/.test(s))) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  };
  return [columns, ...rows.map(row => columns.map(k => row[k]))].map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}

function htmlTable(name, rows) {
  if (!rows.length) return `<h2>${clean(name)}</h2><p>No entries.</p>`;
  const columns = Object.keys(rows[0]);
  return `<h2>${clean(name)}</h2><table><thead><tr>${columns.map(k => '<th>' + clean(k) + '</th>').join('')}</tr></thead><tbody>` +
    rows.map(row => '<tr>' + columns.map(k => '<td>' + clean(row[k] ?? '') + '</td>').join('') + '</tr>').join('') + '</tbody></table>';
}

/** Build standalone drawings and schedules; does not save, publish or alter the project. */
export function buildDrawingPackage(project, rawOptions) {
  const snapshot = canonical(project), accepted = JSON.parse(snapshot);
  validateProject(accepted);
  if (accepted.documentation) validateDocumentation(accepted.documentation, accepted);
  const options = optionsFor(rawOptions, accepted);
  const selected = accepted.floors.filter(f => options.floorIds.includes(f.id)).map(f => ({ floor: f,
    rooms: f.rooms.filter(r => options.roomIds.includes(f.id + '/' + r.id)) })).filter(v => v.rooms.length);
  check(selected.length > 0, 'Select at least one room.');
  check(selected.reduce((sum, v) => sum + 2 + v.rooms.reduce((count, r) => count + r.polygon.length, 0), 0) <= MAX_SHEETS,
    'The drawing package exceeds 256 sheets. Select fewer floors or rooms.');
  const identity = fingerprint(snapshot + '\n' + canonical(options));
  const warnings = new Set(), schedules = { rooms: [], openings: [], items: [], materials: [] }, sheets = [];
  const fixtures = new Set((accepted.documentation?.ceiling_fixture_ids || []).map(v => v.floor_id + '/' + v.item_id));
  const measurementRules = [
    'Areas and dimensions are computed from authored metric geometry; measurement status is separate from numerical precision.',
    'Room floor and flat ceiling areas equal polygon area. Wall face gross area equals room perimeter × floor height.',
    'Only openings on collinear room-boundary walls are deducted. Clipped opening rectangles are unioned before subtraction.',
    'Dimensions follow the drawn room boundaries; no wall-thickness correction or hidden construction allowance is applied.',
    'A shared wall contributes one interior finish face to each bordering room. These totals are surface areas, not physical wall volume.',
    'Unmatched boundary lengths remain assumed wall faces and are marked unknown. No reveals, soffits, skirting or service quantities are inferred.',
    'Waste is a separate allowance; quantities do not include it. The fingerprint is a non-security reproducibility label.'
  ];
  for (const { floor, rooms } of selected) {
    const edgesByRoom = new Map(), usedOpenings = new Set(), usedWalls = new Set(), selectedRooms = new Set(rooms.map(r => r.id));
    for (const room of rooms) {
      const edges = roomEdges(floor, room); edgesByRoom.set(room.id, edges);
      const perimeter = edges.reduce((sum, e) => sum + e.length, 0), area = Math.abs(signedArea(room.polygon));
      const gross = perimeter * floor.height_m, deducted = edges.reduce((sum, e) => sum + e.openingArea, 0);
      const uncovered = edges.reduce((sum, e) => sum + e.uncovered, 0), geometryStatus = statusFor(accepted, floor, 'room', room.id);
      const states = [geometryStatus];
      for (const e of edges) {
        e.walls.forEach(w => { usedWalls.add(w.id); states.push(statusFor(accepted, floor, 'wall', w.id)); });
        e.openings.forEach(o => { usedOpenings.add(o.id); states.push(statusFor(accepted, floor, 'opening', o.id)); });
      }
      if (uncovered > EPS) { states.push('unknown'); warnings.add(`${floor.name} / ${room.name}: ${fmt(uncovered)} m of room boundary has no collinear wall; wall area includes assumed faces.`); }
      const wallStatus = combined(states);
      if (geometryStatus !== 'measured' || wallStatus !== 'measured') warnings.add(`${floor.name} / ${room.name}: quantities include ${combined([geometryStatus, wallStatus])} geometry. Verify measurements.`);
      const net = Math.max(0, gross - deducted);
      schedules.rooms.push({ floor_id: floor.id, room_id: room.id, room: room.name, floor_area_m2: n(area), perimeter_m: n(perimeter),
        height_m: floor.height_m, gross_wall_area_m2: n(gross), opening_deduction_m2: n(deducted), net_wall_area_m2: n(net),
        unmatched_boundary_m: n(uncovered), floor_area_status: geometryStatus, wall_area_status: wallStatus });
      for (const [surface, quantity, status] of [['floor', area, geometryStatus], ['walls', net, wallStatus], ['ceiling', area, geometryStatus]]) {
        const finish = accepted.documentation?.finishes.find(v => v.floor_id === floor.id && v.room_id === room.id && v.surface === surface);
        const waste = finish?.waste_percent ?? options.wastePercent;
        schedules.materials.push({ floor_id: floor.id, room_id: room.id, room: room.name, surface, code: finish?.code || '',
          specification: finish?.specification || '', quantity_m2: n(quantity), measurement_status: status,
          quantity_basis: surface === 'ceiling' ? 'Flat footprint projection; ceiling construction is not verified' : surface === 'walls' ? 'Interior room-boundary faces' : 'Room footprint',
          waste_percent: waste, waste_m2: n(quantity * waste / 100), quantity_with_waste_m2: n(quantity * (1 + waste / 100)) });
      }
    }
    for (const o of floor.openings.filter(v => rooms.length === floor.rooms.length || usedOpenings.has(v.id))) schedules.openings.push({ floor_id: floor.id,
      opening_id: o.id, wall_id: o.wall_id, type: o.type, width_m: o.width_m, height_m: n(o.head_m - o.sill_m),
      sill_m: o.sill_m, head_m: o.head_m, area_m2: n(o.width_m * (o.head_m - o.sill_m)), measurement_status: statusFor(accepted, floor, 'opening', o.id) });
    if (rooms.length === floor.rooms.length) for (const o of floor.openings.filter(v => !usedOpenings.has(v.id)))
      warnings.add(`${floor.name}: opening ${o.id} is not on a room-boundary wall; it is not deducted from room finishes.`);
    if (rooms.length === floor.rooms.length) for (const wall of floor.walls.filter(v => !usedWalls.has(v.id)))
      warnings.add(`${floor.name}: wall ${wall.id} is not matched to a room boundary; additional finish faces are not included.`);
    for (const item of floor.items.filter(i => selectedRooms.has(i.room))) {
      const designated = fixtures.has(floor.id + '/' + item.id);
      const itemStatus = statusFor(accepted, floor, 'item', item.id);
      if (itemStatus !== 'measured') warnings.add(`${floor.name}: item ${item.id} dimensions are ${itemStatus}; verify before procurement or setting out.`);
      schedules.items.push({ floor_id: floor.id, item_id: item.id, room_id: item.room, name: item.name, type: item.type,
        model_id: item.model_id || '', quantity: 1,
        width_m: item.dimensions_m.width, depth_m: item.dimensions_m.depth, height_m: item.dimensions_m.height,
        bottom_m: item.position_m.y, ceiling_designated: designated ? 'yes' : 'no', measurement_status: itemStatus });
      const room = rooms.find(r => r.id === item.room);
      if (!pointInPolygon([item.position_m.x, item.position_m.z], room.polygon)) warnings.add(`${floor.name}: item ${item.id} lies outside its assigned room outline.`);
      if (designated && Math.abs(item.position_m.y + item.dimensions_m.height - floor.height_m) > .01)
        warnings.add(`${floor.name}: designated ceiling fixture ${item.id} does not meet the flat ceiling datum; verify its elevation.`);
    }
    const roomRows = schedules.rooms.filter(v => v.floor_id === floor.id), itemRows = schedules.items.filter(v => v.floor_id === floor.id);
    const planStatus = combined([...roomRows.flatMap(v => [v.floor_area_status, v.wall_area_status]),
      ...floor.walls.map(w => statusFor(accepted, floor, 'wall', w.id)), ...floor.openings.map(o => statusFor(accepted, floor, 'opening', o.id)),
      ...(options.includeFurniture ? itemRows.map(v => v.measurement_status) : [])]);
    const ceilingStatus = combined([...roomRows.map(v => v.floor_area_status), ...itemRows.filter(v => v.ceiling_designated === 'yes').map(v => v.measurement_status)]);
    sheets.push(planSheet(floor, rooms, edgesByRoom, false, options, identity, fixtures, planStatus),
      planSheet(floor, rooms, edgesByRoom, true, options, identity, fixtures, ceilingStatus));
    for (const room of rooms) for (const edge of edgesByRoom.get(room.id)) {
      const status = combined([statusFor(accepted, floor, 'room', room.id), ...(edge.uncovered > EPS ? ['unknown'] : []),
        ...edge.walls.map(w => statusFor(accepted, floor, 'wall', w.id)), ...edge.openings.map(o => statusFor(accepted, floor, 'opening', o.id)),
        ...(options.includeFurniture ? itemRows.filter(v => v.room_id === room.id).map(v => v.measurement_status) : [])]);
      sheets.push(elevationSheet(floor, room, edge, options, identity, status));
    }
  }
  check(sheets.reduce((sum, s) => sum + enc.encode(s.svg).length, 0) <= MAX_SVG_BYTES, 'Drawing vectors exceed 8 MiB. Select fewer rooms.');
  const warningList = [...warnings], title = clean(accepted.title);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title} — Drawing package</title><style>` +
    `@page{size:${options.paper} landscape;margin:0}*{box-sizing:border-box}body{margin:0;color:#182327;background:white;font:12px sans-serif}.sheet{break-after:page;page-break-after:always}.sheet svg{display:block;max-width:none}.schedule{padding:12mm}table{border-collapse:collapse;width:100%;font-size:9px;overflow-wrap:anywhere}th,td{border:1px solid #aab4b6;padding:4px;text-align:left}thead{display:table-header-group}tr{break-inside:avoid}h2{break-after:avoid}@media screen{.sheet{margin:16px auto;overflow:auto;border:1px solid #bbc}.schedule{max-width:1400px;margin:auto}}` +
    `</style></head><body>${sheets.map(s => '<section class="sheet">' + s.svg + '</section>').join('')}<section class="schedule"><h1>${title}</h1><p>Accepted revision ${options.revision}; ${identity}. Print at actual size and verify each scale bar.</p><h2>Measurement rules</h2><ul>` +
    measurementRules.map(v => '<li>' + clean(v) + '</li>').join('') + '</ul><h2>Review required</h2><ul>' +
    (warningList.length ? warningList : ['No unresolved measurement flags were found. This is not structural or services design approval.']).map(v => '<li>' + clean(v) + '</li>').join('') + '</ul>' +
    Object.entries(schedules).map(([key, rows]) => htmlTable(key, rows)).join('') + '</section></body></html>';
  check(enc.encode(html).length <= 16 * 1024 * 1024, 'Printable package exceeds 16 MiB. Select fewer rooms.');
  return { schema: 1, revision: options.revision, fingerprint: identity, measurementRules, warnings: warningList,
    schedules, sheets, csv: Object.fromEntries(Object.entries(schedules).map(([key, rows]) => [key, csv(rows)])), html, filename: 'drawing-package.html' };
}
