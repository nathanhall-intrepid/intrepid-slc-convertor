/** Browser-local job worker. Cancel a job by terminating its worker instance. */
import { ENGINE_LIMITS, parseSTL, analyzeMesh, repairMesh, computeBounds, createDemoMesh, planLayers, sliceLayerIterator, sliceAt } from './engine.js?v=20261021.3';
import { packBuild, validateLayout } from './layout.js?v=20261021.3';
import { createSLCEncoder, decodeSLC, samplingTableForLayers } from './slc.js?v=20261021.3';

const MAX_PARTS = 32;
const fail = (message, code = 'INVALID_JOB', details = {}) => { const error = new Error(message); error.code = code; error.details = details; throw error; };
const safeName = (value, fallback) => String(value ?? fallback).replace(/[\x00-\x1f]/g, '').slice(0, 180) || fallback;
function publicMesh(mesh) {
  const { id, name, positions, triangleCount, bounds, format, unitScale, analysis, repair } = mesh;
  return { id, name, positions, triangleCount, bounds, format, unitScale, analysis, repair };
}
function cleanMeshes(input) {
  if (!Array.isArray(input) || !input.length || input.length > MAX_PARTS) fail(`Import between 1 and ${MAX_PARTS} parts.`, 'PART_LIMIT');
  const ids = new Set();
  return input.map((mesh, i) => {
    if (!mesh || (!ArrayBuffer.isView(mesh.positions) && !Array.isArray(mesh.positions))) fail(`Part ${i + 1} has no valid vertex array.`);
    if (!mesh.positions.length || mesh.positions.length % 9 !== 0) fail(`Part ${i + 1} has incomplete triangles.`);
    const positions = mesh.positions instanceof Float64Array ? mesh.positions : Float64Array.from(mesh.positions);
    const id = safeName(mesh.id, `part-${i + 1}`);
    if (ids.has(id)) fail('Every build part must have a unique id.'); ids.add(id);
    // Recompute geometry-derived fields; inbound caches can be stale after edits.
    return { id, name: safeName(mesh.name, `Part ${i + 1}.stl`), positions, triangleCount: positions.length / 9, bounds: computeBounds(positions), format: safeName(mesh.format, 'mesh'), unitScale: Number.isFinite(mesh.unitScale) ? mesh.unitScale : 1, repair: mesh.repair };
  });
}
function meshProgress(mesh, index, meshes, progress) {
  return value => progress({ unit: 'triangles', ...value, fileName: mesh.name, fileIndex: index + 1, fileCount: meshes.length });
}
function diagnosticsFor(meshes, progress = () => {}) {
  return meshes.map((mesh, i) => ({ id: mesh.id, name: mesh.name, ...analyzeMesh(mesh, meshProgress(mesh, i, meshes, progress)), repair: mesh.repair }));
}
function assertPrintable(meshes, progress = () => {}) {
  for (const [i, mesh] of meshes.entries()) {
    const a = analyzeMesh(mesh, meshProgress(mesh, i, meshes, progress));
    const details = { fileName: mesh.name, meshId: mesh.id, boundaryEdges: a.boundaryEdges, nonManifoldEdges: a.nonManifoldEdges, inconsistentEdges: a.inconsistentEdges };
    if (!a.watertight) fail(`${mesh.name}: ${a.boundaryEdges} open edges and ${a.nonManifoldEdges} non-manifold edges remain after automatic cleanup. These require mesh repair; no missing surfaces were invented.`, 'INVALID_MESH', details);
    if (!a.consistentWinding) fail(`${mesh.name}: inconsistent triangle winding remains. Reorient the affected surfaces in your mesh editor.`, 'INVALID_WINDING', details);
  }
}
function buildBounds(meshes) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const mesh of meshes) for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], mesh.bounds.min[a]); max[a] = Math.max(max[a], mesh.bounds.max[a]); }
  return { min, max, size: max.map((v, a) => v - min[a]), center: max.map((v, a) => (v + min[a]) / 2) };
}
function checkedPlan(input, meshes) {
  if (!input || !Array.isArray(input.layers) || !input.layers.length || input.layers.length > ENGINE_LIMITS.maxLayers) fail('Generate a valid layer plan before exporting.', 'INVALID_PLAN');
  let lastUm = 0;
  const layers = input.layers.map((layer, i) => {
    if (!layer || !Number.isFinite(layer.zMm) || !Number.isFinite(layer.zStartMm) || !Number.isInteger(layer.thicknessUm) || layer.thicknessUm < 50 || layer.thicknessUm > 200) fail(`Layer ${i + 1} contains invalid endpoints or thickness.`, 'INVALID_PLAN');
    const startUm = Math.round(layer.zStartMm * 1000), endUm = Math.round(layer.zMm * 1000);
    if (Math.abs(layer.zStartMm * 1000 - startUm) > .0001 || Math.abs(layer.zMm * 1000 - endUm) > .0001 || startUm !== lastUm || endUm - startUm !== layer.thicknessUm) fail(`Layer ${i + 1} does not form a contiguous micron-aligned interval.`, 'INVALID_PLAN');
    lastUm = endUm;
    return { index: i, zStartMm: startUm / 1000, zMm: endUm / 1000, thicknessUm: layer.thicknessUm, requestedUm: layer.requestedUm ?? layer.thicknessUm, reason: safeName(layer.reason, 'manual'), classification: safeName(layer.classification, 'manual'), adjusted: Boolean(layer.adjusted) };
  });
  const bounds = buildBounds(meshes), heightUm = Math.round(bounds.max[2] * 1000);
  if (bounds.min[2] < -1e-4) fail('The build extends below the plate. Regenerate the layout.', 'BUILD_BELOW_BED');
  if (lastUm !== heightUm || (input.heightUm != null && input.heightUm !== heightUm)) fail('The plan height does not match the current geometry. Generate the plan again.', 'STALE_PLAN');
  // Reject unsupported tables before calculating thousands of contours.
  samplingTableForLayers(layers);
  return { ...input, layers, heightUm, heightMm: heightUm / 1000, actualHeightMm: bounds.max[2] };
}
function verifyDecoded(decoded, plan, layerMetadata) {
  if (decoded.layers.length !== plan.layers.length) fail('SLC read-back layer count differs from the plan.', 'EXPORT_VERIFICATION');
  for (let i = 0; i < plan.layers.length; i++) {
    const a = plan.layers[i], b = decoded.layers[i];
    if (a.thicknessUm !== b.thicknessUm || Math.abs(Math.fround(a.zMm) - b.zMm) > Math.max(1e-6, Math.abs(a.zMm) * 3e-7)) fail(`SLC read-back differs at layer ${i + 1}.`, 'EXPORT_VERIFICATION');
    if (b.ringCount !== layerMetadata[i].ringCount || b.vertexCount !== layerMetadata[i].vertexCount) fail(`SLC contour counts differ at layer ${i + 1}.`, 'EXPORT_VERIFICATION');
  }
}

/** Exported for integration tests; emit(message, transferables) matches postMessage. */
export function handleWorkerRequest(request, emit) {
  const id = request?.id;
  const progress = value => emit({ id, type: 'progress', ...value, percent: Number.isFinite(value.percent) ? Math.min(100, Math.max(0, value.percent)) : null });
  try {
    if (!request || typeof request.type !== 'string') fail('Invalid worker request.');
    if (request.type === 'parse') {
      if (!Array.isArray(request.files) || !request.files.length || request.files.length > MAX_PARTS) fail(`Drop between 1 and ${MAX_PARTS} STL files.`, 'PART_LIMIT');
      let totalBytes = 0;
      const parsed = request.files.map((file, i) => {
        if (!(file.buffer instanceof ArrayBuffer)) fail(`File ${i + 1} has no readable buffer.`, 'INVALID_STL');
        totalBytes += file.buffer.byteLength;
        if (totalBytes > ENGINE_LIMITS.maxFileBytes) fail('The combined import exceeds 200 MB. Load a smaller build.', 'FILE_TOO_LARGE');
        const fileName = safeName(file.name, `Part ${i + 1}.stl`);
        const onProgress = value => progress({ unit: 'triangles', ...value, fileName, fileIndex: i + 1, fileCount: request.files.length });
        const mesh = parseSTL(file.buffer, fileName, { unitScale: file.unitScale ?? 1, onProgress });
        mesh.id = safeName(file.id, `part-${i + 1}`);
        const repaired = repairMesh(mesh, {}, onProgress);
        repaired.mesh.repair = repaired.report;
        return repaired.mesh;
      });
      const meshes = parsed, diagnostics = diagnosticsFor(meshes, progress);
      emit({ id, type: 'parsed', meshes: meshes.map(publicMesh), diagnostics }); return;
    }
    if (request.type === 'demo') {
      const demo = createDemoMesh(); demo.id = 'demo-tower';
      const meshes = [demo], diagnostics = diagnosticsFor(meshes, progress);
      emit({ id, type: 'parsed', meshes: meshes.map(publicMesh), diagnostics }); return;
    }
    const meshes = cleanMeshes(request.meshes);
    if (request.type === 'plan') {
      const options = request.options ?? {}, bed = options.bed ?? { width: 760, depth: 660, gap: 5, margin: 5 };
      assertPrintable(meshes, progress);
      progress({ stage: 'layout', current: 0, total: 1, percent: 0 });
      let placed = meshes, placements = [], layout;
      if (request.pack !== false) {
        const result = packBuild(meshes, bed); placed = cleanMeshes(result.meshes); placements = result.placements;
        layout = { bounds: result.bounds, utilization: result.utilization, warnings: result.warnings ?? [], bed };
      } else {
        const result = validateLayout(meshes, bed);
        if (!result.valid) fail((result.errors ?? ['Invalid build layout.']).join(' '), 'INVALID_LAYOUT');
        layout = { bounds: result.bounds, utilization: result.utilization, warnings: result.warnings ?? [], bed };
        placements = meshes.map(mesh => ({ id: mesh.id, name: mesh.name, x: mesh.bounds.min[0], y: mesh.bounds.min[1], width: mesh.bounds.size[0], depth: mesh.bounds.size[1], rotationZ: 0 }));
      }
      assertPrintable(placed, progress);
      progress({ stage: 'layout', current: 1, total: 1, percent: 100 });
      const plan = planLayers(placed, options, progress);
      try { plan.slcRunCount = samplingTableForLayers(plan.layers).length; plan.exportWarning = null; plan.exportable = true; }
      catch (error) {
        if (error.code !== 'sampling-table-limit') throw error;
        plan.slcRunCount = plan.layers.reduce((n, layer, i, list) => n + (i === 0 || layer.thicknessUm !== list[i - 1].thicknessUm ? 1 : 0), 0);
        plan.exportWarning = error.message; plan.exportable = false;
        plan.warnings = [...(plan.warnings ?? []), error.message];
      }
      progress({ stage: 'planning', current: plan.heightUm, total: plan.heightUm, percent: 100 });
      const diagnostics = diagnosticsFor(placed);
      emit({ id, type: 'planned', meshes: placed.map(publicMesh), diagnostics, placements, layout, plan }); return;
    }
    if (request.type === 'slice') {
      if (!Number.isFinite(request.zMm)) fail('Preview height must be finite.', 'INVALID_Z');
      const section = sliceAt(meshes, request.zMm);
      emit({ id, type: 'slice', section }); return;
    }
    if (request.type === 'export') {
      const plan = checkedPlan(request.plan, meshes);
      assertPrintable(meshes, progress);
      const bounds = buildBounds(meshes);
      const encoder = createSLCEncoder(plan.layers, { extents: { min: [bounds.min[0], bounds.min[1], 0], max: [bounds.max[0], bounds.max[1], plan.heightMm] } });
      const iterator = sliceLayerIterator(meshes, plan, progress);
      let result;
      // Each contour is normalized, checked and read back before its arrays are
      // released. Retain compact encoded bytes rather than the entire build's rings.
      while (!(result = iterator.next()).done) encoder.addLayer(result.value);
      const sliced = result.value;
      progress({ stage: 'encoding', current: 0, total: 1, percent: 0 });
      const bytes = encoder.finish();
      progress({ stage: 'encoding', current: 1, total: 1, percent: 100 });
      progress({ stage: 'verifying', current: 0, total: 1, percent: 0 });
      const decoded = decodeSLC(bytes, { retainGeometry: false, onProgress: value => progress({ ...value, stage: 'verifying' }) }); verifyDecoded(decoded, plan, encoder.layerMetadata);
      if (encoder.stats.verifiedLayers !== plan.layers.length || decoded.contourVertexCount !== encoder.stats.contourVertexCount || decoded.totalVertices !== encoder.stats.encodedVertexCount) fail('SLC read-back contour counts differ from the verified layers.', 'EXPORT_VERIFICATION');
      progress({ stage: 'verifying', current: 1, total: 1, percent: 100 });
      const collapsedVertices = encoder.stats.collapsedVertices || 0;
      const warnings = [...(sliced.warnings || [])];
      if (collapsedVertices) warnings.push(`${collapsedVertices} consecutive contour points became identical at SLC float32 precision and were coalesced; closed contours and winding were verified after conversion.`);
      const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      emit({ id, type: 'exported', buffer, layerCount: plan.layers.length, byteLength: buffer.byteLength, warnings, recovery: { recoveredPlanes: sliced.recoveredPlanes || 0, maxPlaneShiftMm: sliced.maxPlaneShiftMm || 0, collapsedVertices }, contourVertexCount: sliced.contourVertexCount }, [buffer]); return;
    }
    fail(`Unknown worker task: ${request.type}.`, 'UNKNOWN_JOB');
  } catch (error) {
    emit({ id, type: 'error', message: error?.message || 'The local geometry job failed.', code: error?.code || 'PROCESSING_ERROR', details: error?.details || {} });
  }
}

if (typeof self !== 'undefined' && typeof self.addEventListener === 'function') {
  self.addEventListener('message', event => handleWorkerRequest(event.data, (message, transfer = []) => self.postMessage(message, transfer)));
}
