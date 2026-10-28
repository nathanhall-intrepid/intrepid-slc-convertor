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
const fail = (message, code, details = {}) => { const error = new SLCError(message, code); error.details = details; throw error; };
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
  const v = x - y, eps = Number.EPSILON * 8 * (Math.abs(x) + Math.abs(y));
  return Math.abs(v) <= eps ? 0 : Math.sign(v);
}
function onSegment(a, b, c) {
  return c[0] >= Math.min(a[0], b[0]) && c[0] <= Math.max(a[0], b[0]) && c[1] >= Math.min(a[1], b[1]) && c[1] <= Math.max(a[1], b[1]);
}
function intersects(a, b, c, d) {
  const o1 = orientation(a, b, c), o2 = orientation(a, b, d), o3 = orientation(c, d, a), o4 = orientation(c, d, b);
  return (o1 * o2 < 0 && o3 * o4 < 0) || (!o1 && onSegment(a, b, c)) || (!o2 && onSegment(a, b, d)) || (!o3 && onSegment(c, d, a)) || (!o4 && onSegment(c, d, b));
}
function normalizedRing(input, label, quantize = true) {
  if (!Array.isArray(input) || input.length < 3) fail(`${label} must have at least three vertices.`);
  const source = input.map((p, j) => {
    if ((!Array.isArray(p) && !ArrayBuffer.isView(p)) || p.length < 2) fail(`${label}, vertex ${j}: expected [x,y].`);
    return [finite(p[0], `${label} x`), finite(p[1], `${label} y`)];
  });
  if (source.length > 1 && equalPoint(source[0], source[source.length - 1])) source.pop();
  const r = []; let collapsedVertices = 0;
  for (let i = 0; i < source.length; i++) {
    if (i && equalPoint(source[i], source[i - 1])) fail(`${label} has repeated adjacent vertices.`);
    const p = quantize ? [f32(source[i][0], `${label} x`), f32(source[i][1], `${label} y`)] : source[i];
    if (r.length && equalPoint(p, r[r.length - 1])) { collapsedVertices++; continue; }
    r.push(p);
  }
  // Only zero-length edges created by float32 rounding may disappear. Never
  // merge nonadjacent points or discard a ring to make a contour encodable.
  if (r.length > 1 && equalPoint(r[0], r[r.length - 1])) { r.pop(); collapsedVertices++; }
  if (r.length < 3) fail(`${label} collapses after float32 conversion.`);
  const seen = new Set();
  for (const p of r) { const key = `${p[0]},${p[1]}`; if (seen.has(key)) fail(`${label} has repeated or float32-collapsed vertices.`); seen.add(key); }
  const area = signedRingArea(r);
  if (Math.abs(area) <= 1e-12) fail(`${label} has zero or negligible area.`);
  if (quantize && Math.sign(signedRingArea(source)) !== Math.sign(area)) fail(`${label} changes orientation after float32 conversion.`, 'contour-winding');
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of r) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  return { ring: r, area, minX, maxX, minY, maxY, collapsedVertices };
}

/** Reject self intersections, intersecting rings, and incorrect nesting/winding. */
function validateRings(inputs, label, maxChecks = 10000000, quantize = true) {
  if (!Array.isArray(inputs)) fail(`${label}: rings must be an array.`);
  const rings = inputs.map((r, i) => normalizedRing(r, `${label}, ring ${i + 1}`, quantize));
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
      if (intersects(prev.a, prev.b, edge.a, edge.b)) fail(`${label}: contours intersect or touch; a closed nonintersecting slice is required.`, 'contour-intersection', {segments: [{ring:prev.ri,a:prev.a,b:prev.b},{ring:edge.ri,a:edge.a,b:edge.b}]});
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
  // A quantization collapse must not hide a pre-existing intersection or hole.
  if (quantize && rings.some(r => r.collapsedVertices)) validateRings(inputs, `${label} before float32 conversion`, maxChecks, false);
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

function getExtents(bounds, firstZ, topZ, lastContourZ, supplied) {
  if (!Number.isFinite(bounds.minX)) fail('The build contains no nonempty contours.', 'empty-build');
  const extents = { min: [bounds.minX, bounds.minY, firstZ], max: [bounds.maxX, bounds.maxY, topZ] };
  if (supplied) {
    if (!Array.isArray(supplied.min) || !Array.isArray(supplied.max) || supplied.min.length !== 3 || supplied.max.length !== 3) fail('Extents must contain min/max [x,y,z] arrays.');
    for (let a = 0; a < 3; a++) {
      finite(supplied.min[a], 'Minimum extent'); finite(supplied.max[a], 'Maximum extent');
      if (supplied.min[a] > extents.min[a] + tolerance(extents.min[a]) || supplied.max[a] < extents.max[a] - tolerance(extents.max[a])) fail('Supplied model extents do not enclose the sliced geometry.');
    }
  }
  // Materialise/Intrepid compatibility: header Z spans contour records, not
  // the final layer top. The top remains in the sentinel and sampling table.
  // Validate supplied model bounds above, but do not let them override this.
  const source = supplied ?? extents;
  return { min: [source.min[0], source.min[1], firstZ], max: [source.max[0], source.max[1], lastContourZ] };
}

function encodedHeader(extents, options) {
  const packageName = String(options.packageName ?? 'LayerLab 1.0').replace(/[^\x20-\x7e]/g, '_').replace(/-/g, '_').slice(0, 32);
  const nums = [0, 1, 2].map(a => `${extents.min[a].toFixed(6)},${extents.max[a].toFixed(6)}`).join(' ');
  const headerText = `-SLCVER 2.0 -UNIT MM -TYPE PART -PACKAGE ${packageName} -EXTENTS ${nums} -CHORDDEV 0 -ARCRES 0 -SURFTOL 0 -GAPTOL 0 -MAXGAPFOUND 0 -EXTLWC 0\r\n\x1a`;
  const header = new TextEncoder().encode(headerText);
  if (header.length > HEADER_LIMIT) fail('SLC header exceeds 2048 bytes.');
  return header;
}

function verifyLayerBytes(bytes, minZMm, rings, index) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); let offset = 0;
  const float = () => { const value = view.getFloat32(offset, true); offset += 4; return value; };
  const uint = () => { const value = view.getUint32(offset, true); offset += 4; return value; };
  const invalid = () => fail(`Encoded layer ${index + 1} failed immediate read-back verification.`, 'export-verification');
  if (float() !== Math.fround(minZMm) || uint() !== rings.length) invalid();
  for (const { ring } of rings) {
    if (uint() !== ring.length + 1 || uint() !== 0) invalid();
    for (let i = 0; i <= ring.length; i++) {
      const point = ring[i % ring.length];
      if (float() !== point[0] || float() !== point[1]) invalid();
    }
  }
  if (offset !== bytes.length) invalid();
}

/**
 * Incremental writer. Retains compact encoded chunks and layer metadata only;
 * addLayer validates, normalizes and verifies one layer before releasing rings.
 * Call finish once after every scheduled layer has been supplied in order.
 */
export function createSLCEncoder(planLayers, options = {}) {
  const samplingTable = samplingTableForLayers(planLayers);
  const schedule = planLayers.map(({ zMm, thicknessUm }) => ({ zMm, thicknessUm }));
  const firstZ = samplingTable[0].minZMm, topZ = schedule[schedule.length - 1].zMm;
  const chunks = [], layerMetadata = [];
  const bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  const maxBytes = options.maxBytes ?? MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) fail('SLC byte limit must be a positive safe integer.');
  let state = 'open', chunkBytes = 0;
  const stats = { layerCount: 0, verifiedLayers: 0, contourVertexCount: 0, encodedVertexCount: 0, collapsedVertices: 0, precisionRepairs: [], byteLength: 0 };
  return {
    stats, layerMetadata,
    addLayer(layer) {
      if (state !== 'open') fail('The SLC encoder is closed or a previous layer failed.', 'encoder-state');
      try {
        const index = stats.layerCount, expected = schedule[index];
        if (!expected || !layer || layer.thicknessUm !== expected.thicknessUm || !near(layer.zMm, expected.zMm)) fail(`Layer ${index + 1} does not match the planned schedule.`, 'layer-schedule');
        const budget = options.maxGeometryChecks ?? 10000000, label = `Layer ${index + 1}`;
        let rings;
        try { rings = validateRings(layer.rings, label, budget); }
        catch (error) {
          if (!options.repairQuantizedContours || !['invalid-slc','contour-intersection','contour-winding'].includes(error.code)) throw error;
          // Never use precision recovery to hide an existing opening, crossing,
          // or cavity winding defect in the full-precision source contours.
          validateRings(layer.rings, `${label} before float32 conversion`, budget, false);
          const repaired = options.repairQuantizedContours(layer.rings, candidate => validateRings(candidate, label, budget));
          rings = repaired.rings; stats.precisionRepairs.push({layerIndex:index,zMm:expected.zMm,...repaired.report});
        }
        let length = 8, vertexCount = 0, collapsedVertices = 0;
        for (const r of rings) {
          length += 8 + (r.ring.length + 1) * 8; vertexCount += r.ring.length; collapsedVertices += r.collapsedVertices;
          bounds.minX = Math.min(bounds.minX, r.minX); bounds.maxX = Math.max(bounds.maxX, r.maxX);
          bounds.minY = Math.min(bounds.minY, r.minY); bounds.maxY = Math.max(bounds.maxY, r.maxY);
        }
        if (chunkBytes + length + 265 + samplingTable.length * 16 > maxBytes) fail('SLC output exceeds the browser export size limit.', 'output-size');
        const bytes = new Uint8Array(length), view = new DataView(bytes.buffer); let offset = 0;
        const float = value => { view.setFloat32(offset, value, true); offset += 4; };
        const uint = value => { view.setUint32(offset, value, true); offset += 4; };
        let start = expected.zMm - expected.thicknessUm / 1000; if (Math.abs(start) < 1e-10) start = 0;
        float(start); uint(rings.length);
        for (const { ring } of rings) {
          uint(ring.length + 1); uint(0);
          for (const point of ring) { float(point[0]); float(point[1]); }
          float(ring[0][0]); float(ring[0][1]);
        }
        if (offset !== length) fail('Internal SLC layer byte-length mismatch.');
        verifyLayerBytes(bytes, start, rings, index);
        const metadata = { index, minZMm: Math.fround(start), zMm: expected.zMm, thicknessUm: expected.thicknessUm, ringCount: rings.length, vertexCount, collapsedVertices, byteLength: length };
        chunks.push(bytes); layerMetadata.push(metadata); chunkBytes += length;
        stats.layerCount++; stats.verifiedLayers++; stats.contourVertexCount += vertexCount;
        stats.encodedVertexCount += vertexCount + rings.length; stats.collapsedVertices += collapsedVertices;
        options.onProgress?.({ stage: 'encoding', current: stats.layerCount, total: schedule.length, percent: stats.layerCount / schedule.length * 100, unit: 'layers' });
        return metadata;
      } catch (error) { state = 'failed'; chunks.length = 0; throw error; }
    },
    finish() {
      if (state !== 'open') fail('The SLC encoder is closed or a previous layer failed.', 'encoder-state');
      try {
        if (stats.layerCount !== schedule.length) fail(`Expected ${schedule.length} layers, received ${stats.layerCount}.`, 'layer-schedule');
        const last = schedule[schedule.length - 1];
        const lastContourZ = Math.max(firstZ, last.zMm - last.thicknessUm / 1000);
        const extents = getExtents(bounds, firstZ, topZ, lastContourZ, options.extents), header = encodedHeader(extents, options);
        const length = header.length + 256 + 1 + samplingTable.length * 16 + chunkBytes + 8;
        if (length > maxBytes) fail('SLC output exceeds the browser export size limit.', 'output-size');
        const bytes = new Uint8Array(length), view = new DataView(bytes.buffer); let offset = 0;
        const float = value => { view.setFloat32(offset, value, true); offset += 4; };
        const uint = value => { view.setUint32(offset, value, true); offset += 4; };
        bytes.set(header); offset = header.length + 256;
        bytes[offset++] = samplingTable.length;
        for (const entry of samplingTable) { float(entry.minZMm); float(entry.thicknessMm); float(0); float(0); }
        for (let i = 0; i < chunks.length; i++) { bytes.set(chunks[i], offset); offset += chunks[i].length; chunks[i] = null; }
        chunks.length = 0; float(topZ); uint(SENTINEL);
        if (offset !== length) fail('Internal SLC byte-length mismatch.');
        stats.byteLength = length; state = 'finished'; return bytes;
      } catch (error) { state = 'failed'; chunks.length = 0; throw error; }
    }
  };
}

export function encodeSLC(layers, options = {}) {
  const encoder = createSLCEncoder(layers, options);
  for (const layer of layers) encoder.addLayer(layer);
  return encoder.finish();
}

/**
 * Read SLC records and expand contours repeated over multiple sampling layers.
 * retainGeometry:false validates one contour at a time but stores only metadata.
 * onContour(contour,index) sees the current geometry before it is released.
 */
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
  const retainGeometry = options.retainGeometry !== false;
  const contours = []; let topZMm = null, totalVertices = 0, contourVertexCount = 0;
  const progress = () => options.onProgress?.({ stage: 'verifying', current: offset, total: bytes.length, percent: Math.min(100, offset / bytes.length * 100), unit: 'bytes' });
  progress();
  while (offset < bytes.length) {
    const minZMm = float() * scale, boundaryCount = uint();
    if (boundaryCount === SENTINEL) { topZMm = minZMm; break; }
    // A closed boundary needs two uint32 fields and at least four XY points.
    // Bound declared counts by the actual available bytes, not a global vertex
    // budget that rejects a valid large file merely for containing many layers.
    if (boundaryCount > Math.floor((bytes.length - offset) / 40)) fail('SLC boundary count exceeds the remaining file bytes.');
    if (contours.length && !(minZMm > contours[contours.length - 1].minZMm)) fail('SLC contour Z values must increase strictly.');
    const rings = []; let vertexCount = 0;
    for (let bi = 0; bi < boundaryCount; bi++) {
      const storedVertices = uint(), gaps = uint();
      if (gaps !== 0) fail('Open/gapped SLC contours are not supported.');
      if (storedVertices < 4 || storedVertices > Math.floor((bytes.length - offset) / 8)) fail('Invalid SLC vertex count or count exceeds the remaining file bytes.');
      totalVertices += storedVertices; vertexCount += storedVertices - 1;
      need(storedVertices * 8);
      const ring = [];
      for (let j = 0; j < storedVertices; j++) ring.push([float() * scale, float() * scale]);
      if (!equalPoint(ring[0], ring[ring.length - 1])) fail('SLC PART contour does not explicitly close.');
      ring.pop(); rings.push(ring);
    }
    if (options.validateGeometry !== false) validateRings(rings, `Decoded contour ${contours.length + 1}`, options.maxGeometryChecks ?? 10000000);
    const contour = { minZMm, rings, ringCount: rings.length, vertexCount };
    options.onContour?.(contour, contours.length);
    contours.push(retainGeometry ? contour : { minZMm, ringCount: rings.length, vertexCount });
    contourVertexCount += vertexCount;
    progress();
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
    const contour = contours[ci];
    const layer = { zMm: end, startZMm: z, thicknessUm: Math.abs(exactUm - Math.round(exactUm)) < .01 ? Math.round(exactUm) : exactUm, ringCount: contour.ringCount, vertexCount: contour.vertexCount };
    if (retainGeometry) layer.rings = contour.rings;
    layers.push(layer);
    if (layers.length > MAX_LAYERS) fail('Expanded SLC layer limit exceeded.');
    z = end;
  }
  progress();
  return { version: '2.0', unit: 'MM', sourceUnit: unitMatch[1], type: typeMatch[1], header, samplingTable, contours, layers, contourCount: contours.length, layerCount: layers.length, totalVertices, contourVertexCount, topZMm, byteLength: bytes.length, retainGeometry };
}
