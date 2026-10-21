import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {parseSTL,analyzeMesh} from '../dist/engine.js';

// Six outward-oriented, uniformly triangulated faces make a real closed cube.
// Integer coordinates remain exact in binary STL. No repeated or zero-area
// triangles are used to inflate the count, and no large fixture is checked in.
function eachCubeTriangle(n,visit,xOffset=0){
  const faces=[
    [[0,0,0],[0,0,1],[0,1,0]],
    [[n,0,0],[0,1,0],[0,0,1]],
    [[0,0,0],[1,0,0],[0,0,1]],
    [[0,n,0],[0,0,1],[1,0,0]],
    [[0,0,0],[0,1,0],[1,0,0]],
    [[0,0,n],[1,0,0],[0,1,0]],
  ];
  for(const [origin,u,v] of faces){
    const point=(a,b)=>origin.map((x,k)=>x+u[k]*a+v[k]*b+(k===0?xOffset:0));
    for(let i=0;i<n;i++)for(let j=0;j<n;j++){
      const a=point(i,j),b=point(i+1,j),c=point(i+1,j+1),d=point(i,j+1);
      visit([a,b,c]);visit([a,c,d]);
    }
  }
}
function binaryCube(n){
  const buffer=new ArrayBuffer(84+12*n*n*50),view=new DataView(buffer);
  view.setUint32(80,12*n*n,true);let offset=84;
  eachCubeTriangle(n,triangle=>{
    offset+=12;
    for(const vertex of triangle)for(const value of vertex){view.setFloat32(offset,value,true);offset+=4;}
    offset+=2;
  });
  assert.equal(offset,buffer.byteLength);return buffer;
}
function asciiCube(n){
  // Bounds here are <1000, so 128 bytes per ASCII facet is a safe bound.
  const bytes=Buffer.alloc(12*n*n*128+64);let offset=bytes.write('solid dense_cube\n');
  eachCubeTriangle(n,triangle=>{
    const facet='facet normal 0 0 0\nouter loop\n'+triangle.map(v=>`vertex ${v.join(' ')}\n`).join('')+'endloop\nendfacet\n';
    offset+=bytes.write(facet,offset,'ascii');
  });
  offset+=bytes.write('endsolid dense_cube\n',offset,'ascii');
  return bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+offset);
}
async function workerJob(type,payload,transfer){
  const wrapper=`
    const {parentPort,workerData}=require('node:worker_threads');
    globalThis.self={
      addEventListener(type,callback){if(type==='message')parentPort.on('message',data=>callback({data}));},
      postMessage(message,transfer=[]){parentPort.postMessage(message,transfer);}
    };
    import(workerData.moduleURL).then(()=>parentPort.postMessage({type:'ready'}));
  `;
  const worker=new Worker(wrapper,{eval:true,workerData:{moduleURL:new URL('../dist/worker.js',import.meta.url).href}});
  let timer;
  try{
    const result=await new Promise((resolve,reject)=>{
      timer=setTimeout(()=>reject(new Error('High-triangle worker job timed out.')),30000);
      worker.on('error',reject);
      worker.on('message',message=>{
        if(message.type==='ready')worker.postMessage({id:'dense-build',type,...payload},transfer);
        else if(message.type!=='progress')resolve(message);
      });
    });
    assert.equal(result.id,'dense-build');return result;
  }finally{clearTimeout(timer);await worker.terminate();}
}

// Kept sequential to avoid overlapping the ASCII parser's large text allocation
// with the topology validator's maps or another high-count worker job.
test('triangle counts above the former 500,000 limit are accepted',{timeout:120000},async t=>{
  await t.test('binary STL: 504,300 triangles form a closed, consistently wound cube',()=>{
    const n=205,mesh=parseSTL(binaryCube(n),'dense-binary.stl');
    assert.equal(mesh.format,'binary');assert.equal(mesh.triangleCount,504300);
    assert.equal(mesh.positions.length,504300*9);
    assert.deepEqual(mesh.bounds,{min:[0,0,0],max:[n,n,n],size:[n,n,n],center:[n/2,n/2,n/2]});
    const analysis=analyzeMesh(mesh);
    assert.equal(analysis.watertight,true);assert.equal(analysis.consistentWinding,true);
    assert.equal(analysis.degenerateTriangles,0);
    // Volume sums hundreds of thousands of fractional tetrahedra.
    assert(Math.abs(analysis.volumeMm3-n**3)<n**3*1e-9);
  });

  await t.test('ASCII STL: all 504,300 facets are parsed without truncation',()=>{
    const mesh=parseSTL(asciiCube(205),'dense-ascii.stl');
    assert.equal(mesh.format,'ascii');assert.equal(mesh.triangleCount,504300);
    assert.equal(mesh.positions.length,504300*9);
    assert.deepEqual(mesh.bounds.min,[0,0,0]);assert.deepEqual(mesh.bounds.max,[205,205,205]);
    assert.deepEqual(Array.from(mesh.positions.subarray(-9)),[204,204,205,205,205,205,204,205,205]);
  });

  await t.test('worker: imports and slices two valid cubes with 504,600 combined triangles',async()=>{
    const n=145,files=['left','right'].map(id=>({id,name:`${id}.stl`,buffer:binaryCube(n)}));
    const parsed=await workerJob('parse',{files},files.map(f=>f.buffer));
    assert.equal(parsed.type,'parsed',parsed.message);
    assert.equal(parsed.meshes.reduce((sum,m)=>sum+m.triangleCount,0),504600);
    assert(parsed.diagnostics.every(d=>d.watertight&&d.consistentWinding));
    // Translate the second solid so both contours are separate; worker must
    // recompute its bounds instead of trusting the earlier import metadata.
    const meshes=parsed.meshes;
    for(let i=0;i<meshes[1].positions.length;i+=3)meshes[1].positions[i]+=200;
    const result=await workerJob('slice',{meshes,zMm:n/2},meshes.map(m=>m.positions.buffer));
    assert.equal(result.type,'slice',result.message);
    assert.equal(result.section.rings.length,2);
    assert.deepEqual(result.section.rings.map(r=>r.length),[4,4]);
    assert.equal(result.section.areaMm2,2*n*n);
    assert.equal(result.section.outerMaxNormalZ,0);
  });
});
