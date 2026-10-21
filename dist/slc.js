/**
 * SLC 2.0 PART writer and defensive reader. All public geometry is millimetres.
 * App layers use END Z; SLC records use MINIMUM Z. See ../slc-contract.md.
 * No printer-specific exposure settings are encoded in this contour format.
 */
export const SLC_MAX_SAMPLING_RUNS = 255;
const MAX_BYTES = 512 * 1024 * 1024;
const MAX_LAYERS = 1000000;
const HEADER_LIMIT = 2048;
const SENTINEL = 0xffffffff;

export class SLCError extends Error {
  constructor(message, code = 'invalid-slc') { super(message); this.name = 'SLCError'; this.code = code; }
}
const fail = (message, code) => { throw new SLCError(message, code); };
const finite = (x, name) => { if (typeof x !== 'number' || !Number.isFinite(x)) fail(`${name} must be finite.`); return x; };
const f32 = (x, name) => { finite(x, name); const r = Math.fround(x); if (!Number.isFinite(r)) fail(`${name} exceeds SLC float32 range.`); return r; };
const near = (a, b, tol = 1e-7) => Math.abs(a - b) <= tol;
const equalPoint = (a, b) => a[0] === b[0] && a[1] === b[1];
const tolerance = z => Math.max(1e-7, Math.min(.001, Math.abs(z) * 3e-7));

export function signedRingArea(ring) {
  if (ring.length < 3) return 0;
  let sum = 0; const [ox, oy] = ring[0];
  for (let i = 1; i < ring.length - 1; i++) sum += (ring[i][0] - ox) * (ring[i + 1][1] - oy) - (ring[i + 1][0] - ox) * (ring[i][1] - oy);
  return sum / 2;
}
function pointInRing(p, r) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const a = r[i], b = r[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
function orientation(a, b, c) {
  const x = (b[0] - a[0]) * (c[1] - a[1]);
  const y = (b[1] - a[1]) * (c[0] - a[0]);
  const v = x - y, eps = 1e-13 * (Math.abs(x) + Math.abs(y) + 1);
  return Math.abs(v) <= eps ? 0 : Math.sign(v);
}
function onSegment(a, b, c) {
  return c[0] >= Math.min(a[0], b[0]) && c[0] <= Math.max(a[0], b[0]) && c[1] >= Math.min(a[1], b[1]) && c[1] <= Math.max(a[1], b[1]);
}
function intersects(a, b, c, d) {
  const o1 = orientation(a, b, c), o2 = orientation(a, b, d), o3 = orientation(c, d, a), o4 = orientation(c, d, b);
  return (o1 * o2 < 0 && o3 * o4 < 0) || (!o1 && onSegment(a, b, c)) || (!o2 && onSegment(a, b, d)) || (!o3 && onSegment(c, d, a)) || (!o4 && onSegment(c, d, b));
}
function normalizedRing(input, label) {
  if (!Array.isArray(input) || input.length < 3) fail(`${label} must have at least three vertices.`);
  const r = input.map((p, j) => {
    if ((!Array.isArray(p) && !ArrayBuffer.isView(p)) || p.length < 2) fail(`${label}, vertex ${j}: expected [x,y].`);
    return [f32(p[0], `${label} x`), f32(p[1], `${label} y`)];
  });
  if (r.length > 1 && equalPoint(r[0], r[r.length - 1])) r.pop();
  if (r.length < 3) fail(`${label} collapses after float32 conversion.`);
  const seen = new Set();
  for (const p of r) { const key = `${p[0]},${p[1]}`; if (seen.has(key)) fail(`${label} has repeated or float32-collapsed vertices.`); seen.add(key); }
  const area = signedRingArea(r);
  if (Math.abs(area) <= 1e-12) fail(`${label} has zero or negligible area.`);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of r) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  return { ring: r, area, minX, maxX, minY, maxY };
}

/** Reject self intersections, intersecting rings, and incorrect nesting/winding. */
function validateRings(inputs, label, maxChecks = 10000000) {
  if (!Array.isArray(inputs)) fail(`${label}: rings must be an array.`);
  const rings = inputs.map((r, i) => normalizedRing(r, `${label}, ring ${i + 1}`));
  const edges = [];
  for (let ri = 0; ri < rings.length; ri++) {
    const r = rings[ri].ring;
    for (let i = 0; i < r.length; i++) {
      const a = r[i], b = r[(i + 1) % r.length];
      edges.push({ ri, i, n: r.length, a, b, minX: Math.min(a[0], b[0]), maxX: Math.max(a[0], b[0]), minY: Math.min(a[1], b[1]), maxY: Math.max(a[1], b[1]) });
    }
  }
  edges.sort((a, b) => a.minX - b.minX || a.minY - b.minY);
  let active = [], checks = 0;
  for (const edge of edges) {
    active = active.filter(p => p.maxX >= edge.minX);
    for (const prev of active) {
      if (++checks > maxChecks) fail(`${label}: geometry validation budget exceeded; simplify the STL before exporting.`, 'geometry-complexity');
      if (prev.maxY < edge.minY || edge.maxY < prev.minY) continue;
      if (edge.ri === prev.ri && (Math.abs(edge.i - prev.i) === 1 || Math.abs(edge.i - prev.i) === edge.n - 1)) continue;
      if (intersects(prev.a, prev.b, edge.a, edge.b)) fail(`${label}: contours intersect or touch; a closed nonintersecting slice is required.`, 'contour-intersection');
    }
    active.push(edge);
  }
  for (let i = 0; i < rings.length; i++) {
    const a = rings[i]; let depth = 0;
    for (let j = 0; j < rings.length; j++) {
      if (i === j) continue; const b = rings[j];
      if (a.minX < b.minX || a.maxX > b.maxX || a.minY < b.minY || a.maxY > b.maxY) continue;
      if (++checks > maxChecks) fail(`${label}: nesting validation budget exceeded.`, 'geometry-complexity');
      if (pointInRing(a.ring[0], b.ring)) depth++;
    }
    if ((a.area > 0) !== (depth % 2 === 0)) fail(`${label}, ring ${i + 1}: ${depth % 2 ? 'hole must be clockwise' : 'exterior must be counter-clockwise'}.`, 'contour-winding');
  }
  return rings;
}

/** One sampling-table entry per contiguous thickness run; no truncation. */
export function samplingTableForLayers(layers) {
  if (!Array.isArray(layers) || !layers.length || layers.length > MAX_LAYERS) fail(`Provide 1–${MAX_LAYERS} sliced layers.`);
  const entries = []; let previousEnd = null, lastThickness = null;
  layers.forEach((layer, i) => {
    const h = finite(layer.thicknessUm, `Layer ${i + 1} thickness`);
    if (!Number.isInteger(h) || h < 50 || h > 200) fail(`Layer ${i + 1}: thickness must be an integer from 50 to 200 µm.`, 'layer-thickness');
    const end = finite(layer.zMm, `Layer ${i + 1} end Z`), start = end - h / 1000;
    if (start < -1e-7) fail(`Layer ${i + 1} starts below Z=0.`);
    if (previousEnd !== null && !near(start, previousEnd)) fail(`Layer ${i + 1}: noncontiguous Z intervals.`, 'layer-gap');
    if (!(Math.fround(end) > Math.fround(start))) fail(`Layer ${i + 1}: Z increment is lost in SLC float32 precision.`);
    if (Math.abs((Math.fround(end) - Math.fround(start)) - h / 1000) > 0.001) fail(`Layer ${i + 1}: Z magnitude causes more than 1 µm float32 error.`);
    if (h !== lastThickness) entries.push({ minZMm: Math.abs(start) < 1e-10 ? 0 : start, thicknessMm: h / 1000, lineWidthCompensationMm: 0, reserved: 0 });
    lastThickness = h; previousEnd = end;
  });
  if (entries.length > SLC_MAX_SAMPLING_RUNS) fail(`SLC supports at most 255 unambiguous sampling-table runs; this plan has ${entries.length}. Reduce the number of thickness changes.`, 'sampling-table-limit');
  return entries;
}

function getExtents(ringsByLayer, firstZ, topZ, supplied) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const rings of ringsByLayer) for (const r of rings) {
    minX = Math.min(minX, r.minX); maxX = Math.max(maxX, r.maxX); minY = Math.min(minY, r.minY); maxY = Math.max(maxY, r.maxY);
  }
  if (!Number.isFinite(minX)) fail('The build contains no nonempty contours.', 'empty-build');
  const extents = { min: [minX, minY, firstZ], max: [maxX, maxY, topZ] };
  if (supplied) {
    if (!Array.isArray(supplied.min) || !Array.isArray(supplied.max) || supplied.min.length !== 3 || supplied.max.length !== 3) fail('Extents must contain min/max [x,y,z] arrays.');
    for (let a = 0; a < 3; a++) {
      finite(supplied.min[a], 'Minimum extent'); finite(supplied.max[a], 'Maximum extent');
      if (supplied.min[a] > extents.min[a] + tolerance(extents.min[a]) || supplied.max[a] < extents.max[a] - tolerance(extents.max[a])) fail('Supplied model extents do not enclose the sliced geometry.');
    }
    return supplied;
  }
  return extents;
}

export function encodeSLC(layers, options = {}) {
  const samplingTable = samplingTableForLayers(layers);
  const ringsByLayer = layers.map((layer, i) => validateRings(layer.rings, `Layer ${i + 1}`, options.maxGeometryChecks ?? 10000000));
  const firstZ = samplingTable[0].minZMm, topZ = layers[layers.length - 1].zMm;
  const extents = getExtents(ringsByLayer, firstZ, topZ, options.extents);
  const packageName = String(options.packageName ?? 'LayerLab 1.0').replace(/[^\x20-\x7e]/g, '_').replace(/-/g, '_').slice(0, 32);
  const nums = [0, 1, 2].map(a => `${extents.min[a].toFixed(6)},${extents.max[a].toFixed(6)}`).join(' ');
  const headerText = `-SLCVER 2.0 -UNIT MM -TYPE PART -PACKAGE ${packageName} -EXTENTS ${nums} -CHORDDEV 0 -ARCRES 0 -SURFTOL 0 -GAPTOL 0 -MAXGAPFOUND 0 -EXTLWC 0\r\n\x1a`;
  const header = new TextEncoder().encode(headerText);
  if (header.length > HEADER_LIMIT) fail('SLC header exceeds 2048 bytes.');
  let length = header.length + 256 + 1 + samplingTable.length * 16 + 8;
  for (const rings of ringsByLayer) { length += 8; for (const r of rings) length += 8 + (r.ring.length + 1) * 8; }
  if (length > (options.maxBytes ?? MAX_BYTES)) fail('SLC output exceeds the browser export size limit.', 'output-size');
  const bytes = new Uint8Array(length), view = new DataView(bytes.buffer); let offset = 0;
  const float = value => { view.setFloat32(offset, value, true); offset += 4; };
  const uint = value => { view.setUint32(offset, value, true); offset += 4; };
  bytes.set(header, offset); offset += header.length + 256; // Uint8Array reserved section is zero filled.
  bytes[offset++] = samplingTable.length;
  for (const entry of samplingTable) { float(entry.minZMm); float(entry.thicknessMm); float(0); float(0); }
  layers.forEach((layer, i) => {
    let start = layer.zMm - layer.thicknessUm / 1000; if (Math.abs(start) < 1e-10) start = 0;
    float(start); uint(ringsByLayer[i].length);
    for (const { ring } of ringsByLayer[i]) {
      uint(ring.length + 1); uint(0); // Closed PART contour: zero gaps.
      for (const point of [...ring, ring[0]]) { float(point[0]); float(point[1]); }
    }
  });
  float(topZ); uint(SENTINEL);
  if (offset !== length) fail('Internal SLC byte-length mismatch.');
  return bytes;
}

/** Read SLC records and expand contours repeated over multiple sampling layers. */
export function decodeSLC(input, options = {}) {
  const bytes = input instanceof Uint8Array ? input : input instanceof ArrayBuffer ? new Uint8Array(input) : null;
  if (!bytes || bytes.byteLength < 267) fail('SLC input is missing or truncated.');
  if (bytes.byteLength > (options.maxBytes ?? MAX_BYTES)) fail('SLC input exceeds the size limit.');
  let headerEnd = -1;
  for (let i = 0; i < Math.min(HEADER_LIMIT - 2, bytes.length - 2); i++) if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 26) { headerEnd = i + 3; break; }
  if (headerEnd < 0) fail('SLC header terminator is absent within 2048 bytes.');
  const header = new TextDecoder('ascii').decode(bytes.subarray(0, headerEnd - 3));
  if (!/-SLCVER\s*2\.0(?:\s|$)/.test(header)) fail('Only SLC version 2.0 is supported.');
  const unitMatch = header.match(/-UNITS?\s*(MM|INCH)(?:\s|$)/), typeMatch = header.match(/-TYPE\s*(PART|SUPPORT|WEB)(?:\s|$)/);
  if (!unitMatch || !typeMatch || typeMatch[1] === 'WEB') fail('A closed PART or SUPPORT SLC with known MM/INCH units is required.');
  const scale = unitMatch[1] === 'INCH' ? 25.4 : 1;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); let offset = headerEnd + 256;
  const need = n => { if (offset + n > bytes.length) fail(`Truncated SLC at byte ${offset}.`); };
  const float = () => { need(4); const x = view.getFloat32(offset, true); offset += 4; return finite(x, 'SLC float'); };
  const uint = () => { need(4); const x = view.getUint32(offset, true); offset += 4; return x; };
  need(1); const tableSize = bytes[offset++];
  if (!tableSize) fail('SLC sampling-table size 0 is ambiguous/unsupported; expected 1–255.', 'sampling-table-limit');
  const samplingTable = [];
  for (let i = 0; i < tableSize; i++) {
    const row = { minZMm: float() * scale, thicknessMm: float() * scale, lineWidthCompensationMm: float() * scale, reserved: float() };
    if (!(row.thicknessMm > 0) || (i && !(row.minZMm > samplingTable[i - 1].minZMm))) fail('Invalid SLC sampling-table order or thickness.');
    if (Math.abs(row.lineWidthCompensationMm) > 1e-12) fail('SLC line-width compensation is not supported by this validator.');
    samplingTable.push(row);
  }
  const contours = []; let topZMm = null, totalVertices = 0;
  while (offset < bytes.length) {
    const minZMm = float() * scale, boundaryCount = uint();
    if (boundaryCount === SENTINEL) { topZMm = minZMm; break; }
    if (contours.length >= MAX_LAYERS || boundaryCount > 200000) fail('SLC contour-count limit exceeded.');
    if (contours.length && !(minZMm > contours[contours.length - 1].minZMm)) fail('SLC contour Z values must increase strictly.');
    const rings = [];
    for (let bi = 0; bi < boundaryCount; bi++) {
      const vertexCount = uint(), gaps = uint();
      if (gaps !== 0) fail('Open/gapped SLC contours are not supported.');
      if (vertexCount < 4 || vertexCount > 2000000 || (totalVertices += vertexCount) > 20000000) fail('Invalid SLC vertex count or geometry limit exceeded.');
      need(vertexCount * 8);
      const ring = [];
      for (let j = 0; j < vertexCount; j++) ring.push([float() * scale, float() * scale]);
      if (!equalPoint(ring[0], ring[ring.length - 1])) fail('SLC PART contour does not explicitly close.');
      ring.pop(); rings.push(ring);
    }
    if (options.validateGeometry !== false) validateRings(rings, `Decoded contour ${contours.length + 1}`, options.maxGeometryChecks ?? 10000000);
    contours.push({ minZMm, rings });
  }
  if (topZMm === null || !contours.length) fail('SLC top-of-part terminator or contours are missing.');
  if (offset !== bytes.length) fail('Unexpected bytes after SLC terminator.');
  if (!(topZMm > contours[contours.length - 1].minZMm)) fail('Top-of-part Z must exceed the last contour minimum Z.');
  if (!near(samplingTable[0].minZMm, contours[0].minZMm, tolerance(contours[0].minZMm))) fail('First sampling entry must start at the first contour.');
  if (samplingTable[samplingTable.length - 1].minZMm >= topZMm) fail('Sampling table extends beyond the part.');
  const layers = []; let z = contours[0].minZMm, ci = 0, si = 0;
  while (z < topZMm - tolerance(topZMm)) {
    while (ci + 1 < contours.length && near(z, contours[ci + 1].minZMm, tolerance(z))) { ci++; z = contours[ci].minZMm; }
    while (si + 1 < samplingTable.length && near(z, samplingTable[si + 1].minZMm, tolerance(z))) { si++; z = samplingTable[si].minZMm; }
    const row = samplingTable[si];
    const fence = Math.min(topZMm, contours[ci + 1]?.minZMm ?? Infinity, samplingTable[si + 1]?.minZMm ?? Infinity);
    let end = z + row.thicknessMm;
    if (near(end, fence, tolerance(fence))) end = fence;
    if (!(end > z) || end > fence + tolerance(fence)) fail('Sampling thickness crosses a contour/table/top boundary.');
    const exactUm = row.thicknessMm * 1000;
    layers.push({ zMm: end, startZMm: z, thicknessUm: Math.abs(exactUm - Math.round(exactUm)) < .01 ? Math.round(exactUm) : exactUm, rings: contours[ci].rings });
    if (layers.length > MAX_LAYERS) fail('Expanded SLC layer limit exceeded.');
    z = end;
  }
  return { version: '2.0', unit: 'MM', sourceUnit: unitMatch[1], type: typeMatch[1], header, samplingTable, contours, layers, topZMm, byteLength: bytes.length };
}
