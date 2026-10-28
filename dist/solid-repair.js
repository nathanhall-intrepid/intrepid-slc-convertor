/** Union existing, closed solid shells. Never cap an unknown opening. */
import {analyzeMesh, computeBounds, repairMesh} from './engine.js?v=20261028.3';

const SURFACE_TOLERANCE_MM = .0001; // 0.1 micrometre; reported in the recipe.
let library;
async function manifold() {
  if (!library) library = import('./vendor/manifold.js').then(async ({default: init}) => {
    const m = await init(); m.setup(); return m;
  });
  return library;
}

function shellComponents(mesh, progress) {
  // analyzeMesh builds the exact-coordinate index; do not proximity-weld solids.
  const {ids, offsets} = mesh._topology, p = mesh.positions, count = p.length / 9;
  const parents = Uint32Array.from({length: count}, (_, i) => i), edges = new Map();
  const root = a => { while (parents[a] !== a) { parents[a] = parents[parents[a]]; a = parents[a]; } return a; };
  for (let face = 0; face < count; face++) {
    for (let k = 0; k < 3; k++) {
      const a = ids[face*3+k], b = ids[face*3+(k+1)%3], key = a < b ? `${a}:${b}` : `${b}:${a}`;
      const edge = edges.get(key);
      if (edge) { edge.count++; edge.second = face; }
      else edges.set(key, {first: face, second: -1, count: 1});
    }
    if (face % 4096 === 0) progress(20 * face / count, 'Finding closed surface shells');
  }
  // A shared non-manifold edge is a shell boundary, not an arbitrary connection.
  for (const edge of edges.values()) if (edge.count === 2) parents[root(edge.first)] = root(edge.second);
  edges.clear();
  const groups = new Map();
  for (let face = 0; face < count; face++) { const key = root(face), faces = groups.get(key) || []; faces.push(face); groups.set(key, faces); }
  const shells = [];
  for (const faces of groups.values()) {
    const local = new Map(), vertices = [], triangles = [], min = [Infinity,Infinity,Infinity], max = [-Infinity,-Infinity,-Infinity];
    let volume = 0, rounding = 0;
    const origin = Array.from(p.subarray(faces[0]*9, faces[0]*9+3));
    for (const face of faces) {
      for (let k = 0; k < 3; k++) {
        const id = ids[face*3+k];
        if (!local.has(id)) {
          local.set(id, local.size);
          for (let axis = 0; axis < 3; axis++) {
            const v = p[offsets[id]+axis]; vertices.push(v); min[axis] = Math.min(min[axis],v); max[axis] = Math.max(max[axis],v);
            rounding = Math.max(rounding,Math.abs(v-Math.fround(v)));
          }
        }
        triangles.push(local.get(id));
      }
      const j=face*9, ax=p[j]-origin[0], ay=p[j+1]-origin[1], az=p[j+2]-origin[2];
      const bx=p[j+3]-origin[0], by=p[j+4]-origin[1], bz=p[j+5]-origin[2], cx=p[j+6]-origin[0], cy=p[j+7]-origin[1], cz=p[j+8]-origin[2];
      volume += (ax*(by*cz-bz*cy)+ay*(bz*cx-bx*cz)+az*(bx*cy-by*cx))/6;
    }
    shells.push({vertices, triangles, min, max, volume, rounding});
    if (shells.length % 128 === 0) progress(20+20*shells.length/groups.size,'Checking solid shell orientation');
  }
  return shells;
}
function mayOverlap(shells) {
  const sorted = shells.slice().sort((a,b)=>a.min[0]-b.min[0]);
  for (let i=0;i<sorted.length;i++) for (let j=i+1;j<sorted.length&&sorted[j].min[0]<=sorted[i].max[0];j++) {
    if ([1,2].every(k=>sorted[i].min[k]<=sorted[j].max[k]&&sorted[j].min[k]<=sorted[i].max[k])) return true;
  }
  return false;
}

export async function repairForSlicing(input, onProgress = () => {}) {
  const cleaned = repairMesh(input, {}, onProgress), mesh = cleaned.mesh, report = cleaned.report;
  const before = analyzeMesh(mesh);
  if (before.boundaryEdges || before.inconsistentEdges) return cleaned;
  const progress = (percent,message) => onProgress({stage:'repairing',percent,message,unit:''});
  progress(0,'Checking for overlapping closed solids');
  const shells = shellComponents(mesh,progress);
  report.shellCount = shells.length;
  if (shells.length < 2 || (!before.nonManifoldEdges && !mayOverlap(shells))) return cleaned;
  // Negative shells may be intentional cavities. Do not fill them by unioning
  // them as positive solids, or subtract them globally from unrelated parts.
  if (shells.some(s=>!(s.volume>0))) {
    if (before.nonManifoldEdges) report.warnings.push('Solid union skipped: cavity or ambiguous shell orientation needs mesh editing.');
    return cleaned;
  }
  const maxInputRoundingMm = shells.reduce((m,s)=>Math.max(m,s.rounding),0);
  if (maxInputRoundingMm > .001) {
    report.warnings.push('Solid union skipped: coordinate precision would move vertices by more than 1 µm.');
    return cleaned;
  }
  const solids=[];let union, simplified;
  try {
    progress(null,'Loading the local solid-repair engine');
    const M=await manifold();
    for(let i=0;i<shells.length;i++) {
      const s=shells[i];
      const solid=new M.Manifold(new M.Mesh({numProp:3,vertProperties:new Float32Array(s.vertices),triVerts:new Uint32Array(s.triangles)}));
      solids.push(solid);
      if(solid.status()!=='NoError') throw new Error('A surface shell is not a closed, consistently oriented solid.');
      if(i%128===0)progress(40+15*i/shells.length,`Preparing ${shells.length.toLocaleString()} closed solid shells`);
    }
    progress(null,`Combining ${shells.length.toLocaleString()} solid shells. Complex support networks can take a minute; Cancel remains available.`);
    union=M.Manifold.union(solids);
    if(union.status()!=='NoError')throw new Error('The solid union could not be resolved.');
    progress(80,'Cleaning intersection slivers within 0.1 µm');
    simplified=union.simplify(SURFACE_TOLERANCE_MM);
    const output=simplified.getMesh(), positions=new Float64Array(output.triVerts.length*3);
    for(let i=0;i<output.triVerts.length;i++)for(let k=0;k<3;k++)positions[i*3+k]=output.vertProperties[output.triVerts[i]*output.numProp+k];
    if(!positions.length)throw new Error('The solid union was empty.');
    const repaired={...mesh,positions,triangleCount:positions.length/9,bounds:computeBounds(positions),analysis:undefined,_prepared:undefined,_topology:undefined};
    const after=analyzeMesh(repaired,p=>progress(85+p.percent*.15,'Verifying the repaired solid mesh'));
    if(!after.watertight||!after.consistentWinding||after.degenerateTriangles||!(after.volumeMm3>0))throw new Error('The solid union still has unresolved topology.');
    let maxBoundsChangeMm=0;
    for(const side of ['min','max'])for(let k=0;k<3;k++)maxBoundsChangeMm=Math.max(maxBoundsChangeMm,Math.abs(mesh.bounds[side][k]-repaired.bounds[side][k]));
    if(maxBoundsChangeMm>.001)throw new Error('The solid union changed the model bounds by more than 1 µm.');
    report.changed=true;
    report.solidUnion={shells:shells.length,surfaceToleranceMm:SURFACE_TOLERANCE_MM,maxInputRoundingMm,maxBoundsChangeMm,volumeBeforeMm3:before.volumeMm3,volumeAfterMm3:after.volumeMm3,trianglesBefore:mesh.triangleCount,trianglesAfter:repaired.triangleCount};
    report.boundaryEdgesAfter=0;report.nonManifoldEdgesAfter=0;report.inconsistentEdgesAfter=0;report.watertight=true;
    report.warnings=report.warnings.filter(w=>!w.includes('non-manifold edges remain'));
    report.warnings.push(`Combined ${shells.length.toLocaleString()} existing solid shells; intersection slivers cleaned within 0.1 µm. No missing faces were capped. Review the repaired preview.`);
    progress(100,'Solid repair complete; closed mesh verified');
    return {mesh:repaired,report};
  } catch(error) {
    report.warnings.push(`Automatic solid union could not complete: ${error.message || 'unknown geometry error'}. The original cleaned surfaces were retained.`);
    progress(100,'Solid repair could not resolve this geometry; see Geometry checks');
    return cleaned;
  } finally {
    simplified?.delete();union?.delete();for(const solid of solids)solid.delete();
  }
}

/** Repair only collisions introduced by SLC float32 coordinates. The encoder
 * validates the original contours first. Candidate changes must fit inside a
 * 1 µm band around those boundaries; every resulting ring is checked again. */
export async function createContourPrecisionRepair() {
  const M = await manifold();
  return (rings, validate) => {
    const owned=[];const keep=x=>{owned.push(x);return x;};
    try {
      let maxRoundingMm=0;
      const quantized=rings.map(r=>r.map(p=>p.map(v=>{const q=Math.fround(v);maxRoundingMm=Math.max(maxRoundingMm,Math.abs(v-q));return q;})));
      if(maxRoundingMm>.0005)throw new Error('SLC coordinate magnitude exceeds the bounded contour repair precision.');
      const source=keep(new M.CrossSection(rings,'Positive'));
      const outer=keep(source.offset(.001,'Round',2,16)),inner=keep(source.offset(-.001,'Round',2,16));
      let current=quantized,lastError;
      // First try an exact union at output precision. A final tiny closing is
      // reserved for contacts that float32 cannot represent as separate edges.
      for(const radius of [0,0,.0001,.00025]) {
        let cross=keep(new M.CrossSection(current,'Positive'));
        if(radius){const expanded=keep(cross.offset(radius,'Round',2,16));cross=keep(expanded.offset(-radius,'Round',2,16));}
        current=cross.toPolygons().map(r=>r.map(p=>p.map(Math.fround)));
        if(!current.length)throw new Error('Contour repair would remove the whole cross-section.');
        try {
          const result=validate(current);
          const candidate=keep(new M.CrossSection(result.map(r=>r.ring),'Positive'));
          const outside=keep(candidate.subtract(outer)),missing=keep(inner.subtract(candidate));
          if(outside.area()>1e-10||missing.area()>1e-10)throw new Error('Contour repair exceeds its 1 µm boundary tolerance.');
          return {rings:result,report:{boundaryToleranceMm:.001,maxRoundingMm,closingRadiusMm:radius,ringsBefore:rings.length,ringsAfter:result.length,areaChangeMm2:candidate.area()-source.area()}};
        } catch(error){lastError=error;}
      }
      throw lastError;
    } finally {for(let i=owned.length-1;i>=0;i--)owned[i].delete();}
  };
}
