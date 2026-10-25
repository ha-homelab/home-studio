// Portable local site geometry. Geographic map alignment is stored separately.
export const SITE_KINDS = Object.freeze(['home', 'roof', 'building', 'street', 'landscape']);
export const SITE_LIMITS = Object.freeze({ features: 64, points: 64, totalPoints: 1024, coordinate: 1000, groundElevation: 100, height: 100 });
const EPS = 1e-8;
const ID = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const RESERVED = new Set(['__proto__', 'prototype', 'constructor', 'toString', 'valueOf', 'hasOwnProperty', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString']);
const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const onEdge = (p, a, b) => Math.abs(cross(a, b, p)) <= EPS && p.every((v, i) => v >= Math.min(a[i], b[i]) - EPS && v <= Math.max(a[i], b[i]) + EPS);
function intersects(a, b, c, d) {
  const ab = [cross(a, b, c), cross(a, b, d)], cd = [cross(c, d, a), cross(c, d, b)];
  const opposite = ([x, y]) => x > EPS && y < -EPS || y > EPS && x < -EPS;
  return opposite(ab) && opposite(cd) || onEdge(a, c, d) || onEdge(b, c, d) || onEdge(c, a, b) || onEdge(d, a, b);
}
function fields(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(`${label}: expected an object.`);
  if (keys.some(key => !Object.hasOwn(value, key))) throw Error(`${label}: missing fields.`);
  if (Object.keys(value).some(key => !keys.includes(key))) throw Error(`${label}: unknown fields.`);
}
function number(value, low, high, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < low || value > high) throw Error(`${label}: expected a finite number between ${low} and ${high}.`);
}
export function validateSite(site) {
  fields(site, ['ground_elevation_m', 'features'], 'Site');
  number(site.ground_elevation_m, -SITE_LIMITS.groundElevation, SITE_LIMITS.groundElevation, 'Site ground elevation');
  if (!Array.isArray(site.features) || site.features.length > SITE_LIMITS.features) throw Error(`Site: at most ${SITE_LIMITS.features} features are allowed.`);
  const ids = new Set(); let count = 0;
  for (const feature of site.features) {
    fields(feature, ['id', 'name', 'kind', 'polygon', 'height_m', 'color'], 'Site feature');
    if (typeof feature.id !== 'string' || !ID.test(feature.id) || RESERVED.has(feature.id)) throw Error('Site feature: invalid identifier.');
    if (ids.has(feature.id)) throw Error(`Site: duplicate identifier ${feature.id}.`);
    ids.add(feature.id);
    if (typeof feature.name !== 'string' || !feature.name.trim() || [...feature.name].length > 120 || [...feature.name].some(c => c.codePointAt(0) < 32 || c.codePointAt(0) >= 0xd800 && c.codePointAt(0) <= 0xdfff)) throw Error('Site feature: name must be nonempty text of at most 120 characters without control characters or invalid Unicode.');
    if (!SITE_KINDS.includes(feature.kind)) throw Error('Site feature: invalid kind.');
    if (typeof feature.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(feature.color)) throw Error('Site feature: color must be #RRGGBB.');
    number(feature.height_m, 0, SITE_LIMITS.height, 'Site feature height');
    if (['street', 'landscape'].includes(feature.kind) && feature.height_m !== 0) throw Error('Street and landscape heights must be zero.');
    const p = feature.polygon;
    if (!Array.isArray(p) || p.length < 3 || p.length > SITE_LIMITS.points) throw Error(`Site feature: use 3–${SITE_LIMITS.points} polygon points.`);
    count += p.length;
    if (count > SITE_LIMITS.totalPoints) throw Error(`Site: at most ${SITE_LIMITS.totalPoints} polygon points are allowed.`);
    for (const point of p) {
      if (!Array.isArray(point) || point.length !== 2) throw Error('Site polygon point must be [x, z].');
      point.forEach(value => number(value, -SITE_LIMITS.coordinate, SITE_LIMITS.coordinate, 'Site coordinate'));
    }
    let area = 0;
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length], c = p[(i + 2) % p.length];
      area += a[0] * b[1] - b[0] * a[1];
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) < .01) throw Error('Site polygon edges must be at least 0.01 m long.');
      if (Math.abs(cross(a, b, c)) <= EPS && (a[0] - b[0]) * (c[0] - b[0]) + (a[1] - b[1]) * (c[1] - b[1]) > EPS) throw Error('Site polygon edges cannot overlap or reverse direction.');
      for (let j = i + 1; j < p.length; j++) {
        if (j === i + 1 || i === 0 && j === p.length - 1) continue;
        if (intersects(a, b, p[j], p[(j + 1) % p.length])) throw Error('Site polygon edges cannot cross or touch.');
      }
    }
    if (Math.abs(area) / 2 < .01) throw Error('Site polygon area must be at least 0.01 square metres.');
  }
  return site;
}
export function createSite() { return { ground_elevation_m: 0, features: [] }; }
export function siteBounds(site) {
  const points = (site?.features || []).flatMap(feature => feature.polygon);
  if (!points.length) return null;
  return { minX: Math.min(...points.map(p => p[0])), maxX: Math.max(...points.map(p => p[0])), minZ: Math.min(...points.map(p => p[1])), maxZ: Math.max(...points.map(p => p[1])) };
}
export function nextSiteId(site, kind) {
  if (!SITE_KINDS.includes(kind)) throw Error('Site feature: invalid kind.');
  const ids = new Set((site?.features || []).map(feature => feature.id));
  let index = 1; while (ids.has(`${kind}_${index}`)) index++;
  return `${kind}_${index}`;
}
