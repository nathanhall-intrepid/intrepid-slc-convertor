import test from 'node:test';
import assert from 'node:assert/strict';
import {createBoxMesh,transformMesh,computeBounds} from '../dist/engine.js';
import {packBuild,validateLayout} from '../dist/layout.js';

const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-6,`${a} != ${b}`);
const part=(w,d,h,id)=>({...createBoxMesh(w,d,h,`${id}.stl`),id,customMetadata:`source-${id}`});

test('single part is centered and grounded without changing geometry or source',()=>{
  const mesh=transformMesh(part(20,30,40,'a'),{translation:[-17,7,42]});
  const source=Array.from(mesh.positions);
  const result=packBuild([mesh],{width:100,depth:120,gap:5,margin:10});
  near(result.bounds.center[0],50);near(result.bounds.center[1],60);
  near(result.bounds.min[2],0);near(result.bounds.max[2],40);
  assert.deepEqual(Array.from(mesh.positions),source);
  assert.equal(result.meshes[0].customMetadata,'source-a');
  assert.equal(result.meshes[0].id,'a');
  assert.equal(result.meshes[0].positions.length,mesh.positions.length);
  assert.ok(validateLayout(result.meshes,{width:100,depth:120,gap:5,margin:10}).valid);
});

test('repeated parts obey edge margin and part gap and preserve ordering',()=>{
  const meshes=Array.from({length:9},(_,i)=>part(20,25,10,String(i)));
  const options={width:100,depth:110,gap:4,margin:6};
  const result=packBuild(meshes,options);
  const check=validateLayout(result.meshes,options);
  assert.equal(check.valid,true,check.errors.join('; '));
  assert.equal(result.meshes.length,9);
  assert.deepEqual(result.meshes.map(m=>m.id),meshes.map(m=>m.id));
  for(const p of result.placements){assert.ok(p.x>=6-1e-6);assert.ok(p.y>=6-1e-6);assert.ok(p.x+p.width<=94+1e-6);assert.ok(p.y+p.depth<=104+1e-6);}
  near(result.bounds.center[0],50);near(result.bounds.center[1],55);
  near(result.utilization,9*20*25/((100-12)*(110-12)));
  const again=packBuild(meshes,options);
  assert.deepEqual(result.placements,again.placements);
});

test('90-degree Z turn enables fitting while scaling and tilt remain unchanged',()=>{
  const mesh=part(70,25,18,'rotated');
  const options={width:40,depth:90,gap:3,margin:5};
  const result=packBuild([mesh],options);
  assert.equal(result.placements[0].rotationZ,90);
  near(result.meshes[0].bounds.size[0],25);near(result.meshes[0].bounds.size[1],70);near(result.meshes[0].bounds.size[2],18);
  assert.throws(()=>packBuild([mesh],{...options,allowRotate:false}),/does not fit/);
});

test('manually tilted mesh keeps its Z height and triangle edge lengths',()=>{
  const input=transformMesh(part(10,20,30,'tilt'),{rotation:[30,20,15],ground:true});
  const out=packBuild([input],{width:100,depth:100}).meshes[0];
  near(input.bounds.size[2],out.bounds.size[2]);
  for(let i=0;i<input.positions.length;i+=9){
    const p=input.positions,q=out.positions;
    near(Math.hypot(p[i]-p[i+3],p[i+1]-p[i+4],p[i+2]-p[i+5]),Math.hypot(q[i]-q[i+3],q[i+1]-q[i+4],q[i+2]-q[i+5]));
  }
});

test('packing refuses oversize, unfit multi-part builds, duplicate ids and bad settings',()=>{
  assert.throws(()=>packBuild([part(101,20,10,'large')],{width:100,depth:100,margin:0}),/does not fit/);
  assert.throws(()=>packBuild([part(60,60,10,'a'),part(60,60,10,'b')],{width:100,depth:100,margin:0,gap:0}),/could not fit/);
  assert.throws(()=>packBuild([part(10,10,10,'a'),part(10,10,10,'a')]),/Duplicate/);
  assert.throws(()=>packBuild([]),/at least one/);
  assert.throws(()=>packBuild([part(10,10,10,'a')],{width:100,depth:100,margin:50}),/no usable/);
  assert.throws(()=>packBuild([part(10,10,10,'a')],{gap:-1}),/nonnegative/);
});

test('validation catches manual collisions, margin violations and below-bed parts',()=>{
  const options={width:100,depth:100,margin:5,gap:5};
  const placements=[{id:'a',name:'A',x:10,y:10,width:20,depth:20},{id:'b',name:'B',x:34,y:10,width:20,depth:20}];
  assert.equal(validateLayout(placements,options).valid,false);
  placements[1].x=35;assert.equal(validateLayout(placements,options).valid,true);
  placements[0].x=1;assert.match(validateLayout(placements,options).errors.join(' '),/margin/);
  const below=transformMesh(part(10,10,10,'below'),{translation:[20,20,-1]});
  assert.match(validateLayout([below],options).errors.join(' '),/below/);
});

test('exact-fit bed retains margins and does not add a gap at its outer edge',()=>{
  const result=packBuild([part(40,20,10,'a'),part(40,20,10,'b')],{width:95,depth:30,margin:5,gap:5,allowRotate:false});
  assert.equal(validateLayout(result.placements,{width:95,depth:30,margin:5,gap:5}).valid,true);
  near(result.bounds.min[0],5);near(result.bounds.max[0],90);
  near(result.bounds.min[1],5);near(result.bounds.max[1],25);
});
