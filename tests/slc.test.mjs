import test from 'node:test';
import assert from 'node:assert/strict';
import { createSLCEncoder, encodeSLC, decodeSLC, samplingTableForLayers, signedRingArea } from '../dist/slc.js';

const square = [[0,0],[10,0],[10,10],[0,10]];
const hole = [[2,2],[2,8],[8,8],[8,2]];
const layers = [
  {zMm:.1,thicknessUm:100,rings:[square,hole]},
  {zMm:.25,thicknessUm:150,rings:[square,hole]},
  {zMm:.4,thicknessUm:150,rings:[square,hole]},
  {zMm:.45,thicknessUm:50,rings:[square]},
  {zMm:.65,thicknessUm:200,rings:[square]}
];

test('mixed schedule is encoded as minimum-Z records with explicit top terminator', () => {
  const bytes=encodeSLC(layers), d=decodeSLC(bytes);
  assert.deepEqual(d.layers.map(l=>l.thicknessUm),[100,150,150,50,200]);
  assert.equal(d.samplingTable.length,4);
  assert.ok(Math.abs(d.contours[1].minZMm-.1)<1e-6);
  assert.ok(Math.abs(d.topZMm-.65)<1e-6);
  assert.equal(d.contours.length,5);
  assert.ok(signedRingArea(d.layers[0].rings[0])>0);
  assert.ok(signedRingArea(d.layers[0].rings[1])<0);
  const v=new DataView(bytes.buffer);assert.equal(v.getUint32(bytes.length-4,true),0xffffffff);
  const end=bytes.indexOf(26)+1;assert.equal(bytes[end+256],4);
  assert.ok(bytes.subarray(end,end+256).every(n=>n===0));
  assert.equal(v.getFloat32(end+257+4,true),Math.fround(.1));
});

test('independent byte fixture: a single cube contour repeated to top of part', () => {
  const header=new TextEncoder().encode('-SLCVER 2.0 -UNIT MM -TYPE PART -PACKAGE independent fixture -EXTENTS 0,1 0,1 0,0.3\r\n\x1a');
  // Fixed schema assembled independently of encodeSLC: 1 table, 1 closed contour, sentinel.
  const b=new Uint8Array(header.length+256+1+16+8+8+5*8+8);b.set(header);
  const v=new DataView(b.buffer);let o=header.length+256;b[o++]=1;
  for(const f of [0,.1,0,0]){v.setFloat32(o,f,true);o+=4;}
  v.setFloat32(o,0,true);o+=4;v.setUint32(o,1,true);o+=4;
  v.setUint32(o,5,true);o+=4;v.setUint32(o,0,true);o+=4;
  for(const f of [0,0,1,0,1,1,0,1,0,0]){v.setFloat32(o,f,true);o+=4;}
  v.setFloat32(o,.3,true);o+=4;v.setUint32(o,0xffffffff,true);
  const d=decodeSLC(b);assert.equal(d.contours.length,1);assert.equal(d.layers.length,3);
  assert.deepEqual(d.layers.map(l=>l.thicknessUm),[100,100,100]);
});

test('reject impossible Z schedules and unsupported thickness', () => {
  assert.throws(()=>encodeSLC([{zMm:.1,thicknessUm:40,rings:[square]}]),/50 to 200/);
  assert.throws(()=>encodeSLC([layers[0],{zMm:.3,thicknessUm:100,rings:[square]}]),/noncontiguous/);
  assert.throws(()=>encodeSLC([{zMm:.1,thicknessUm:100,rings:[]}]),/no nonempty/);
});

test('reject malformed geometry and winding instead of silently repairing it', () => {
  const encode=rings=>encodeSLC([{zMm:.1,thicknessUm:100,rings}]);
  assert.throws(()=>encode([square.slice().reverse()]),/counter-clockwise/);
  assert.throws(()=>encode([square,hole.slice().reverse()]),/clockwise/);
  assert.throws(()=>encode([[[0,0],[4,4],[0,4],[4,0],[5,2]]]),/intersect/);
  assert.throws(()=>encode([square,[[5,5],[12,5],[12,12],[5,12]]]),/intersect/);
  assert.throws(()=>encode([[[0,0],[NaN,1],[0,1]]]),/finite/);
});

test('255 thickness runs supported; ambiguous 256th run rejected', () => {
  let z=0;const many=Array.from({length:255},(_,i)=>{const h=i%2?150:100;z+=h/1000;return {zMm:z,thicknessUm:h,rings:[square]};});
  assert.equal(samplingTableForLayers(many).length,255);
  assert.equal(decodeSLC(encodeSLC(many)).layers.length,255);
  many.push({zMm:z+.15,thicknessUm:150,rings:[square]});
  assert.throws(()=>encodeSLC(many),/255/);
});

test('reader rejects truncation, nonclosing boundary, unexpected trailing bytes and gaps', () => {
  const good=encodeSLC([layers[0]]);
  assert.throws(()=>decodeSLC(good.slice(0,-2)),/Truncated|terminator/);
  const trailing=new Uint8Array(good.length+1);trailing.set(good);assert.throws(()=>decodeSLC(trailing),/after SLC terminator/);
  const end=good.indexOf(26)+1;
  const bad=good.slice();new DataView(bad.buffer).setUint32(end+256+1+16+8+4,1,true);
  assert.throws(()=>decodeSLC(bad),/gapped/);
  const open=good.slice();new DataView(open.buffer).setFloat32(end+256+1+16+8+8+4*8,1,true);
  assert.throws(()=>decodeSLC(open),/explicitly close/);
});

test('incremental writer matches batch bytes and does not retain source geometry',()=>{
  const schedule=layers.map(({zMm,thicknessUm})=>({zMm,thicknessUm}));
  const encoder=createSLCEncoder(schedule);
  for(const layer of layers){
    const transient={...layer,rings:layer.rings.map(r=>r.map(p=>p.slice()))};
    const metadata=encoder.addLayer(transient);
    assert.equal(metadata.ringCount,layer.rings.length);
    for(const ring of transient.rings)for(const point of ring)point.fill(999);
  }
  const bytes=encoder.finish();
  assert.deepEqual(bytes,encodeSLC(layers));
  assert.equal(encoder.stats.verifiedLayers,layers.length);
  assert.equal(encoder.stats.byteLength,bytes.length);
  assert.equal(encoder.stats.collapsedVertices,0);
  assert(encoder.layerMetadata.every(layer=>!('rings' in layer)));
  assert.throws(()=>encoder.addLayer(layers[0]),/closed/);
  assert.throws(()=>encoder.finish(),/closed/);
});

test('incremental writer rejects missing, reordered, and invalid layers atomically',()=>{
  const missing=createSLCEncoder(layers);missing.addLayer(layers[0]);
  assert.throws(()=>missing.finish(),/Expected 5 layers, received 1/);
  const order=createSLCEncoder(layers);
  assert.throws(()=>order.addLayer(layers[1]),/planned schedule/);
  assert.throws(()=>order.finish(),/closed/);
  const bad=createSLCEncoder([layers[0]]);
  assert.throws(()=>bad.addLayer({...layers[0],rings:[square.slice().reverse()]}),/counter-clockwise/);
  assert.throws(()=>bad.finish(),/closed/);
});

test('metadata-only decoding validates every contour, reports byte progress, and retains no rings',()=>{
  const bytes=encodeSLC(layers),progress=[],seen=[];
  const decoded=decodeSLC(bytes,{retainGeometry:false,onProgress:value=>progress.push(value),onContour:(contour,index)=>{
    assert.equal(index,seen.length);
    assert.equal(contour.rings.length,layers[index].rings.length);
    seen.push({ringCount:contour.ringCount,vertexCount:contour.vertexCount});
  }});
  assert.equal(seen.length,layers.length);
  assert.equal(decoded.layerCount,layers.length);
  assert.equal(decoded.contourCount,layers.length);
  assert(decoded.contours.every(contour=>!('rings' in contour)));
  assert(decoded.layers.every(layer=>!('rings' in layer)));
  assert.deepEqual(decoded.layers.map(({ringCount,vertexCount})=>({ringCount,vertexCount})),seen);
  assert(progress.every((p,i)=>p.unit==='bytes'&&Number.isFinite(p.percent)&&p.percent>=0&&p.percent<=100&&(!i||p.current>=progress[i-1].current)));
  assert.equal(progress.at(-1).current,bytes.length);assert.equal(progress.at(-1).percent,100);
  const corrupted=bytes.slice(),view=new DataView(corrupted.buffer),firstContour=bytes.indexOf(26)+1+256+1+4*16;
  view.setUint32(firstContour+8,0xffffffff,true);
  assert.throws(()=>decodeSLC(corrupted,{retainGeometry:false}),/remaining file bytes/);
});

test('float32 normalization removes only adjacent collapsed endpoints and reports the change',()=>{
  const schedule=[{zMm:.1,thicknessUm:100}];
  for(const ring of [
    [[1,1],[1+1e-8,1],[2,1],[2,2],[1,2]],
    [[1,1],[2,1],[2,2],[1,2],[1,1+1e-8]],
  ]){
    const encoder=createSLCEncoder(schedule);encoder.addLayer({...schedule[0],rings:[ring]});
    const decoded=decodeSLC(encoder.finish());
    assert.equal(encoder.stats.collapsedVertices,1);
    assert.equal(decoded.layers[0].vertexCount,4);
    assert.equal(signedRingArea(decoded.layers[0].rings[0]),1);
  }
  const encode=rings=>encodeSLC([{...schedule[0],rings}]);
  assert.throws(()=>encode([[[1,1],[3,1],[3,3],[1+1e-8,1+1e-8],[1,3]]]),/repeated|collapsed/);
  assert.throws(()=>encode([square,[[1,1],[1,1+1e-8],[1+1e-8,1+1e-8],[1+1e-8,1]]]),/collapses/);
  // Quantization must not hide an existing tiny self intersection.
  assert.throws(()=>encode([[[1,1],[1+2e-8,1+2e-8],[1,1+2e-8],[2,1],[2,2],[1,2]]]),/intersect/);
});

test('streamed build exceeding three million contour vertices round-trips without retained geometry',{timeout:60000},()=>{
  const vertexCount=512,layerCount=6001;
  const ring=Array.from({length:vertexCount},(_,i)=>[10+5*Math.cos(2*Math.PI*i/vertexCount),10+5*Math.sin(2*Math.PI*i/vertexCount)]);
  const schedule=Array.from({length:layerCount},(_,i)=>({zMm:(i+1)/10,thicknessUm:100}));
  const encoder=createSLCEncoder(schedule);
  for(const layer of schedule)encoder.addLayer({...layer,rings:[ring]});
  const bytes=encoder.finish();let validatedContours=0;
  const decoded=decodeSLC(bytes,{retainGeometry:false,onContour:contour=>{
    validatedContours++;assert.equal(contour.rings.length,1);assert.equal(contour.vertexCount,vertexCount);
  }});
  assert.equal(encoder.stats.contourVertexCount,3072512);
  assert.equal(decoded.contourVertexCount,encoder.stats.contourVertexCount);
  assert.equal(decoded.totalVertices,encoder.stats.encodedVertexCount);
  assert.equal(decoded.layerCount,layerCount);assert.equal(validatedContours,layerCount);
  assert(decoded.layers.every(layer=>layer.vertexCount===vertexCount&&!('rings' in layer)));
});
