import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeSLC, decodeSLC, samplingTableForLayers, signedRingArea } from '../dist/slc.js';

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
