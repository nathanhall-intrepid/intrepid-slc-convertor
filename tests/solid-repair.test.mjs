import test from 'node:test';
import assert from 'node:assert/strict';
import {repairForSlicing} from '../dist/solid-repair.js';
import {createBoxMesh,transformMesh,computeBounds,analyzeMesh,sliceAt,planLayers,sliceBuild} from '../dist/engine.js';
import {encodeSLC,decodeSLC} from '../dist/slc.js';
const combine=(...meshes)=>{const positions=new Float64Array(meshes.reduce((n,m)=>n+m.positions.length,0));let n=0;for(const m of meshes){positions.set(m.positions,n);n+=m.positions.length;}return {name:'synthetic.stl',positions,triangleCount:positions.length/9,bounds:computeBounds(positions)};};
const box=(offset=[0,0,0])=>transformMesh(createBoxMesh(2,2,2),{translation:offset});

test('closed overlapping solids are unioned, reported, and export with their real volume',async()=>{
  const source=combine(box(),box([1,.5,0])),original=source.positions.slice(),progress=[];
  const {mesh,report}=await repairForSlicing(source,p=>progress.push(p));
  assert.deepEqual(source.positions,original);assert(report.changed);assert.equal(report.solidUnion.shells,2);
  assert.equal(report.solidUnion.surfaceToleranceMm,.0001);
  assert(analyzeMesh(mesh).watertight);assert(Math.abs(analyzeMesh(mesh).volumeMm3-13)<1e-5);
  assert(Math.abs(sliceAt(mesh,1).areaMm2-6.5)<1e-6);
  assert(progress.some(p=>p.percent===null&&p.message.includes('Combining')));
  const plan=planLayers([mesh],{automatic:false,baselineUm:100,supportEndMm:0});
  const decoded=decodeSLC(encodeSLC(sliceBuild([mesh],plan).layers));assert.equal(decoded.layers.length,20);
});
test('disjoint solids retain original surfaces and geometry',async()=>{
 const source=combine(box(),box([4,0,0]));const {mesh,report}=await repairForSlicing(source);
 assert.equal(report.changed,false);assert.deepEqual(mesh.positions,source.positions);assert.equal(sliceAt(mesh,1).rings.length,2);
});
test('negative cavity shell is preserved rather than filled',async()=>{
 const outer=box(),inner=transformMesh(createBoxMesh(1,1,1),{translation:[.5,.5,.5]});
 for(let j=0;j<inner.positions.length;j+=9)for(let k=0;k<3;k++){const t=inner.positions[j+3+k];inner.positions[j+3+k]=inner.positions[j+6+k];inner.positions[j+6+k]=t;}
 const source=combine(outer,inner),{mesh,report}=await repairForSlicing(source);
 assert(!report.solidUnion);assert.deepEqual(mesh.positions,source.positions);assert.equal(sliceAt(mesh,1).rings.length,2);assert.equal(sliceAt(mesh,1).areaMm2,3);
});
test('missing faces are not invented by solid repair',async()=>{
 const source=box();source.positions=source.positions.slice(9);source.triangleCount--;
 const {mesh,report}=await repairForSlicing(source);assert(!report.solidUnion);assert(analyzeMesh(mesh).boundaryEdges>0);assert.deepEqual(mesh.positions,source.positions);
});
test('short nonadjacent contour edges keep a real gap despite being under a millimetre',()=>{
 const a=transformMesh(createBoxMesh(.00002,.00002,1),{translation:[350,310,0]});
 const b=transformMesh(createBoxMesh(.00002,.00002,1),{translation:[350.00002001,310.00002001,0]});
 const section=sliceAt([a,b],.5);assert.equal(section.rings.length,2);
});

test('SLC precision cleanup resolves a collapsed submicron notch and records its bound',async()=>{
 const {createContourPrecisionRepair}=await import('../dist/solid-repair.js');
 const {createSLCEncoder}=await import('../dist/slc.js');
 const ring=[[400,300],[402,300],[402,302],[400,302],[400,301.000001],[401,301.000001],[401,301],[400,301]];
 const layer={zMm:.1,thicknessUm:100,rings:[ring]};
 assert.throws(()=>encodeSLC([layer]));
 const encoder=createSLCEncoder([layer],{repairQuantizedContours:await createContourPrecisionRepair()});
 encoder.addLayer(layer);const decoded=decodeSLC(encoder.finish());assert.equal(decoded.layers[0].rings.length,1);
 assert.equal(encoder.stats.precisionRepairs.length,1);assert.equal(encoder.stats.precisionRepairs[0].boundaryToleranceMm,.001);
 assert(Math.abs(encoder.stats.precisionRepairs[0].areaChangeMm2)<.00001);
});
test('SLC precision cleanup refuses crossings that exist before rounding',async()=>{
 const {createContourPrecisionRepair}=await import('../dist/solid-repair.js');
 const {createSLCEncoder}=await import('../dist/slc.js');
 const layer={zMm:.1,thicknessUm:100,rings:[[[0,0],[2,2],[0,2],[2,0]]]};
 const encoder=createSLCEncoder([layer],{repairQuantizedContours:await createContourPrecisionRepair()});
 assert.throws(()=>encoder.addLayer(layer));assert.equal(encoder.stats.precisionRepairs.length,0);
});

test('overlapping shells sharing a non-manifold edge become one valid solid',async()=>{
 const a=box(),b=box();for(let i=0;i<b.positions.length;i+=3){const x=b.positions[i],y=b.positions[i+1];b.positions[i]=x+y*.5;b.positions[i+1]=y+x*.5;}b.bounds=computeBounds(b.positions);
 const source=combine(a,b);assert(analyzeMesh(source).nonManifoldEdges>0);
 const {mesh,report}=await repairForSlicing(source);assert(report.solidUnion);assert.equal(analyzeMesh(mesh).nonManifoldEdges,0);assert.equal(analyzeMesh(mesh).boundaryEdges,0);assert.equal(sliceAt(mesh,1).rings.length,1);
});
