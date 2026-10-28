import test from 'node:test';
import assert from 'node:assert/strict';
import {createBoxMesh,transformMesh} from '../dist/engine.js';
import {movePartXY} from '../dist/placement.js';
const bed={width:100,depth:100,margin:5,gap:3};
const part=(id,x,y)=>({...transformMesh(createBoxMesh(10,15,2),{translation:[x,y,0]}),id});
test('move changes only selected XY; preserves source and Z',()=>{
 const a=part('a',10,10),b=part('b',70,70),original=Array.from(a.positions),moved=movePartXY([a,b],'a',30,40,bed);
 assert.equal(moved[1],b);assert.deepEqual(Array.from(a.positions),original);
 for(let i=0;i<a.positions.length;i+=3){assert.equal(moved[0].positions[i],a.positions[i]+20);assert.equal(moved[0].positions[i+1],a.positions[i+1]+30);assert.equal(moved[0].positions[i+2],a.positions[i+2]);}
});
test('reject invalid positions, margin violations and overlaps',()=>{
 const meshes=[part('a',10,10),part('b',70,70)];
 for(const [id,x,y] of [['a',0,20],['a',90,20],['a',70,70],['a',NaN,20],['missing',20,20]])assert.throws(()=>movePartXY(meshes,id,x,y,bed));
});
