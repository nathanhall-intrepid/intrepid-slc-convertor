import test from 'node:test';
import assert from 'node:assert/strict';
import {parseSTL,analyzeMesh,computeBounds,transformMesh,createBoxMesh,createDemoMesh,sliceAt,planLayers,sliceBuild,signedArea} from '../dist/engine.js';
import {encodeSLC,decodeSLC} from '../dist/slc.js';

function binary(mesh,header='solid binary STL') {
  const b=new ArrayBuffer(84+mesh.triangleCount*50),v=new DataView(b);new Uint8Array(b).set(new TextEncoder().encode(header).slice(0,80));v.setUint32(80,mesh.triangleCount,true);
  for(let i=0;i<mesh.triangleCount;i++)for(let k=0;k<9;k++)v.setFloat32(84+i*50+12+k*4,mesh.positions[i*9+k],true);return b;
}
function ascii(mesh) {let text='solid vertex fixture\n';for(let i=0;i<mesh.positions.length;i+=9){text+='facet normal 0 0 0\nouter loop\n';for(let k=0;k<9;k+=3)text+=`vertex ${mesh.positions[i+k].toExponential()} ${mesh.positions[i+k+1].toExponential()} ${mesh.positions[i+k+2].toExponential()}\n`;text+='endloop\nendfacet\n';}return new TextEncoder().encode(text+'endsolid vertex fixture\n').buffer;}
function reverse(mesh){const p=new Float64Array(mesh.positions);for(let i=0;i<p.length;i+=9)for(let k=0;k<3;k++)[p[i+3+k],p[i+6+k]]=[p[i+6+k],p[i+3+k]];return {...mesh,positions:p,_prepared:undefined,analysis:undefined};}
function merge(meshes){const positions=new Float64Array(meshes.flatMap(m=>Array.from(m.positions)));return {name:'combined.stl',positions,triangleCount:positions.length/9,bounds:computeBounds(positions)};}
function squareProfile(levels,center=[20,20]){
  const vertices=levels.flatMap(([z,r])=>[[-r,-r],[r,-r],[r,r],[-r,r]].map(([x,y])=>[x+center[0],y+center[1],z]));
  const faces=[[0,2,1],[0,3,2]];
  for(let level=0;level<levels.length-1;level++)for(let side=0;side<4;side++){
    const a=level*4+side,b=level*4+(side+1)%4,c=a+4,d=b+4;faces.push([a,b,d],[a,d,c]);
  }
  const top=(levels.length-1)*4;faces.push([top,top+1,top+2],[top,top+2,top+3]);
  const positions=new Float64Array(faces.flatMap(f=>f.flatMap(v=>vertices[v])));return {name:'profile.stl',positions,triangleCount:faces.length,bounds:computeBounds(positions)};
}
function denseCavity({from=1,to=4,steps=1500,radius=4,center=[20,20]}={}){
  return reverse(squareProfile(Array.from({length:steps+1},(_,i)=>[from+(to-from)*i/steps,radius+(i%2)*.03]),center));
}

test('binary STL with solid header and ASCII scientific notation parse identically',()=>{
  const cube=createBoxMesh(20,10,8),a=parseSTL(binary(cube),'binary.stl'),b=parseSTL(ascii(cube),'ascii.stl');
  assert.equal(a.format,'binary');assert.equal(b.format,'ascii');assert.deepEqual(a.bounds,b.bounds);assert.deepEqual([...a.positions],[...b.positions]);assert.ok(Math.abs(analyzeMesh(a).volumeMm3-1600)<1e-8);
  const inch=parseSTL(binary(createBoxMesh(1,1,1)),'inches.stl',{unitScale:25.4});assert.equal(inch.bounds.max[0],25.4);
});
test('malformed STL, nonfinite coordinates, open meshes are rejected',()=>{
  assert.throws(()=>parseSTL(new ArrayBuffer(20)),/supported/);
  const bad=binary(createBoxMesh());new DataView(bad).setFloat32(96,NaN,true);assert.throws(()=>parseSTL(bad),/invalid/);
  const cube=createBoxMesh(),positions=cube.positions.slice(9),open={...cube,positions,triangleCount:11};
  assert.ok(analyzeMesh(open).boundaryEdges>0);assert.throws(()=>sliceBuild([open],planLayers([cube],{automatic:false})),/not watertight/);
});
test('transform rotates and grounds a part without changing volume',()=>{
  const m=transformMesh(createBoxMesh(20,10,8),{rotation:[90,0,0],translation:[3,4,5],ground:true});
  assert.ok(Math.abs(m.bounds.size[2]-10)<1e-10);assert.equal(m.bounds.min[2],0);assert.ok(Math.abs(analyzeMesh(m).volumeMm3-1600)<1e-8);
});
test('cube slice is one CCW four-point ring of correct area; reversed whole mesh remains valid',()=>{
  for(const mesh of [createBoxMesh(20,10,8),reverse(createBoxMesh(20,10,8))]){
    const s=sliceAt([mesh],4);assert.equal(s.rings.length,1);assert.equal(s.rings[0].length,4);assert.equal(s.areaMm2,200);assert.ok(signedArea(s.rings[0])>0);
  }
});
test('cavity loops are clockwise and overlapping/nested positive solids are rejected',()=>{
  const outer=createBoxMesh(30,30,30),inner=transformMesh(createBoxMesh(10,10,20),{translation:[10,10,5]});
  const hollow=merge([outer,reverse(inner)]),s=sliceAt([hollow],10);assert.equal(s.rings.length,2);assert.equal(s.areaMm2,800);assert.deepEqual(s.rings.map(signedArea).sort((a,b)=>a-b),[-100,900]);
  assert.throws(()=>sliceAt([outer,inner],10),/nesting conflicts/);
  const overlap=transformMesh(createBoxMesh(30,30,30),{translation:[15,15,0]});assert.throws(()=>sliceAt([outer,overlap],10),/intersect|ambiguous/);
});
test('mixed winding is rejected at export',()=>{
  const cube=createBoxMesh(),p=new Float64Array(cube.positions);for(let k=0;k<3;k++)[p[3+k],p[6+k]]=[p[6+k],p[3+k]];
  const bad={...cube,positions:p};assert.ok(analyzeMesh(bad).inconsistentEdges>0);assert.throws(()=>sliceBuild([bad],planLayers([cube],{automatic:false})),/winding/);
});
test('automatic plan thickens vertical exterior and retains 100 um on sloped shoulder',()=>{
  const demo=createDemoMesh(),plan=planLayers([demo],{supportEndMm:12});
  assert.equal(plan.heightUm,45000);assert.equal(plan.layers.reduce((sum,l)=>sum+l.thicknessUm,0),45000);
  assert.ok(plan.layers.some(l=>l.reason==='vertical'&&l.thicknessUm===150&&l.zMm>35.2));
  assert.ok(plan.layers.filter(l=>l.zStartMm>25.1&&l.zMm<34.9).every(l=>l.reason==='standard'&&l.thicknessUm<=100));
  assert.ok(plan.layers.filter(l=>l.zMm<=12).every(l=>l.reason==='support'));
});
test('nested sloped cavity does not drive exterior-only thickness',()=>{
  const outer=createBoxMesh(40,40,60),demo=transformMesh(createDemoMesh(),{translation:[20,20,5]});
  const hollow=merge([outer,reverse(demo)]),plan=planLayers([hollow],{supportEndMm:0});
  assert.ok(plan.layers.filter(l=>l.zStartMm>31&&l.zMm<39).every(l=>l.reason==='vertical'));
  const sample=sliceAt([hollow],35);assert.equal(sample.outerMaxNormalZ,0);assert.equal(sample.rings.length,2);
});
test('dense internal lattice-like surfaces do not force baseline inside a persistent vertical exterior',()=>{
  const hollow=merge([createBoxMesh(40,40,6),denseCavity()]);
  assert.equal(hollow.triangleCount,12016);assert.ok(analyzeMesh(hollow).watertight);
  const plan=planLayers([hollow],{supportEndMm:0});
  assert.equal(plan.layers.length,40);assert.ok(plan.layers.every(l=>l.reason==='vertical'&&l.thicknessUm===150));
  assert.equal(plan.layers.filter(l=>l.classification==='complex').length,0);
  // Filtering only affects planning: the actual exported masks still contain the
  // nested inner boundary and retain its winding and area contribution.
  const sliced=sliceAt([hollow],2.075);assert.equal(sliced.rings.length,2);assert.equal(sliced.depths.filter(d=>d===1).length,1);
});
test('brief inward exterior caps are protected even when dense inner events are excluded elsewhere',()=>{
  const shell=squareProfile([[0,8],[1.02,8],[1.02,6],[1.03,6],[1.03,8],[3,8]]);
  const hollow=merge([shell,denseCavity({from:.2,to:2.8,steps:1300,radius:2})]);
  assert.ok(analyzeMesh(hollow).watertight);
  const plan=planLayers([hollow],{supportEndMm:0});
  const crossing=plan.layers.filter(l=>l.zStartMm<1.03&&l.zMm>1.02);
  assert.ok(crossing.length>0);assert.ok(crossing.every(l=>l.reason==='standard'&&l.thicknessUm<=100));
  assert.ok(plan.layers.some(l=>l.classification==='transition'));
  assert.ok(plan.layers.filter(l=>l.zMm<.9||l.zStartMm>1.2).every(l=>l.reason==='vertical'));
});
test('brief exterior slopes and temporary outer islands cannot be hidden by midpoint containment',()=>{
  const shell=squareProfile([[0,8],[1.02,8],[1.025,6],[1.03,8],[3,8]]);
  const plan=planLayers([shell],{supportEndMm:0});
  assert.ok(plan.layers.some(l=>l.classification==='sloped'));
  assert.ok(plan.layers.filter(l=>l.zStartMm<1.03&&l.zMm>1.02).every(l=>l.reason==='standard'&&l.thicknessUm<=100));
  const column=createBoxMesh(20,20,3),island=transformMesh(createBoxMesh(2,2,.01),{translation:[30,5,1.02]});
  const islands=planLayers([column,island],{supportEndMm:0});
  assert.ok(islands.layers.filter(l=>l.zStartMm<1.03&&l.zMm>1.02).every(l=>l.reason==='standard'&&l.thicknessUm<=100));
  assert.ok(islands.layers.some(l=>l.classification==='transition'));
});
test('manual band overrides slopes; overlapping ranges fail',()=>{
  const demo=createDemoMesh(),plan=planLayers([demo],{supportEndMm:0,overrides:[{fromMm:26,toMm:27,thicknessUm:200}]});
  const selected=plan.layers.filter(l=>l.zStartMm>=26&&l.zMm<=27);assert.equal(selected.length,5);assert.ok(selected.every(l=>l.reason==='manual'&&l.thicknessUm===200));
  assert.throws(()=>planLayers([demo],{overrides:[{fromMm:1,toMm:3,thicknessUm:100},{fromMm:2,toMm:4,thicknessUm:150}]}),/overlap/);
});
test('odd final heights and snapped boundaries always use legal integer steps and preserve rounded height',()=>{
  for(const height of [.051,.075,.101,1.001,1.049,1.051,3.0004])for(const desired of [50,75,100,150,200]){
    const plan=planLayers([createBoxMesh(1,1,height)],{baselineUm:100,preferredUm:desired,supportEndMm:5});
    assert.ok(plan.layers.every(l=>Number.isInteger(l.thicknessUm)&&l.thicknessUm>=50&&l.thicknessUm<=200));
    assert.equal(plan.layers.reduce((s,l)=>s+l.thicknessUm,0),Math.round(height*1000));
    assert.equal(plan.layers.at(-1).zMm,Math.round(height*1000)/1000);
  }
});
test('SLC encoding/decoding of actual sliced demo preserves variable schedule and area orientation',()=>{
  const mesh=createDemoMesh(),plan=planLayers([mesh],{supportEndMm:12}),build=sliceBuild([mesh],plan),bytes=encodeSLC(build.layers),read=decodeSLC(bytes);
  assert.equal(read.layers.length,build.layers.length);assert.equal(read.topZMm,45);assert.ok(read.samplingTable.length>1);
  assert.ok(build.layers.every(l=>l.rings.length===1&&signedArea(l.rings[0])>0));
});
