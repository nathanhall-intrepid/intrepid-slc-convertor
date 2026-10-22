/** Deterministic XY packing; it never changes tilt, scale, or part geometry. */
import { computeBounds, transformMesh } from './engine.js?v=20261021.3';

export class LayoutError extends Error {
  constructor(message, code = 'LAYOUT_ERROR', details = {}) {
    super(message); this.name = 'LayoutError'; this.code = code; this.details = details;
  }
}

const EPS = 1e-7;

function configuration(input = {}) {
  const options = {
    width: Number(input.width ?? 760),
    depth: Number(input.depth ?? 660),
    gap: Number(input.gap ?? 5),
    margin: Number(input.margin ?? 5),
    allowRotate: input.allowRotate !== false,
  };
  if (![options.width,options.depth,options.gap,options.margin].every(Number.isFinite) || options.width <= 0 || options.depth <= 0 || options.gap < 0 || options.margin < 0) {
    throw new LayoutError('Bed width/depth must be positive; part gap and edge margin must be nonnegative finite millimetres.', 'INVALID_BED');
  }
  if (2 * options.margin >= Math.min(options.width, options.depth)) throw new LayoutError('Edge margins leave no usable build area.', 'INVALID_BED');
  return options;
}

function dimensions(mesh, index) {
  if (!mesh || !mesh.positions || !mesh.positions.length) throw new LayoutError('Every part needs STL positions.', 'INVALID_PART');
  const bounds = computeBounds(mesh.positions);
  if (bounds.size[0] <= EPS || bounds.size[1] <= EPS) throw new LayoutError(`${mesh.name ?? 'Part'} has no printable XY footprint.`, 'INVALID_PART');
  return { mesh, index, id: mesh.id ?? `part-${index + 1}`, name: mesh.name ?? `Part ${index + 1}`, width: bounds.size[0], depth: bounds.size[1], bounds };
}

const contains = (a, b) => b.x >= a.x-EPS && b.y >= a.y-EPS && b.x+b.w <= a.x+a.w+EPS && b.y+b.h <= a.y+a.h+EPS;
const intersects = (a, b) => a.x < b.x+b.w-EPS && a.x+a.w > b.x+EPS && a.y < b.y+b.h-EPS && a.y+a.h > b.y+EPS;

function splitFreeRectangles(free, used) {
  const next = [];
  for (const r of free) {
    if (!intersects(r,used)) { next.push(r); continue; }
    if (used.x > r.x+EPS) next.push({x:r.x,y:r.y,w:used.x-r.x,h:r.h});
    if (used.x+used.w < r.x+r.w-EPS) next.push({x:used.x+used.w,y:r.y,w:r.x+r.w-used.x-used.w,h:r.h});
    if (used.y > r.y+EPS) next.push({x:r.x,y:r.y,w:r.w,h:used.y-r.y});
    if (used.y+used.h < r.y+r.h-EPS) next.push({x:r.x,y:used.y+used.h,w:r.w,h:r.y+r.h-used.y-used.h});
  }
  // Free rectangles may overlap; retaining only noncontained rectangles is the
  // usual MaxRects representation. Each next placement splits every overlap.
  return next.filter((r,i) => r.w>EPS && r.h>EPS && !next.some((q,j) => j !== i && contains(q,r) && (!contains(r,q) || j<i)));
}

function compareScore(a,b) {
  for (let i=0;i<Math.max(a.length,b.length);i++) {
    const delta=(a[i]??0)-(b[i]??0);
    if (Math.abs(delta)>EPS) return delta;
  }
  return 0;
}

function candidateOrientations(part, allowRotate, gap) {
  const result=[{rotationZ:0,width:part.width,depth:part.depth,w:part.width+gap,h:part.depth+gap}];
  if (allowRotate && Math.abs(part.width-part.depth)>EPS) result.push({rotationZ:90,width:part.depth,depth:part.width,w:part.depth+gap,h:part.width+gap});
  return result;
}

function maxRects(parts, options, heuristic) {
  // Padding adds a gap to the right/top of every rectangle. Adding one gap to
  // the bin lets the final part finish exactly at the requested edge margin.
  let free=[{x:0,y:0,w:options.width-2*options.margin+options.gap,h:options.depth-2*options.margin+options.gap}];
  const placements=[];
  for (const part of parts) {
    let best=null;
    for (let fi=0;fi<free.length;fi++) {
      const rectangle=free[fi];
      for (const orientation of candidateOrientations(part,options.allowRotate,options.gap)) {
        if (orientation.w>rectangle.w+EPS || orientation.h>rectangle.h+EPS) continue;
        const dw=rectangle.w-orientation.w,dh=rectangle.h-orientation.h;
        let score;
        if (heuristic==='area') score=[rectangle.w*rectangle.h-orientation.w*orientation.h,Math.min(dw,dh),Math.max(dw,dh)];
        else if (heuristic==='bottom') score=[rectangle.y+orientation.h,rectangle.x,Math.min(dw,dh)];
        else score=[Math.min(dw,dh),Math.max(dw,dh),rectangle.w*rectangle.h-orientation.w*orientation.h];
        score.push(orientation.rotationZ,rectangle.y,rectangle.x,fi);
        if (!best || compareScore(score,best.score)<0) best={...orientation,x:rectangle.x,y:rectangle.y,score};
      }
    }
    if (!best) return null;
    free=splitFreeRectangles(free,best);
    placements.push({id:part.id,name:part.name,index:part.index,x:best.x,y:best.y,width:best.width,depth:best.depth,rotationZ:best.rotationZ});
  }
  return placements;
}

function occupied(placements) {
  const minX=Math.min(...placements.map(p=>p.x)),minY=Math.min(...placements.map(p=>p.y));
  const maxX=Math.max(...placements.map(p=>p.x+p.width)),maxY=Math.max(...placements.map(p=>p.y+p.depth));
  return {minX,minY,maxX,maxY,width:maxX-minX,depth:maxY-minY};
}

function layoutBounds(items) {
  if (!items.length) return {min:[0,0,0],max:[0,0,0],size:[0,0,0],center:[0,0,0]};
  const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
  for (const item of items) {
    const bounds=item.positions ? computeBounds(item.positions) : {min:[item.x,item.y,0],max:[item.x+item.width,item.y+item.depth,item.height??0]};
    for(let k=0;k<3;k++){min[k]=Math.min(min[k],bounds.min[k]);max[k]=Math.max(max[k],bounds.max[k]);}
  }
  return {min,max,size:max.map((v,k)=>v-min[k]),center:max.map((v,k)=>(v+min[k])/2)};
}

/**
 * Validate either transformed meshes or placements. Rectangular footprints
 * conservatively reserve space even when actual outlines are concave.
 */
export function validateLayout(items, input = {}) {
  let options;
  try { options=configuration(input); }
  catch(error){return {valid:false,errors:[error.message],warnings:[],bounds:null,utilization:0};}
  const errors=[],warnings=[];
  if (!Array.isArray(items)) return {valid:false,errors:['Layout must be an array of parts.'],warnings:[],bounds:null,utilization:0};
  const rectangles=[];const ids=new Set();
  for (let i=0;i<items.length;i++) {
    const item=items[i];
    try {
      const b=item.positions ? computeBounds(item.positions) : null;
      const p={id:item.id??`part-${i+1}`,name:item.name??`Part ${i+1}`,x:b?b.min[0]:Number(item.x),y:b?b.min[1]:Number(item.y),width:b?b.size[0]:Number(item.width),depth:b?b.size[1]:Number(item.depth)};
      if (ids.has(p.id)) errors.push(`Duplicate part id: ${p.id}.`);
      ids.add(p.id);
      if (![p.x,p.y,p.width,p.depth].every(Number.isFinite)||p.width<=EPS||p.depth<=EPS) { errors.push(`${p.name} has an invalid footprint.`);continue; }
      if (p.x<options.margin-EPS||p.y<options.margin-EPS||p.x+p.width>options.width-options.margin+EPS||p.y+p.depth>options.depth-options.margin+EPS) errors.push(`${p.name} extends outside the build margin.`);
      if (b&&b.min[2]<-EPS) errors.push(`${p.name} extends below the build plane.`);
      rectangles.push(p);
    } catch(error) { errors.push(error.message); }
  }
  for(let i=0;i<rectangles.length;i++)for(let j=0;j<i;j++){
    const a=rectangles[i],b=rectangles[j];
    const separated=a.x+a.width+options.gap<=b.x+EPS||b.x+b.width+options.gap<=a.x+EPS||a.y+a.depth+options.gap<=b.y+EPS||b.y+b.depth+options.gap<=a.y+EPS;
    if(!separated)errors.push(`${a.name} and ${b.name} overlap or violate the ${options.gap} mm gap.`);
  }
  if(options.gap===0&&items.length>1)warnings.push('Zero part spacing can produce touching contours; SLC contour validation may reject those contacts.');
  const usable=(options.width-2*options.margin)*(options.depth-2*options.margin);
  let bounds=null;
  try{bounds=layoutBounds(items);}catch{/* Existing item error already explains the failure. */}
  return {valid:errors.length===0,errors,warnings,bounds,utilization:rectangles.reduce((sum,p)=>sum+p.width*p.depth,0)/usable};
}

/**
 * Try several deterministic MaxRects orders/scores and choose the smallest
 * occupied rectangle. This is a packing heuristic, not a global optimum.
 */
export function packBuild(meshes, input = {}) {
  const options=configuration(input);
  if(!Array.isArray(meshes)||meshes.length===0)throw new LayoutError('Import at least one part before arranging the build.','NO_PARTS');
  if(meshes.length>200)throw new LayoutError('Arrange no more than 200 parts in one browser build.','TOO_MANY_PARTS');
  const parts=meshes.map(dimensions),ids=new Set();
  const innerWidth=options.width-2*options.margin,innerDepth=options.depth-2*options.margin;
  for(const p of parts){
    if(ids.has(p.id))throw new LayoutError(`Duplicate part id: ${p.id}. Give duplicated parts distinct ids.`,'DUPLICATE_PART');
    ids.add(p.id);
    const normal=p.width<=innerWidth+EPS&&p.depth<=innerDepth+EPS;
    const rotated=options.allowRotate&&p.depth<=innerWidth+EPS&&p.width<=innerDepth+EPS;
    if(!normal&&!rotated)throw new LayoutError(`${p.name} (${p.width.toFixed(2)} × ${p.depth.toFixed(2)} mm) does not fit the ${innerWidth.toFixed(2)} × ${innerDepth.toFixed(2)} mm usable bed. No scaling was applied.`,'PART_TOO_LARGE',{id:p.id});
  }
  const comparators=[
    (a,b)=>b.width*b.depth-a.width*a.depth,
    (a,b)=>Math.max(b.width,b.depth)-Math.max(a.width,a.depth),
    (a,b)=>b.depth-a.depth,
    (a,b)=>b.width-a.width,
    (a,b)=>b.width+b.depth-a.width-a.depth,
  ];
  let best=null;
  for(const comparator of comparators){
    const ordered=[...parts].sort((a,b)=>comparator(a,b)||a.index-b.index);
    for(const heuristic of ['short','area','bottom']){
      const placements=maxRects(ordered,options,heuristic);if(!placements)continue;
      const box=occupied(placements);
      const score=[box.width*box.depth,placements.filter(p=>p.rotationZ!==0).length,box.width+box.depth,box.depth,box.width];
      if(!best||compareScore(score,best.score)<0)best={placements,box,score};
    }
  }
  if(!best)throw new LayoutError('The packing heuristic could not fit all parts with the requested gap and margins. Increase the bed, reduce spacing, or remove a part.','BUILD_DOES_NOT_FIT');
  const offsetX=options.margin+(innerWidth-best.box.width)/2-best.box.minX;
  const offsetY=options.margin+(innerDepth-best.box.depth)/2-best.box.minY;
  const placements=best.placements.map(p=>({...p,x:p.x+offsetX,y:p.y+offsetY})).sort((a,b)=>a.index-b.index);
  const transformed=placements.map(p=>{
    const original=parts[p.index];
    const minX=p.rotationZ===90?-original.bounds.max[1]:original.bounds.min[0];
    const minY=p.rotationZ===90?original.bounds.min[0]:original.bounds.min[1];
    const mesh=transformMesh(original.mesh,{rotation:[0,0,p.rotationZ],translation:[p.x-minX,p.y-minY,0],ground:true});
    return {...mesh,id:p.id,name:p.name};
  });
  const check=validateLayout(transformed,options);
  if(!check.valid)throw new LayoutError(`Layout verification failed: ${check.errors.join(' ')}`,'LAYOUT_VERIFICATION_FAILED');
  const warnings=[
    'Rectangle-based packing is a deterministic heuristic, not a guaranteed global optimum.',
    'Tilt and scale are preserved. Only optional 90° turns about Z and XY placement are optimized; every part is grounded.',
    ...check.warnings,
  ];
  return {meshes:transformed,placements:placements.map(({index,...p})=>p),bounds:check.bounds,utilization:check.utilization,warnings};
}
