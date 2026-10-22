import test from 'node:test';
import assert from 'node:assert/strict';
import {computeBounds,createBoxMesh,createDemoMesh,planLayers,signedArea,sliceBuild,sliceLayerIterator,transformMesh} from '../dist/engine.js';

function polygonPrism(sides,height){
  const vertices=[];
  for(const z of [0,height])for(let i=0;i<sides;i++){const angle=i/sides*Math.PI*2;vertices.push([10*Math.cos(angle),10*Math.sin(angle),z]);}
  const faces=[];
  for(let i=0;i<sides;i++){const next=(i+1)%sides;faces.push([i,next,next+sides],[i,next+sides,i+sides]);}
  for(let i=1;i<sides-1;i++)faces.push([0,i+1,i],[sides,sides+i,sides+i+1]);
  const positions=new Float64Array(faces.flatMap(f=>f.flatMap(i=>vertices[i])));
  return {name:'streaming-prism.stl',positions,triangleCount:faces.length,bounds:computeBounds(positions)};
}

test('layer iterator and compatibility collector produce identical geometry and summary',()=>{
  const mesh=createDemoMesh(),plan=planLayers([mesh],{supportEndMm:12}),collected=sliceBuild([mesh],plan),iterator=sliceLayerIterator([mesh],plan);
  let count=0,summary;
  for(;;){const next=iterator.next();if(next.done){summary=next.value;break;}assert.deepEqual(next.value,collected.layers[count++]);}
  assert.equal(count,collected.layers.length);assert.deepEqual(summary.warnings,collected.warnings);assert.equal(summary.contourVertexCount,collected.contourVertexCount);assert.equal(summary.recoveredPlanes,collected.recoveredPlanes);assert.equal(summary.maxPlaneShiftMm,collected.maxPlaneShiftMm);
  assert.equal('layers' in summary,false);
});

test('streaming still rejects a real contour conflict after an earlier valid layer',()=>{
  const outer=createBoxMesh(10,10,.3),nested=transformMesh(createBoxMesh(2,2,.1),{translation:[4,4,.12]});
  const plan=planLayers([outer,nested],{automatic:false}),iterator=sliceLayerIterator([outer,nested],plan);
  const first=iterator.next();assert.equal(first.done,false);assert.equal(first.value.rings.length,1);
  assert.throws(()=>iterator.next(),error=>error.code==='INVALID_WINDING');
});

test('more than three million validated contour vertices stream without retaining a build array',()=>{
  const sides=1024,mesh=polygonPrism(sides,300.1),plan=planLayers([mesh],{automatic:false});
  let progress,layerCount=0,vertices=0,lastZ=0,summary;
  const iterator=sliceLayerIterator([mesh],plan,event=>{progress=event;});
  for(;;){
    const next=iterator.next();if(next.done){summary=next.value;break;}
    const layer=next.value;assert.equal(layer.rings.length,1);assert.equal(layer.rings[0].length,sides);assert.ok(signedArea(layer.rings[0])>0);
    vertices+=layer.rings[0].length;layerCount++;lastZ=layer.zMm;
    // The consumer serializes/discards this layer; no collected contour array.
  }
  assert.equal(layerCount,3001);assert.equal(vertices,3073024);assert.ok(vertices>3000000);assert.equal(lastZ,300.1);assert.equal(summary.contourVertexCount,vertices);assert.equal(progress.contourVertexCount,vertices);assert.equal(progress.percent,100);assert.equal('layers' in summary,false);
});
