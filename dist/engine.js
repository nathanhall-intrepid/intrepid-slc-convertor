/** Browser-local STL inspection, planar slicing and adaptive layer planning.
 * Coordinates are millimetres. Layer zMm is the END of its interval; masks are
 * sampled at interval mid-height. SLC serialization owns its minimum-Z records.
 * Repair is limited to reported cleanup and precision-scale boundary seams;
 * semantic lattice/support classification and general hole filling are not claimed.
 */
export const ENGINE_LIMITS = Object.freeze({maxLayers:20000,maxFileBytes:200*1024*1024});

export class GeometryError extends Error {
  constructor(message, code='GEOMETRY_ERROR', details={}) { super(message); this.name='GeometryError'; this.code=code; this.details=details; }
}
const fail=(message,code,details)=>{throw new GeometryError(message,code,details);};
const finite=n=>Number.isFinite(n);
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const cross=(ax,ay,az,bx,by,bz)=>[ay*bz-az*by,az*bx-ax*bz,ax*by-ay*bx];

export function computeBounds(positions) {
  const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
  for(let i=0;i<positions.length;i+=3) for(let k=0;k<3;k++) {const v=positions[i+k];if(!finite(v)||Math.abs(v)>1e7) fail('STL contains invalid or excessively large coordinates.','INVALID_COORDINATE');min[k]=Math.min(min[k],v);max[k]=Math.max(max[k],v);}
  return {min,max,size:max.map((v,k)=>v-min[k]),center:max.map((v,k)=>(v+min[k])/2)};
}

export function parseSTL(input,name='part.stl',{unitScale=1,onProgress=()=>{}}={}) {
  onProgress({stage:'parsing',current:0,total:1,percent:0});
  if(!finite(unitScale)||unitScale<=0) fail('Choose a positive STL unit scale.','INVALID_UNITS');
  const buffer=input instanceof ArrayBuffer?input:input.buffer.slice(input.byteOffset,input.byteOffset+input.byteLength);
  if(buffer.byteLength>ENGINE_LIMITS.maxFileBytes) fail('STL exceeds the 200 MB browser-processing limit.','FILE_TOO_LARGE');
  if(buffer.byteLength<15) fail('File is too short to be an STL.','INVALID_STL');
  const view=new DataView(buffer);let positions,format;
  const count=buffer.byteLength>=84?view.getUint32(80,true):0;
  const expected=84+count*50;
  const binary=count>0&&expected===buffer.byteLength;
  if(binary){
    positions=new Float64Array(count*9);
    for(let i=0;i<count;i++){const start=84+i*50+12;for(let k=0;k<9;k++)positions[i*9+k]=view.getFloat32(start+k*4,true)*unitScale;if(i%4096===0)onProgress({stage:'parsing',current:i,total:count,percent:i/count*100});}
    format='binary';
  } else {
    const text=new TextDecoder().decode(buffer);
    if(!/^\s*solid\b/i.test(text)) fail('Not a supported ASCII or complete binary STL.','INVALID_STL');
    const facets=text.match(/facet\s+normal\s+[\s\S]*?endfacet/gi)||[];
    if(!facets.length) fail('ASCII STL has no facets.','INVALID_STL');
    positions=new Float64Array(facets.length*9);let offset=0;
    const number='[-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][-+]?\\d+)?';
    const rx=new RegExp('\\bvertex\\s+('+number+')\\s+('+number+')\\s+('+number+')','gi');
    for(const facet of facets){const vertices=[...facet.matchAll(rx)];if(vertices.length!==3||!/outer\s+loop/i.test(facet)||!/endloop/i.test(facet))fail('Each STL facet must contain one three-vertex loop.','INVALID_STL');for(const v of vertices)for(let k=1;k<=3;k++)positions[offset++]=Number(v[k])*unitScale;const count=offset/9;if(count%4096===0)onProgress({stage:'parsing',current:count,total:facets.length,percent:count/facets.length*100});}
    const body=text.replace(/^\s*solid[^\r\n]*(?:\r?\n)?/i,'').replace(/endsolid[^\r\n]*\s*$/i,'');
    const totalVertices=(body.match(/\bvertex\b/gi)||[]).length;
    if(totalVertices!==facets.length*3||!/endsolid\b/i.test(text)) fail('ASCII STL contains incomplete or unsupported facet data.','INVALID_STL');
    format='ascii';
  }
  const bounds=computeBounds(positions);
  if(Math.max(...bounds.size)<=0) fail('STL has no physical extent.','EMPTY_MESH');
  onProgress({stage:'parsing',current:positions.length/9,total:positions.length/9,percent:100});
  return {name,positions,triangleCount:positions.length/9,bounds,format,unitScale};
}

// Exact coordinate identity is topology, not a distance-based guess. In
// particular, adjacent parts and opposite sides of a thin wall must stay apart.
function indexed(mesh,onProgress=()=>{}){
  if(mesh._topology)return mesh._topology;
  const p=mesh.positions,ids=new Uint32Array(p.length/3),offsets=[],vertices=new Map();
  for(let j=0;j<p.length;j+=3){const key=`${p[j]},${p[j+1]},${p[j+2]}`;let id=vertices.get(key);if(id===undefined){id=offsets.length;vertices.set(key,id);offsets.push(j);}ids[j/3]=id;if(j%36864===0)onProgress(j/p.length);}
  return mesh._topology={ids,offsets,vertexCount:offsets.length};
}
function numericTolerance(meshes){
  let scale=1;for(const mesh of meshes)for(const value of [...mesh.bounds.min,...mesh.bounds.max])scale=Math.max(scale,Math.abs(value));
  return Math.max(1e-11,scale*Number.EPSILON*32);
}

function prepared(mesh){
  if(mesh._prepared)return mesh._prepared;
  const p=mesh.positions,n=p.length/9,minZ=new Float64Array(n),maxZ=new Float64Array(n),normalZ=new Float64Array(n),normalX=new Float64Array(n),normalY=new Float64Array(n);let signedVolume=0;
  for(let i=0;i<n;i++) {const j=i*9;const norm=cross(p[j+3]-p[j],p[j+4]-p[j+1],p[j+5]-p[j+2],p[j+6]-p[j],p[j+7]-p[j+1],p[j+8]-p[j+2]);const len=Math.hypot(...norm);normalZ[i]=len?Math.abs(norm[2])/len:0;normalX[i]=norm[0];normalY[i]=norm[1];const bc=cross(p[j+3],p[j+4],p[j+5],p[j+6],p[j+7],p[j+8]);signedVolume+=(p[j]*bc[0]+p[j+1]*bc[1]+p[j+2]*bc[2])/6;minZ[i]=Math.min(p[j+2],p[j+5],p[j+8]);maxZ[i]=Math.max(p[j+2],p[j+5],p[j+8]);}
  if(signedVolume<0)for(let i=0;i<n;i++){normalX[i]*=-1;normalY[i]*=-1;}
  return mesh._prepared={minZ,maxZ,normalZ,normalX,normalY};
}

export function analyzeMesh(mesh,onProgress=()=>{}) {
  const total=mesh.positions.length/9;
  if(mesh.analysis){onProgress({stage:'analyzing',percent:100,message:'Mesh topology already checked'});return mesh.analysis;}
  onProgress({stage:'analyzing',percent:0,message:'Indexing exact shared vertices'});
  const p=mesh.positions,b=mesh.bounds||computeBounds(p),topology=indexed(mesh,f=>onProgress({stage:'analyzing',percent:f*35,message:'Indexing exact shared vertices'}));
  const edges=new Map();let degenerateTriangles=0,volume=0,surfaceArea=0;
  for(let i=0;i<p.length;i+=9){
    const ids=[topology.ids[i/3],topology.ids[i/3+1],topology.ids[i/3+2]];
    const nx=cross(p[i+3]-p[i],p[i+4]-p[i+1],p[i+5]-p[i+2],p[i+6]-p[i],p[i+7]-p[i+1],p[i+8]-p[i+2]);const area=Math.hypot(...nx)/2;
    if(new Set(ids).size<3||area===0){degenerateTriangles++;continue;}
    surfaceArea+=area;const bc=cross(p[i+3],p[i+4],p[i+5],p[i+6],p[i+7],p[i+8]);volume+=(p[i]*bc[0]+p[i+1]*bc[1]+p[i+2]*bc[2])/6;
    for(let k=0;k<3;k++){const a=ids[k],c=ids[(k+1)%3],key=a<c?`${a}:${c}`:`${c}:${a}`;let edge=edges.get(key);if(!edge){edge={count:0,balance:0};edges.set(key,edge);}edge.count++;edge.balance+=a<c?1:-1;}
    if(i%36864===0)onProgress({stage:'analyzing',percent:35+i/p.length*65,message:'Checking mesh edges and winding'});
  }
  let boundaryEdges=0,nonManifoldEdges=0,inconsistentEdges=0;
  for(const e of edges.values()){if(e.count===1)boundaryEdges++;if(e.count>2)nonManifoldEdges++;if(e.count===2&&e.balance!==0)inconsistentEdges++;}
  const watertight=boundaryEdges===0&&nonManifoldEdges===0&&edges.size>0;
  const warnings=[];
  if(degenerateTriangles)warnings.push(`${degenerateTriangles} zero-area triangles ignored during slicing.`);
  if(inconsistentEdges)warnings.push(`${inconsistentEdges} edges have inconsistent facet winding. Repair orientation before SLC export.`);
  if(!watertight)warnings.push('Mesh has open or non-manifold edges. Repair it before SLC export.');
  onProgress({stage:'analyzing',percent:100,message:'Mesh topology checked'});
  return mesh.analysis={triangleCount:p.length/9,vertexCount:topology.vertexCount,edgeCount:edges.size,boundaryEdges,nonManifoldEdges,inconsistentEdges,degenerateTriangles,watertight,consistentWinding:inconsistentEdges===0,signedVolumeMm3:volume,volumeMm3:Math.abs(volume),surfaceAreaMm2:surfaceArea,weldToleranceMm:0,bounds:b,warnings};
}

/** Conservative mesh cleanup. No faces are invented. A seam may be stitched
 * only when two complete, distinct simple boundary loops match uniquely with
 * opposite edge orientation, already belong to one connected surface, and all
 * vertex movements are within maxGapMm (at most 1 micrometre). */
export function repairMesh(mesh,options={},onProgress=()=>{}){
  const emit=(percent,phase)=>onProgress({stage:'repairing',phase,message:phase,unit:'',percent});
  emit(0,'Checking mesh topology before cleanup');
  const before=analyzeMesh(mesh,p=>emit(p.percent*.15,p.message)),source=mesh.positions,total=source.length/9,topology=indexed(mesh),warnings=[];
  const tolerance=options.maxGapMm??Math.min(.001,Math.max(1e-6,Math.hypot(...mesh.bounds.size)*1e-6));
  if(!finite(tolerance)||tolerance<0||tolerance>.001)fail('Mesh seam tolerance must be between 0 and 0.001 mm.','INVALID_REPAIR_TOLERANCE');
  const report={changed:false,weldedVertices:0,removedDegenerateTriangles:0,removedDuplicateTriangles:0,maxVertexShiftMm:0,seamToleranceMm:tolerance,boundaryEdgesBefore:before.boundaryEdges,boundaryEdgesAfter:before.boundaryEdges,nonManifoldEdgesAfter:before.nonManifoldEdges,inconsistentEdgesAfter:before.inconsistentEdges,watertight:before.watertight,warnings};
  emit(15,'Removing exact duplicate and zero-area facets');
  const keep=[],seen=new Map();
  for(let face=0;face<total;face++){
    const i=face*9,a=topology.ids[face*3],b=topology.ids[face*3+1],c=topology.ids[face*3+2];
    const n=cross(source[i+3]-source[i],source[i+4]-source[i+1],source[i+5]-source[i+2],source[i+6]-source[i],source[i+7]-source[i+1],source[i+8]-source[i+2]);
    if(a===b||b===c||c===a||Math.hypot(...n)===0){report.removedDegenerateTriangles++;continue;}
    const key=[a,b,c].sort((x,y)=>x-y).join(':'),sign=(a-b)*(b-c)*(c-a)>0?1:2,mask=seen.get(key)||0;
    if(mask&sign){report.removedDuplicateTriangles++;continue;}seen.set(key,mask|sign);keep.push(face);
    if(face%4096===0)emit(15+face/total*15,'Removing exact duplicate and zero-area facets');
  }
  if(!keep.length)fail('Mesh cleanup found no nonzero-area facets.','EMPTY_MESH');
  let p=source;
  if(keep.length!==total){p=new Float64Array(keep.length*9);for(let i=0;i<keep.length;i++)p.set(source.subarray(keep[i]*9,keep[i]*9+9),i*9);}
  seen.clear();keep.length=0;
  let clean={...mesh,positions:p,triangleCount:p.length/9,bounds:computeBounds(p),analysis:p===source?before:undefined,_prepared:p===source?mesh._prepared:undefined,_topology:p===source?topology:undefined};
  const cleanBefore=analyzeMesh(clean,p=>emit(30+p.percent*.1,p.message)),ti=indexed(clean),count=p.length/9;
  // Closed surfaces cannot contain an open seam and are never proximity-welded.
  if(tolerance>0&&cleanBefore.boundaryEdges){
    const parents=Uint32Array.from({length:count},(_,i)=>i);
    const root=(a)=>{while(parents[a]!==a){parents[a]=parents[parents[a]];a=parents[a];}return a;};
    const edges=new Map();
    for(let face=0;face<count;face++){
      for(let k=0;k<3;k++){
        const a=ti.ids[face*3+k],b=ti.ids[face*3+(k+1)%3],key=a<b?`${a}:${b}`:`${b}:${a}`,old=edges.get(key);
        if(old){old.count++;parents[root(face)]=root(old.face);}else edges.set(key,{a,b,face,count:1});
      }
      if(face%4096===0)emit(40+face/count*25,'Finding existing surface components and boundary loops');
    }
    const boundary=[...edges.values()].filter(e=>e.count===1),atVertex=new Map(),loopOf=new Int32Array(boundary.length).fill(-1),loops=[];
    for(let i=0;i<boundary.length;i++)for(const v of [boundary[i].a,boundary[i].b]){const list=atVertex.get(v)||[];list.push(i);atVertex.set(v,list);}
    const visited=new Uint8Array(boundary.length);
    for(let seed=0;seed<boundary.length;seed++){
      if(visited[seed])continue;
      const stack=[seed],component=[];let simple=true;
      while(stack.length){const id=stack.pop();if(visited[id])continue;visited[id]=1;component.push(id);for(const v of [boundary[id].a,boundary[id].b]){const incident=atVertex.get(v);if(incident.length!==2)simple=false;for(const next of incident)if(!visited[next])stack.push(next);}}
      if(simple&&component.length>=3){const id=loops.length;for(const e of component)loopOf[e]=id;loops.push(component);}
    }
    const point=v=>{const i=ti.offsets[v];return [p[i],p[i+1],p[i+2]];};
    const distance=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2]);
    const candidates=Array.from({length:boundary.length},()=>[]),cells=new Map();
    for(let i=0;i<boundary.length;i++){
      if(loopOf[i]<0)continue;const edge=boundary[i],a=point(edge.a),b=point(edge.b);if(distance(a,b)<=tolerance*20)continue;
      const cell=a.map((v,k)=>Math.floor((v+b[k])*.5/tolerance));
      for(let x=-1;x<=1;x++)for(let y=-1;y<=1;y++)for(let z=-1;z<=1;z++){
        for(const j of cells.get(`${cell[0]+x},${cell[1]+y},${cell[2]+z}`)||[]){
          const other=boundary[j];
          if(loopOf[j]===loopOf[i]||root(edge.face)!==root(other.face)||edge.a===other.a||edge.a===other.b||edge.b===other.a||edge.b===other.b)continue;
          if(distance(a,point(other.b))<=tolerance&&distance(b,point(other.a))<=tolerance){candidates[i].push(j);candidates[j].push(i);}
        }
      }
      const key=cell.join(','),bucket=cells.get(key)||[];bucket.push(i);cells.set(key,bucket);
      if(i%4096===0)emit(65+i/boundary.length*20,'Matching complete precision-scale seams');
    }
    const pairLoops=new Map();
    for(let li=0;li<loops.length;li++){
      let partner=-1,valid=true;
      for(const edge of loops[li]){const matches=candidates[edge];if(matches.length!==1||candidates[matches[0]].length!==1){valid=false;break;}const target=loopOf[matches[0]];if(partner!==-1&&target!==partner){valid=false;break;}partner=target;}
      if(valid&&partner>=0&&loops[partner].length===loops[li].length)pairLoops.set(li,partner);
    }
    const replacement=new Map();
    for(const [li,partner] of pairLoops){
      if(li>=partner||pairLoops.get(partner)!==li)continue;
      const proposed=new Map();let valid=true;
      for(const edgeId of loops[li]){
        const edge=boundary[edgeId],other=boundary[candidates[edgeId][0]];
        for(const [a,b] of [[edge.a,other.b],[edge.b,other.a]]){const low=Math.min(a,b),high=Math.max(a,b);if(proposed.has(high)&&proposed.get(high)!==low)valid=false;proposed.set(high,low);}
      }
      if(valid)for(const [a,b] of proposed)replacement.set(a,b);
    }
    if(replacement.size){
      const welded=new Float64Array(p);
      for(let i=0;i<ti.ids.length;i++){const v=ti.ids[i],target=replacement.get(v);if(target===undefined)continue;const offset=ti.offsets[target];for(let k=0;k<3;k++)welded[i*3+k]=p[offset+k];}
      const candidate={...clean,positions:welded,bounds:computeBounds(welded),analysis:undefined,_prepared:undefined,_topology:undefined},after=analyzeMesh(candidate,p=>emit(85+p.percent*.1,p.message));
      if(after.degenerateTriangles||after.boundaryEdges>=cleanBefore.boundaryEdges||after.nonManifoldEdges>cleanBefore.nonManifoldEdges||after.inconsistentEdges>cleanBefore.inconsistentEdges){warnings.push('A candidate seam would change surface topology ambiguously; it was left unchanged.');}
      else{clean=candidate;report.weldedVertices=replacement.size;for(const [a,b] of replacement)report.maxVertexShiftMm=Math.max(report.maxVertexShiftMm,distance(point(a),point(b)));}
    }
  }
  emit(95,'Validating repaired topology');
  const after=analyzeMesh(clean,p=>emit(95+p.percent*.05,p.message));
  report.changed=Boolean(report.weldedVertices||report.removedDegenerateTriangles||report.removedDuplicateTriangles);
  report.boundaryEdgesAfter=after.boundaryEdges;report.nonManifoldEdgesAfter=after.nonManifoldEdges;report.inconsistentEdgesAfter=after.inconsistentEdges;report.watertight=after.watertight;
  if(after.boundaryEdges)warnings.push(`${after.boundaryEdges} open boundary edges remain. They do not form a unique precision-scale seam; no holes were filled.`);
  if(after.nonManifoldEdges)warnings.push(`${after.nonManifoldEdges} non-manifold edges remain and require mesh editing.`);
  if(after.inconsistentEdges)warnings.push(`${after.inconsistentEdges} inconsistent winding edges remain and require orientation repair.`);
  emit(100,'Mesh cleanup complete');
  return {mesh:clean,report};
}

export function transformMesh(mesh,{rotation=[0,0,0],translation=[0,0,0],ground=false}={}) {
  if(rotation.length!==3||translation.length!==3||[...rotation,...translation].some(v=>!finite(Number(v))))fail('Invalid placement transform.','INVALID_TRANSFORM');
  const a=rotation.map(v=>v*Math.PI/180),c=a.map(Math.cos),s=a.map(Math.sin),input=mesh.positions,p=new Float64Array(input.length);
  for(let i=0;i<input.length;i+=3){let x=input[i],y=input[i+1],z=input[i+2];[y,z]=[y*c[0]-z*s[0],y*s[0]+z*c[0]];[x,z]=[x*c[1]+z*s[1],-x*s[1]+z*c[1]];[x,y]=[x*c[2]-y*s[2],x*s[2]+y*c[2]];p[i]=x+translation[0];p[i+1]=y+translation[1];p[i+2]=z+translation[2];}
  let bounds=computeBounds(p);
  if(ground){for(let i=2;i<p.length;i+=3)p[i]-=bounds.min[2];bounds=computeBounds(p);}
  return {...mesh,positions:p,bounds,analysis:undefined,_prepared:undefined,_topology:undefined,transform:{rotation:[...rotation],translation:[...translation],ground}};
}

export function signedArea(ring){let a=0;const [x,y]=ring[0]||[0,0];for(let i=0,j=ring.length-1;i<ring.length;j=i++)a+=(ring[j][0]-x)*(ring[i][1]-y)-(ring[i][0]-x)*(ring[j][1]-y);return a/2;}
export function pointInRing(point,ring){let inside=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const a=ring[i],b=ring[j];if((a[1]>point[1])!==(b[1]>point[1])&&point[0]<(b[0]-a[0])*(point[1]-a[1])/(b[1]-a[1])+a[0])inside=!inside;}return inside;}
function ringBounds(r){const min=[Infinity,Infinity],max=[-Infinity,-Infinity];for(const p of r)for(let k=0;k<2;k++){min[k]=Math.min(min[k],p[k]);max[k]=Math.max(max[k],p[k]);}return {min,max};}
function simplifyRing(points,tolerance){
  let r=points;for(let pass=0;pass<3;pass++){const next=[];for(let i=0;i<r.length;i++){const a=r[(i+r.length-1)%r.length],b=r[i],c=r[(i+1)%r.length];const cross=(b[0]-a[0])*(c[1]-b[1])-(b[1]-a[1])*(c[0]-b[0]);const dot=(b[0]-a[0])*(c[0]-b[0])+(b[1]-a[1])*(c[1]-b[1]);if(Math.abs(cross)>tolerance*(Math.hypot(b[0]-a[0],b[1]-a[1])+Math.hypot(c[0]-b[0],c[1]-b[1]))||dot<0)next.push(b);}if(next.length<3)return r;if(next.length===r.length)break;r=next;}return r;
}
function orient(a,b,c){return (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);}
function segmentsCross(a,b,c,d,tol){
  const o1=orient(a,b,c),o2=orient(a,b,d),o3=orient(c,d,a),o4=orient(c,d,b);
  const e1=tol*Math.max(1,Math.hypot(b[0]-a[0],b[1]-a[1])),e2=tol*Math.max(1,Math.hypot(d[0]-c[0],d[1]-c[1]));
  if(((o1>e1&&o2<-e1)||(o1<-e1&&o2>e1))&&((o3>e2&&o4<-e2)||(o3<-e2&&o4>e2)))return true;
  const on=(p,u,v)=>p[0]>=Math.min(u[0],v[0])-tol&&p[0]<=Math.max(u[0],v[0])+tol&&p[1]>=Math.min(u[1],v[1])-tol&&p[1]<=Math.max(u[1],v[1])+tol;
  return (Math.abs(o1)<=e1&&on(c,a,b))||(Math.abs(o2)<=e1&&on(d,a,b))||(Math.abs(o3)<=e2&&on(a,c,d))||(Math.abs(o4)<=e2&&on(b,c,d));
}
function validateRingIntersections(rings,tolerance){
  const segments=[];let xmin=Infinity,ymin=Infinity,xmax=-Infinity,ymax=-Infinity;
  for(let r=0;r<rings.length;r++)for(let i=0;i<rings[r].length;i++){const a=rings[r][i],b=rings[r][(i+1)%rings[r].length];segments.push({a,b,r,i,n:rings[r].length});xmin=Math.min(xmin,a[0]);xmax=Math.max(xmax,a[0]);ymin=Math.min(ymin,a[1]);ymax=Math.max(ymax,a[1]);}
  if(!segments.length)return;
  const cell=Math.max(tolerance*16,Math.max(xmax-xmin,ymax-ymin)/Math.max(1,Math.sqrt(segments.length))),buckets=new Map();let entries=0;
  for(let id=0;id<segments.length;id++){
    const s=segments[id],x0=Math.floor((Math.min(s.a[0],s.b[0])-xmin)/cell),x1=Math.floor((Math.max(s.a[0],s.b[0])-xmin)/cell),y0=Math.floor((Math.min(s.a[1],s.b[1])-ymin)/cell),y1=Math.floor((Math.max(s.a[1],s.b[1])-ymin)/cell),seen=new Set();
    for(let x=x0;x<=x1;x++)for(let y=y0;y<=y1;y++){
      if(++entries>3000000)fail('Contour intersection check exceeds the browser complexity limit.','CONTOUR_TOO_COMPLEX');
      const key=`${x},${y}`,bucket=buckets.get(key)||[];
      for(const otherId of bucket){if(seen.has(otherId))continue;seen.add(otherId);const q=segments[otherId];if(s.r===q.r&&(s.i===q.i||(s.i+1)%s.n===q.i||(q.i+1)%q.n===s.i))continue;if(segmentsCross(s.a,s.b,q.a,q.b,tolerance))fail('Slice contours intersect or touch. Separate overlapping parts or repair the STL.','INTERSECTING_CONTOURS');}
      bucket.push(id);buckets.set(key,bucket);
    }
  }
}

function sliceExact(meshes,zMm,{validate=true}={}) {
  if(!Array.isArray(meshes))meshes=[meshes];
  if(!finite(zMm))fail('Slice height must be finite.','INVALID_Z');
  const tolerance=numericTolerance(meshes),nodes=[],edges=[];
  for(const mesh of meshes){const p=mesh.positions,prep=prepared(mesh),topology=indexed(mesh),nodeMap=new Map();
    function intersection(a,b){
      let va=topology.ids[a/3],vb=topology.ids[b/3];
      // Shared edges are interpolated in one canonical direction so adjacent
      // facets produce identical endpoints, even close to a vertex elevation.
      if(va>vb){[va,vb]=[vb,va];[a,b]=[b,a];}
      const za=p[a+2],zb=p[b+2],t=(zMm-za)/(zb-za),key=zMm===za?`v${va}`:zMm===zb?`v${vb}`:`e${va}:${vb}`;
      let id=nodeMap.get(key);if(id!==undefined)return id;
      id=nodes.length;nodeMap.set(key,id);nodes.push({p:[p[a]+t*(p[b]-p[a]),p[a+1]+t*(p[b+1]-p[a+1])],edges:[]});return id;
    }
    for(let ti=0;ti<prep.minZ.length;ti++){
    if(zMm<prep.minZ[ti]||zMm>=prep.maxZ[ti])continue;
    const j=ti*9,hits=[];
    for(let e=0;e<3;e++){const a=j+e*3,b=j+((e+1)%3)*3,za=p[a+2],zb=p[b+2];if((za<=zMm&&zb>zMm)||(zb<=zMm&&za>zMm))hits.push(intersection(a,b));}
    if(hits.length!==2||hits[0]===hits[1])continue;
    let [a,b]=hits;const first=nodes[a].p,last=nodes[b].p;
    const direction=(last[0]-first[0])*(-prep.normalY[ti])+(last[1]-first[1])*prep.normalX[ti];if(direction<0)[a,b]=[b,a];
    const id=edges.length;edges.push({a,b,nz:prep.normalZ[ti],minZ:prep.minZ[ti],maxZ:prep.maxZ[ti],used:false});nodes[a].edges.push(id);nodes[b].edges.push(id);
  }}
  for(const v of nodes)if(v.edges.length&&v.edges.length!==2)fail(v.edges.length<2?'Slice contains an unresolved open contour. Run mesh cleanup and inspect remaining boundary edges.':'Slice has ambiguous contour junctions. Parts may overlap or touch.','OPEN_CONTOUR',{zMm,degree:v.edges.length,xMm:v.p[0],yMm:v.p[1]});
  const rings=[],maxNormals=[],inputSigns=[],enclosures=[];
  for(let seed=0;seed<edges.length;seed++){
    if(edges[seed].used)continue;let edgeId=seed,current=edges[seed].a,start=current,ring=[],maxNz=0,steps=0,directionBalance=0,enclosureMinZ=-Infinity,enclosureMaxZ=Infinity;
    do{const edge=edges[edgeId];if(edge.used)fail('Slice loop did not close consistently.','OPEN_CONTOUR',{zMm});edge.used=true;ring.push(nodes[current].p);maxNz=Math.max(maxNz,edge.nz);enclosureMinZ=Math.max(enclosureMinZ,edge.minZ);enclosureMaxZ=Math.min(enclosureMaxZ,edge.maxZ);directionBalance+=edge.a===current?1:-1;current=edge.a===current?edge.b:edge.a;edgeId=nodes[current].edges.find(id=>!edges[id].used);if(++steps>edges.length+1)fail('Slice loop exceeded its traversal bound.','OPEN_CONTOUR');}while(current!==start&&edgeId!==undefined);
    if(current!==start)fail('Slice contains an incomplete loop.','OPEN_CONTOUR',{zMm});
    ring=simplifyRing(ring,tolerance*.25);
    if(ring.length<3||signedArea(ring)===0)fail('A slice contour collapses at this sampling plane. Inspect the mesh junction or use a nearby plane.','DEGENERATE_CONTOUR',{zMm});
    rings.push(ring);maxNormals.push(maxNz);enclosures.push({ring,minZ:enclosureMinZ,maxZ:enclosureMaxZ,exactVertical:maxNz<1e-12});inputSigns.push(Math.abs(directionBalance)===steps?Math.sign(signedArea(ring))*Math.sign(directionBalance):0);
  }
  if(validate)validateRingIntersections(rings,tolerance*.1);
  const rb=rings.map(ringBounds),depths=rings.map((r,i)=>rings.reduce((depth,q,j)=>depth+(i!==j&&rb[j].min[0]<=r[0][0]&&rb[j].max[0]>=r[0][0]&&rb[j].min[1]<=r[0][1]&&rb[j].max[1]>=r[0][1]&&pointInRing(r[0],q)?1:0),0));
  let areaMm2=0,outerMaxNormalZ=0;
  for(let i=0;i<rings.length;i++){const desired=depths[i]%2===0?1:-1;
    if(validate&&inputSigns[i]!==desired)fail('Contour nesting conflicts with STL facet winding. Repair overlapping/nested solids or facet orientation before export.','INVALID_WINDING',{zMm,depth:depths[i]});
    if(Math.sign(signedArea(rings[i]))!==desired)rings[i].reverse();areaMm2+=signedArea(rings[i]);if(depths[i]===0)outerMaxNormalZ=Math.max(outerMaxNormalZ,maxNormals[i]);}
  return {zMm,rings,depths,outerRings:rings.filter((_,i)=>depths[i]===0),outerEnclosures:enclosures.filter((_,i)=>depths[i]===0),areaMm2,outerMaxNormalZ,vertexCount:rings.reduce((sum,r)=>sum+r.length,0),toleranceMm:tolerance};
}

/** One shared sampler for planning, preview and export. A singular plane may be
 * offset only on an exactly closed mesh and only within a recorded numerical
 * bound; missing faces and arbitrary gaps never qualify for this retry. */
export function sliceAt(meshes,zMm,{validate=true,recover=true,zBounds}={}){
  if(!Array.isArray(meshes))meshes=[meshes];
  try{return {...sliceExact(meshes,zMm,{validate}),sampleZMm:zMm,recovery:{shiftedPlane:false,shiftMm:0}};}
  catch(error){
    if(!recover||!['OPEN_CONTOUR','DEGENERATE_CONTOUR'].includes(error.code))throw error;
    const tolerance=numericTolerance(meshes);let nearVertex=false,nearestOther=Infinity;
    for(const mesh of meshes)for(let i=2;i<mesh.positions.length;i+=3){const d=Math.abs(mesh.positions[i]-zMm);if(d<=tolerance*4)nearVertex=true;else nearestOther=Math.min(nearestOther,d);}
    if(!nearVertex||meshes.some(mesh=>{const a=analyzeMesh(mesh);return !a.watertight||!a.consistentWinding;}))throw error;
    const shift=Math.min(1e-5,Math.max(1e-9,tolerance*64),nearestOther/4),limits=zBounds||[Math.min(...meshes.map(m=>m.bounds.min[2])),Math.max(...meshes.map(m=>m.bounds.max[2]))];
    for(const direction of [1,-1]){
      const sampleZMm=zMm+shift*direction;if(!(sampleZMm>limits[0]&&sampleZMm<limits[1])||sampleZMm===zMm)continue;
      try{return {...sliceExact(meshes,sampleZMm,{validate}),zMm,sampleZMm,recovery:{shiftedPlane:true,shiftMm:sampleZMm-zMm,reason:'singular vertex or edge plane'}};}catch(retry){if(!['OPEN_CONTOUR','DEGENERATE_CONTOUR'].includes(retry.code))throw retry;}
    }
    throw error;
  }
}

function enclosureProfile(enclosures,meshes,tolerance,cache){
  // Exact coordinates avoid reusing an interior result after an exterior moves.
  // Canonical start vertices make the cache independent of triangle traversal.
  const rings=enclosures.map(e=>e.ring),key=rings.map(r=>{
    let first=0;for(let i=1;i<r.length;i++)if(r[i][0]<r[first][0]||(r[i][0]===r[first][0]&&r[i][1]<r[first][1]))first=i;
    return r.map((_,i)=>r[(i+first)%r.length].join(',')).join(';');
  }).sort().join('|');
  let profile=cache.enclosures.find(p=>p.key===key);if(profile)return profile;
  const polygons=rings.map(ring=>({ring,bounds:ringBounds(ring),convex:ring.every((b,i)=>orient(ring[(i+ring.length-1)%ring.length],b,ring[(i+1)%ring.length])>=0)}));
  profile={key,polygons,tolerance,triangles:meshes.map(m=>new Uint8Array(m.positions.length/9))};
  cache.enclosures.push(profile);if(cache.enclosures.length>4)cache.enclosures.shift();return profile;
}
function projectedTriangleInside(mesh,triangle,profile,meshIndex){
  const memo=profile.triangles[meshIndex];if(memo[triangle])return memo[triangle]===1;
  const p=mesh.positions,j=triangle*9,vertices=[[p[j],p[j+1]],[p[j+3],p[j+4]],[p[j+6],p[j+7]]],tol=profile.tolerance;
  for(const {ring,bounds,convex} of profile.polygons){
    if(vertices.some(v=>v[0]<=bounds.min[0]+tol||v[0]>=bounds.max[0]-tol||v[1]<=bounds.min[1]+tol||v[1]>=bounds.max[1]-tol))continue;
    let inside=true;
    if(convex){
      for(let i=0;inside&&i<ring.length;i++){const a=ring[i],b=ring[(i+1)%ring.length],margin=tol*Math.hypot(b[0]-a[0],b[1]-a[1]);if(vertices.some(v=>orient(a,b,v)<=margin))inside=false;}
    }else{
      if(vertices.some(v=>!pointInRing(v,ring)))continue;
      for(let i=0;inside&&i<ring.length;i++)for(let e=0;e<3;e++)if(segmentsCross(vertices[e],vertices[(e+1)%3],ring[i],ring[(i+1)%ring.length],tol)){inside=false;break;}
    }
    if(inside){memo[triangle]=1;return true;}
  }
  memo[triangle]=2;return false;
}
function classifyInterval(meshes,z0,z1,angle,cache){
  let checked=0;
  function at(z){checked++;const key=z.toFixed(7);let slice=cache.slices.get(key);if(!slice){slice=sliceAt(meshes,z,{validate:false});cache.slices.set(key,slice);if(cache.slices.size>32)cache.slices.delete(cache.slices.keys().next().value);}return slice;}
  const reference=at((z0+z1)/2),maxNz=Math.sin(angle*Math.PI/180);
  if(!reference.outerRings.length)return {vertical:false,reason:'empty',samples:checked};
  if(reference.outerMaxNormalZ>maxNz+1e-8)return {vertical:false,reason:'sloped',samples:checked};
  // A triangle can be hidden at one sample but become an exterior shoulder later.
  // Ignore its events only inside a vertical enclosure whose contributing facets
  // all span this entire interval. This proves the enclosure persists, including
  // between samples. Faces on its perimeter, transient outer islands and exterior
  // caps remain candidates. Dense lattice wholly inside it cannot force baseline.
  const enclosures=reference.outerEnclosures.filter(e=>e.exactVertical&&e.minZ<=z0&&e.maxZ>=z1);
  const profile=enclosures.length?enclosureProfile(enclosures,meshes,reference.toleranceMm*2,cache):null;
  const events=new Set(),epsilon=1e-7;
  for(let mi=0;mi<meshes.length;mi++){
    const mesh=meshes[mi],prep=prepared(mesh),p=mesh.positions;
    for(let ti=0;ti<prep.minZ.length;ti++){
      if(prep.maxZ[ti]<=z0+epsilon||prep.minZ[ti]>=z1-epsilon)continue;
      const j=ti*9,heights=[p[j+2],p[j+5],p[j+8]].filter(z=>z>z0+epsilon&&z<z1-epsilon);
      if(!heights.length||(profile&&projectedTriangleInside(mesh,ti,profile,mi)))continue;
      // A horizontal face not proven internal is a possible exterior ledge/cap.
      // Sampling just above and below can show two vertical walls yet miss this
      // quality-sensitive transition, so it explicitly retains baseline layers.
      if(prep.normalZ[ti]>1-1e-12)return {vertical:false,reason:'transition',samples:checked};
      for(const z of heights)events.add(Math.round(z*1e6)/1e6);
      if(events.size>24)return {vertical:false,reason:'complex',samples:checked};
    }
  }
  const unique=[...events].sort((a,b)=>a-b);
  const boundaries=[z0,...unique,z1],samples=[z0+(z1-z0)*.001,z1-(z1-z0)*.001];for(let i=1;i<boundaries.length;i++)if(boundaries[i]-boundaries[i-1]>1e-8)samples.push((boundaries[i]+boundaries[i-1])/2);
  let count=reference.outerRings.length;
  for(const z of samples){const slice=at(z);
    if(!slice.outerRings.length)return {vertical:false,reason:'empty',samples:checked};
    if(slice.outerMaxNormalZ>maxNz+1e-8)return {vertical:false,reason:'sloped',samples:checked};
    if(count!==slice.outerRings.length)return {vertical:false,reason:'transition',samples:checked};
  }
  return {vertical:true,reason:'vertical',samples:checked};
}

export function planLayers(meshes,options={},onProgress=()=>{}) {
  if(!Array.isArray(meshes))meshes=[meshes];if(!meshes.length)fail('Import at least one STL first.','NO_MESH');
  const baselineUm=options.baselineUm??100,preferredUm=options.preferredUm??150,angle=options.verticalToleranceDeg??3,automatic=options.automatic!==false;
  for(const v of [baselineUm,preferredUm])if(!Number.isInteger(v)||v<50||v>200)fail('Layer thickness must be an integer from 50 to 200 µm.','INVALID_THICKNESS');
  if(!finite(angle)||angle<0||angle>30)fail('Vertical-wall tolerance must be between 0° and 30°.','INVALID_ANGLE');
  const actualMaxZ=Math.max(...meshes.map(m=>m.bounds.max[2])),minZ=Math.min(...meshes.map(m=>m.bounds.min[2]));
  if(minZ<-1e-4)fail('Ground the build before generating its layer schedule.','BUILD_BELOW_BED');
  const heightUm=Math.round(actualMaxZ*1000);
  if(heightUm<50)fail('Build height is below the minimum 50 µm layer thickness.','BUILD_TOO_SHORT');
  if(heightUm/50>ENGINE_LIMITS.maxLayers*4)fail('Build height exceeds the browser layer-planning limit.','BUILD_TOO_TALL');
  const warnings=[],overrides=[],boundaries=new Set([0,heightUm]);
  const supportRaw=options.supportEndMm??0;
  if(!finite(supportRaw)||supportRaw<0)fail('Support end height must be nonnegative.','INVALID_SUPPORT_RANGE');
  let supportEndUm=clamp(Math.round(supportRaw*1000/50)*50,0,heightUm);
  if(heightUm-supportEndUm>0&&heightUm-supportEndUm<50)supportEndUm=heightUm;
  boundaries.add(supportEndUm);
  if(Math.abs(supportEndUm-supportRaw*1000)>.001)warnings.push(`Support end snapped to ${(supportEndUm/1000).toFixed(3)} mm.`);
  for(const [index,row] of (options.overrides||[]).entries()){
    const from=Number(row.fromMm),to=Number(row.toMm),thicknessUm=Number(row.thicknessUm);
    if(!finite(from)||!finite(to)||from<0||to<=from||!Number.isInteger(thicknessUm)||thicknessUm<50||thicknessUm>200)fail(`Manual range ${index+1} is invalid. Use positive heights and 50–200 µm layers.`,'INVALID_OVERRIDE');
    let fromUm=clamp(Math.round(from*1000/50)*50,0,heightUm),toUm=clamp(Math.round(to*1000/50)*50,0,heightUm);
    if(heightUm-fromUm>0&&heightUm-fromUm<50)fromUm=heightUm;
    if(heightUm-toUm>0&&heightUm-toUm<50)toUm=heightUm;
    if(toUm-fromUm<50)fail(`Manual range ${index+1} is shorter than 50 µm after snapping.`,'INVALID_OVERRIDE');
    const override={fromUm,toUm,fromMm:fromUm/1000,toMm:toUm/1000,thicknessUm,id:row.id??index};overrides.push(override);boundaries.add(fromUm);boundaries.add(toUm);
    if(Math.abs(fromUm-from*1000)>.001||Math.abs(toUm-to*1000)>.001)warnings.push(`Manual range ${index+1} snapped to ${(fromUm/1000).toFixed(3)}–${(toUm/1000).toFixed(3)} mm.`);
  }
  overrides.sort((a,b)=>a.fromUm-b.fromUm);for(let i=1;i<overrides.length;i++)if(overrides[i].fromUm<overrides[i-1].toUm)fail('Manual height ranges overlap. Separate them before planning.','OVERLAPPING_OVERRIDES');
  const sorted=[...boundaries].sort((a,b)=>a-b),layers=[],cache={slices:new Map(),enclosures:[]};let z=0,sampleCount=0;
  for(let band=1;band<sorted.length;band++){
    const bandStart=sorted[band-1],end=sorted[band];if(end<=bandStart)continue;
    const manual=overrides.find(r=>r.fromUm<=bandStart&&r.toUm>=end);
    while(z<end){
      let requestedUm=baselineUm,reason='standard',classification='not-scanned';
      if(manual){requestedUm=manual.thicknessUm;reason='manual';}
      else if(z<supportEndUm){requestedUm=preferredUm;reason='support';}
      else if(automatic&&preferredUm>baselineUm){const c=classifyInterval(meshes,z/1000,Math.min(end,z+preferredUm)/1000,angle,cache);sampleCount+=c.samples;classification=c.reason;if(c.vertical){requestedUm=preferredUm;reason='vertical';}}
      let thicknessUm=Math.min(requestedUm,end-z),remaining=end-z-thicknessUm;
      if(remaining>0&&remaining<50){if(end-z>=100)thicknessUm=end-z-50;else thicknessUm=end-z;}
      if(thicknessUm<50||thicknessUm>200)fail('Selected height boundaries cannot be covered by 50–200 µm layers.','INFEASIBLE_SCHEDULE');
      const bottomUm=z;z+=thicknessUm;layers.push({index:layers.length,zMm:z/1000,zStartMm:bottomUm/1000,thicknessUm,requestedUm,reason,classification,adjusted:thicknessUm!==requestedUm});
      if(layers.length>ENGINE_LIMITS.maxLayers)fail('Schedule exceeds the 20,000-layer browser limit.','TOO_MANY_LAYERS');
      if(layers.length%20===0)onProgress({stage:'planning',current:z,total:heightUm,percent:z/heightUm*100});
    }
  }
  if(Math.abs(heightUm/1000-actualMaxZ)>1e-8)warnings.push(`Build endpoint rounded from ${actualMaxZ.toFixed(6)} to ${(heightUm/1000).toFixed(3)} mm (nearest micron).`);
  const adjustedCount=layers.filter(l=>l.adjusted).length;if(adjustedCount)warnings.push(`${adjustedCount} layers adjusted within 50–200 µm to fit section boundaries and final height.`);
  const complexCount=layers.filter(l=>l.classification==='complex').length;if(complexCount)warnings.push(`${complexCount} layers retained baseline thickness because exterior complexity or an unverified vertical enclosure exceeded the conservative scan limit.`);
  warnings.push('Automatic classification checks outermost cross-section boundaries. Nested internal contours do not drive thickness; STL has no semantic lattice or cavity labels. Review critical internal surfaces.');
  return {layers,heightMm:heightUm/1000,actualHeightMm:actualMaxZ,heightUm,baselineUm,preferredUm,supportEndMm:supportEndUm/1000,overrides,verticalToleranceDeg:angle,warnings,classificationSamples:sampleCount,maskConvention:'midpoint masks; zMm is interval end'};
}

/** Yield one completely validated layer at a time. Consumers can serialize and
 * release its rings immediately; only the current slice is retained here. The
 * final iterator return is the build summary, including all recovery warnings. */
export function* sliceLayerIterator(meshes,plan,onProgress=()=>{}) {
  if(!Array.isArray(meshes))meshes=[meshes];
  for(const mesh of meshes){const check=analyzeMesh(mesh);if(!check.watertight)fail(`${mesh.name||'STL'} is not watertight: ${check.boundaryEdges} open and ${check.nonManifoldEdges} non-manifold edges. Repair it before export.`,'INVALID_MESH',check);if(check.inconsistentEdges)fail(`${mesh.name||'STL'} has inconsistent facet winding. Repair orientation before export.`,'INVALID_WINDING',check);}
  let vertices=0,recoveredPlanes=0,maxPlaneShiftMm=0;
  for(let i=0;i<plan.layers.length;i++){
    const layer=plan.layers[i],mid=(layer.zStartMm+layer.zMm)/2,slice=sliceAt(meshes,mid,{zBounds:[layer.zStartMm,layer.zMm]});
    if(slice.recovery.shiftedPlane){recoveredPlanes++;maxPlaneShiftMm=Math.max(maxPlaneShiftMm,Math.abs(slice.recovery.shiftMm));}
    vertices+=slice.vertexCount;
    if(i%10===0||i===plan.layers.length-1)onProgress({stage:'slicing',current:i+1,total:plan.layers.length,percent:(i+1)/plan.layers.length*100,contourVertexCount:vertices});
    yield {...layer,rings:slice.rings,areaMm2:slice.areaMm2,sampleZMm:slice.sampleZMm,recovery:slice.recovery};
  }
  const warnings=[...(plan.warnings||[])];if(recoveredPlanes)warnings.push(`${recoveredPlanes} singular sampling planes shifted by at most ${maxPlaneShiftMm.toExponential(2)} mm; layer endpoints are unchanged.`);
  return {warnings,contourVertexCount:vertices,recoveredPlanes,maxPlaneShiftMm};
}

/** Compatibility collector; streaming export should use sliceLayerIterator. */
export function sliceBuild(meshes,plan,onProgress=()=>{}) {
  const layers=[],iterator=sliceLayerIterator(meshes,plan,onProgress);
  for(;;){const next=iterator.next();if(next.done)return {...plan,layers,...next.value};layers.push(next.value);}
}

/** Closed indexed primitive fixtures are also used for the built-in demo. */
export function createBoxMesh(width=20,depth=20,height=30,name='Box.stl') {
  const v=[[0,0,0],[width,0,0],[width,depth,0],[0,depth,0],[0,0,height],[width,0,height],[width,depth,height],[0,depth,height]];
  const f=[[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]];
  const positions=new Float64Array(f.flatMap(t=>t.flatMap(i=>v[i])));return {name,positions,triangleCount:f.length,bounds:computeBounds(positions),format:'generated'};
}
export function createDemoMesh(){
  // Closed stepped tower: vertical shaft with a sloped shoulder and vertical tip.
  const levels=[[0,12],[12,12],[25,12],[35,7],[45,7]],sides=48,vertices=[];
  for(const [z,r] of levels)for(let i=0;i<sides;i++){const angle=i/sides*Math.PI*2;vertices.push([r*Math.cos(angle),r*Math.sin(angle),z]);}
  const faces=[];
  for(let l=0;l<levels.length-1;l++)for(let i=0;i<sides;i++){const a=l*sides+i,b=l*sides+(i+1)%sides,c=(l+1)*sides+i,d=(l+1)*sides+(i+1)%sides;faces.push([a,b,d],[a,d,c]);}
  const bottom=vertices.length;vertices.push([0,0,0]);const top=vertices.length;vertices.push([0,0,45]);
  for(let i=0;i<sides;i++){faces.push([bottom,(i+1)%sides,i]);const o=(levels.length-1)*sides;faces.push([top,o+i,o+(i+1)%sides]);}
  const positions=new Float64Array(faces.flatMap(t=>t.flatMap(i=>vertices[i])));return {name:'Demo — shoulder tower.stl',positions,triangleCount:faces.length,bounds:computeBounds(positions),format:'generated'};
}
