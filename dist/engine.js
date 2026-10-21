/** Browser-local STL inspection, planar slicing and adaptive layer planning.
 * Coordinates are millimetres. Layer zMm is the END of its interval; masks are
 * sampled at interval mid-height. SLC serialization owns its minimum-Z records.
 * No automatic mesh repair or semantic lattice/support classification is claimed.
 */
export const ENGINE_LIMITS = Object.freeze({maxLayers:20000,maxContourVertices:3000000,maxFileBytes:200*1024*1024});

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

export function parseSTL(input,name='part.stl',{unitScale=1}={}) {
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
    for(let i=0;i<count;i++){const start=84+i*50+12;for(let k=0;k<9;k++)positions[i*9+k]=view.getFloat32(start+k*4,true)*unitScale;}
    format='binary';
  } else {
    const text=new TextDecoder().decode(buffer);
    if(!/^\s*solid\b/i.test(text)) fail('Not a supported ASCII or complete binary STL.','INVALID_STL');
    const facets=text.match(/facet\s+normal\s+[\s\S]*?endfacet/gi)||[];
    if(!facets.length) fail('ASCII STL has no facets.','INVALID_STL');
    positions=new Float64Array(facets.length*9);let offset=0;
    const number='[-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][-+]?\\d+)?';
    const rx=new RegExp('\\bvertex\\s+('+number+')\\s+('+number+')\\s+('+number+')','gi');
    for(const facet of facets){const vertices=[...facet.matchAll(rx)];if(vertices.length!==3||!/outer\s+loop/i.test(facet)||!/endloop/i.test(facet))fail('Each STL facet must contain one three-vertex loop.','INVALID_STL');for(const v of vertices)for(let k=1;k<=3;k++)positions[offset++]=Number(v[k])*unitScale;}
    const body=text.replace(/^\s*solid[^\r\n]*(?:\r?\n)?/i,'').replace(/endsolid[^\r\n]*\s*$/i,'');
    const totalVertices=(body.match(/\bvertex\b/gi)||[]).length;
    if(totalVertices!==facets.length*3||!/endsolid\b/i.test(text)) fail('ASCII STL contains incomplete or unsupported facet data.','INVALID_STL');
    format='ascii';
  }
  const bounds=computeBounds(positions);
  if(Math.max(...bounds.size)<=0) fail('STL has no physical extent.','EMPTY_MESH');
  return {name,positions,triangleCount:positions.length/9,bounds,format,unitScale};
}

function prepared(mesh){
  if(mesh._prepared)return mesh._prepared;
  const p=mesh.positions,n=p.length/9,minZ=new Float64Array(n),maxZ=new Float64Array(n),normalZ=new Float64Array(n),normalX=new Float64Array(n),normalY=new Float64Array(n);let signedVolume=0;
  for(let i=0;i<n;i++) {const j=i*9;const norm=cross(p[j+3]-p[j],p[j+4]-p[j+1],p[j+5]-p[j+2],p[j+6]-p[j],p[j+7]-p[j+1],p[j+8]-p[j+2]);const len=Math.hypot(...norm);normalZ[i]=len?Math.abs(norm[2])/len:0;normalX[i]=norm[0];normalY[i]=norm[1];const bc=cross(p[j+3],p[j+4],p[j+5],p[j+6],p[j+7],p[j+8]);signedVolume+=(p[j]*bc[0]+p[j+1]*bc[1]+p[j+2]*bc[2])/6;minZ[i]=Math.min(p[j+2],p[j+5],p[j+8]);maxZ[i]=Math.max(p[j+2],p[j+5],p[j+8]);}
  if(signedVolume<0)for(let i=0;i<n;i++){normalX[i]*=-1;normalY[i]*=-1;}
  return mesh._prepared={minZ,maxZ,normalZ,normalX,normalY};
}

export function analyzeMesh(mesh) {
  if(mesh.analysis)return mesh.analysis;
  const p=mesh.positions,b=mesh.bounds||computeBounds(p),diag=Math.hypot(...b.size),tolerance=Math.max(1e-6,diag*1e-7);
  const vertexMap=new Map(),edges=new Map();let vertexCount=0,degenerateTriangles=0,volume=0,surfaceArea=0;
  for(let i=0;i<p.length;i+=9){
    const ids=[];
    for(let v=0;v<3;v++){const j=i+v*3,key=[0,1,2].map(k=>Math.round(p[j+k]/tolerance)).join(',');let id=vertexMap.get(key);if(id===undefined){id=vertexCount++;vertexMap.set(key,id);}ids.push(id);}
    const nx=cross(p[i+3]-p[i],p[i+4]-p[i+1],p[i+5]-p[i+2],p[i+6]-p[i],p[i+7]-p[i+1],p[i+8]-p[i+2]);const area=Math.hypot(...nx)/2;
    if(new Set(ids).size<3||area<tolerance*tolerance){degenerateTriangles++;continue;}
    surfaceArea+=area;const bc=cross(p[i+3],p[i+4],p[i+5],p[i+6],p[i+7],p[i+8]);volume+=(p[i]*bc[0]+p[i+1]*bc[1]+p[i+2]*bc[2])/6;
    for(let k=0;k<3;k++){const a=ids[k],c=ids[(k+1)%3],key=a<c?`${a}:${c}`:`${c}:${a}`;let edge=edges.get(key);if(!edge){edge={count:0,balance:0};edges.set(key,edge);}edge.count++;edge.balance+=a<c?1:-1;}
  }
  let boundaryEdges=0,nonManifoldEdges=0,inconsistentEdges=0;
  for(const e of edges.values()){if(e.count===1)boundaryEdges++;if(e.count>2)nonManifoldEdges++;if(e.count===2&&e.balance!==0)inconsistentEdges++;}
  const watertight=boundaryEdges===0&&nonManifoldEdges===0&&edges.size>0;
  const warnings=[];
  if(degenerateTriangles)warnings.push(`${degenerateTriangles} zero-area triangles ignored during slicing.`);
  if(inconsistentEdges)warnings.push(`${inconsistentEdges} edges have inconsistent facet winding. Repair orientation before SLC export.`);
  if(!watertight)warnings.push('Mesh has open or non-manifold edges. Repair it before SLC export.');
  return mesh.analysis={triangleCount:p.length/9,vertexCount,edgeCount:edges.size,boundaryEdges,nonManifoldEdges,inconsistentEdges,degenerateTriangles,watertight,consistentWinding:inconsistentEdges===0,signedVolumeMm3:volume,volumeMm3:Math.abs(volume),surfaceAreaMm2:surfaceArea,weldToleranceMm:tolerance,bounds:b,warnings};
}

export function transformMesh(mesh,{rotation=[0,0,0],translation=[0,0,0],ground=false}={}) {
  if(rotation.length!==3||translation.length!==3||[...rotation,...translation].some(v=>!finite(Number(v))))fail('Invalid placement transform.','INVALID_TRANSFORM');
  const a=rotation.map(v=>v*Math.PI/180),c=a.map(Math.cos),s=a.map(Math.sin),input=mesh.positions,p=new Float64Array(input.length);
  for(let i=0;i<input.length;i+=3){let x=input[i],y=input[i+1],z=input[i+2];[y,z]=[y*c[0]-z*s[0],y*s[0]+z*c[0]];[x,z]=[x*c[1]+z*s[1],-x*s[1]+z*c[1]];[x,y]=[x*c[2]-y*s[2],x*s[2]+y*c[2]];p[i]=x+translation[0];p[i+1]=y+translation[1];p[i+2]=z+translation[2];}
  let bounds=computeBounds(p);
  if(ground){for(let i=2;i<p.length;i+=3)p[i]-=bounds.min[2];bounds=computeBounds(p);}
  return {...mesh,positions:p,bounds,analysis:undefined,_prepared:undefined,transform:{rotation:[...rotation],translation:[...translation],ground}};
}

export function signedArea(ring){let a=0;for(let i=0,j=ring.length-1;i<ring.length;j=i++)a+=ring[j][0]*ring[i][1]-ring[i][0]*ring[j][1];return a/2;}
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

export function sliceAt(meshes,zMm,{validate=true}={}) {
  if(!Array.isArray(meshes))meshes=[meshes];
  if(!finite(zMm))fail('Slice height must be finite.','INVALID_Z');
  const diagonal=Math.max(1,...meshes.map(m=>Math.hypot(...m.bounds.size))),tolerance=Math.max(1e-6,diagonal*1e-7);
  const nodes=[],buckets=new Map(),edges=[];
  function node(x,y){const gx=Math.floor(x/tolerance),gy=Math.floor(y/tolerance);for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++){const ids=buckets.get(`${gx+dx},${gy+dy}`)||[];for(const i of ids)if(Math.hypot(nodes[i].p[0]-x,nodes[i].p[1]-y)<=tolerance)return i;}const id=nodes.length,key=`${gx},${gy}`;nodes.push({p:[x,y],edges:[]});const arr=buckets.get(key)||[];arr.push(id);buckets.set(key,arr);return id;}
  for(const mesh of meshes){const p=mesh.positions,prep=prepared(mesh);for(let ti=0;ti<prep.minZ.length;ti++){
    if(zMm<prep.minZ[ti]||zMm>=prep.maxZ[ti])continue;
    const j=ti*9,hits=[];
    for(let e=0;e<3;e++){const a=j+e*3,b=j+((e+1)%3)*3,za=p[a+2],zb=p[b+2];if((za<=zMm&&zb>zMm)||(zb<=zMm&&za>zMm)){const t=(zMm-za)/(zb-za);hits.push([p[a]+t*(p[b]-p[a]),p[a+1]+t*(p[b+1]-p[a+1])]);}}
    if(hits.length!==2||Math.hypot(hits[0][0]-hits[1][0],hits[0][1]-hits[1][1])<=tolerance)continue;
    let a=node(...hits[0]),b=node(...hits[1]);if(a===b)continue;
    const direction=(hits[1][0]-hits[0][0])*(-prep.normalY[ti])+(hits[1][1]-hits[0][1])*prep.normalX[ti];if(direction<0)[a,b]=[b,a];
    const id=edges.length;edges.push({a,b,nz:prep.normalZ[ti],minZ:prep.minZ[ti],maxZ:prep.maxZ[ti],used:false});nodes[a].edges.push(id);nodes[b].edges.push(id);
  }}
  for(const v of nodes)if(v.edges.length!==2)fail(v.edges.length<2?'Slice contains an open contour. Repair the mesh before export.':'Slice has ambiguous contour junctions. Parts may overlap or touch.','OPEN_CONTOUR',{zMm,degree:v.edges.length});
  const rings=[],maxNormals=[],inputSigns=[],enclosures=[];
  for(let seed=0;seed<edges.length;seed++){
    if(edges[seed].used)continue;let edgeId=seed,current=edges[seed].a,start=current,ring=[],maxNz=0,steps=0,directionBalance=0,enclosureMinZ=-Infinity,enclosureMaxZ=Infinity;
    do{const edge=edges[edgeId];if(edge.used)fail('Slice loop did not close consistently.','OPEN_CONTOUR',{zMm});edge.used=true;ring.push(nodes[current].p);maxNz=Math.max(maxNz,edge.nz);enclosureMinZ=Math.max(enclosureMinZ,edge.minZ);enclosureMaxZ=Math.min(enclosureMaxZ,edge.maxZ);directionBalance+=edge.a===current?1:-1;current=edge.a===current?edge.b:edge.a;edgeId=nodes[current].edges.find(id=>!edges[id].used);if(++steps>edges.length+1)fail('Slice loop exceeded its traversal bound.','OPEN_CONTOUR');}while(current!==start&&edgeId!==undefined);
    if(current!==start)fail('Slice contains an incomplete loop.','OPEN_CONTOUR',{zMm});
    ring=simplifyRing(ring,tolerance*.25);if(ring.length>=3&&Math.abs(signedArea(ring))>tolerance*tolerance){rings.push(ring);maxNormals.push(maxNz);enclosures.push({ring,minZ:enclosureMinZ,maxZ:enclosureMaxZ,exactVertical:maxNz<1e-12});inputSigns.push(Math.abs(directionBalance)===steps?Math.sign(signedArea(ring))*Math.sign(directionBalance):0);}
  }
  if(validate)validateRingIntersections(rings,tolerance*.1);
  const rb=rings.map(ringBounds),depths=rings.map((r,i)=>rings.reduce((depth,q,j)=>depth+(i!==j&&rb[j].min[0]<=r[0][0]&&rb[j].max[0]>=r[0][0]&&rb[j].min[1]<=r[0][1]&&rb[j].max[1]>=r[0][1]&&pointInRing(r[0],q)?1:0),0));
  let areaMm2=0,outerMaxNormalZ=0;
  for(let i=0;i<rings.length;i++){const desired=depths[i]%2===0?1:-1;
    if(validate&&inputSigns[i]!==desired)fail('Contour nesting conflicts with STL facet winding. Repair overlapping/nested solids or facet orientation before export.','INVALID_WINDING',{zMm,depth:depths[i]});
    if(Math.sign(signedArea(rings[i]))!==desired)rings[i].reverse();areaMm2+=signedArea(rings[i]);if(depths[i]===0)outerMaxNormalZ=Math.max(outerMaxNormalZ,maxNormals[i]);}
  return {zMm,rings,depths,outerRings:rings.filter((_,i)=>depths[i]===0),outerEnclosures:enclosures.filter((_,i)=>depths[i]===0),areaMm2,outerMaxNormalZ,vertexCount:rings.reduce((sum,r)=>sum+r.length,0),toleranceMm:tolerance};
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

export function sliceBuild(meshes,plan,onProgress=()=>{}) {
  if(!Array.isArray(meshes))meshes=[meshes];
  for(const mesh of meshes){const check=analyzeMesh(mesh);if(!check.watertight)fail(`${mesh.name||'STL'} is not watertight: ${check.boundaryEdges} open and ${check.nonManifoldEdges} non-manifold edges. Repair it before export.`,'INVALID_MESH',check);if(check.inconsistentEdges)fail(`${mesh.name||'STL'} has inconsistent facet winding. Repair orientation before export.`,'INVALID_WINDING',check);}
  const layers=[];let vertices=0;
  for(let i=0;i<plan.layers.length;i++){
    const layer=plan.layers[i],mid=(layer.zStartMm+layer.zMm)/2;let slice,sampleZMm=mid;
    try{slice=sliceAt(meshes,mid);}catch(error){
      if(error.code!=='OPEN_CONTOUR')throw error;
      const eps=Math.min(layer.thicknessUm/1000/10,1e-5);sampleZMm=mid+eps;
      slice=sliceAt(meshes,sampleZMm);
    }
    vertices+=slice.vertexCount;if(vertices>ENGINE_LIMITS.maxContourVertices)fail('Sliced contours exceed the 3-million-vertex export limit. Reduce build complexity.','EXPORT_TOO_LARGE');
    layers.push({...layer,rings:slice.rings,areaMm2:slice.areaMm2,sampleZMm});
    if(i%10===0||i===plan.layers.length-1)onProgress({stage:'slicing',current:i+1,total:plan.layers.length,percent:(i+1)/plan.layers.length*100});
  }
  return {...plan,layers,contourVertexCount:vertices};
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
