import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {createBoxMesh} from '../dist/engine.js';
import {decodeSLC} from '../dist/slc.js';

// Exercise the browser message listener through real structured-clone and
// transferable-buffer boundaries. Each job has a fresh worker, as in app.js.
const wrapper = `
  const {parentPort,workerData}=require('node:worker_threads');
  globalThis.self={
    addEventListener(type,callback){
      if(type==='message')parentPort.on('message',data=>callback({data}));
    },
    postMessage(message,transfer=[]){parentPort.postMessage(message,transfer);}
  };
  import(workerData.moduleURL).then(()=>parentPort.postMessage({type:'ready'}));
`;
let serial=0;
async function job(type,payload={},transfer=[]) {
  const id=`test-${++serial}`;
  const worker=new Worker(wrapper,{eval:true,workerData:{moduleURL:new URL('../dist/worker.js',import.meta.url).href}});
  const progress=[];
  let timer;
  try {
    const message=await new Promise((resolve,reject)=>{
      timer=setTimeout(()=>reject(new Error(`Worker ${type} timed out.`)),15000);
      worker.on('error',reject);
      worker.on('exit',code=>{if(code!==0)reject(new Error(`Worker exited with ${code}.`));});
      worker.on('message',message=>{
        if(message.type==='ready'){
          try{worker.postMessage({id,type,...payload},transfer);}catch(error){reject(error);}
          return;
        }
        try{
          assert.equal(message.id,id);
          if(message.type==='progress'){
            assert.equal(typeof message.stage,'string');
            assert(message.percent===null||(Number.isFinite(message.percent)&&message.percent>=0&&message.percent<=100));
            progress.push(message);
          }else resolve(message);
        }catch(error){reject(error);}
      });
    });
    return {message,progress};
  }finally{clearTimeout(timer);await worker.terminate();}
}
const part=(height=1,id='box')=>({...createBoxMesh(2,3,height,`${id}.stl`),id});
const bed={width:100,depth:100,gap:3,margin:5};
function binarySTL(mesh){
  const buffer=new ArrayBuffer(84+50*mesh.triangleCount),view=new DataView(buffer);
  view.setUint32(80,mesh.triangleCount,true);
  for(let i=0;i<mesh.triangleCount;i++)for(let k=0;k<9;k++)view.setFloat32(84+50*i+12+k*4,mesh.positions[9*i+k],true);
  return buffer;
}
function expectType(result,type){assert.equal(result.message.type,type,result.message.message);return result.message;}

test('module worker: demo -> packed adaptive plan -> slice -> verified SLC',async()=>{
  const demo=expectType(await job('demo'),'parsed');
  assert.equal(demo.meshes.length,1);
  assert(demo.diagnostics[0].watertight);
  const original=demo.meshes[0].positions.slice();
  const planning=await job('plan',{meshes:demo.meshes,options:{baselineUm:100,preferredUm:150,supportEndMm:12,overrides:[{fromMm:25,toMm:35,thicknessUm:50}],bed},pack:true});
  const planned=expectType(planning,'planned');
  assert(planning.progress.some(p=>p.stage==='planning'));
  assert.deepEqual(demo.meshes[0].positions,original,'posting meshes must not transfer or mutate the source');
  assert(!('_prepared' in planned.meshes[0]));
  assert.equal(planned.placements.length,1);
  assert(planned.plan.exportable);
  assert(planned.plan.layers.every(l=>l.thicknessUm>=50&&l.thicknessUm<=200));
  const manual=planned.plan.layers.filter(l=>l.zStartMm>=25&&l.zMm<=35);
  assert.equal(manual.length,200);
  assert(manual.every(l=>l.thicknessUm===50&&l.reason==='manual'));
  const layer=manual[0];
  const section=expectType(await job('slice',{meshes:planned.meshes,zMm:(layer.zStartMm+layer.zMm)/2}),'slice');
  assert(section.section.rings.length>0&&section.section.areaMm2>0);
  const exporting=await job('export',{meshes:planned.meshes,plan:planned.plan});
  const exported=expectType(exporting,'exported');
  assert(exported.buffer instanceof ArrayBuffer);
  assert.equal(exported.byteLength,exported.buffer.byteLength);
  assert.equal(exported.layerCount,planned.plan.layers.length);
  assert(exported.contourVertexCount > 0);
  assert(Number.isInteger(exported.recovery.collapsedVertices));
  const decoded=decodeSLC(exported.buffer);
  assert.equal(decoded.layers.length,planned.plan.layers.length);
  assert.equal(decoded.samplingTable.length,planned.plan.slcRunCount);
  assert.deepEqual(decoded.layers.map(l=>l.thicknessUm),planned.plan.layers.map(l=>l.thicknessUm));
  assert(Math.abs(decoded.topZMm-planned.plan.heightMm)<1e-5);
  assert.deepEqual([...new Set(exporting.progress.map(p=>p.stage))],['analyzing','slicing','encoding','verifying']);
  assert(exporting.progress.some(p=>p.stage==='verifying'&&p.unit==='bytes'&&p.current>0&&p.current<p.total));
});

test('binary STL buffers transfer, while multiple packed meshes remain usable',async()=>{
  const first=binarySTL(part()),second=binarySTL(part());
  const parsed=expectType(await job('parse',{files:[{id:'a',name:'a.stl',buffer:first,unitScale:1},{id:'b',name:'b.stl',buffer:second,unitScale:1}]},[first,second]),'parsed');
  assert.equal(first.byteLength,0);assert.equal(second.byteLength,0);
  assert.deepEqual(parsed.meshes.map(m=>m.id),['a','b']);
  assert(parsed.diagnostics.every(d=>d.watertight&&d.consistentWinding));
  const planned=expectType(await job('plan',{meshes:parsed.meshes,options:{automatic:false,baselineUm:100,bed}}),'planned');
  assert.equal(planned.placements.length,2);
  const exported=expectType(await job('export',{meshes:planned.meshes,plan:planned.plan}),'exported');
  assert.equal(exported.layerCount,10);
  assert(decodeSLC(exported.buffer).layers.every(l=>l.rings.length===2));
  assert(planned.meshes.every(m=>m.positions.byteLength>0));
});

test('malformed imports and invalid user planning inputs return structured errors',async t=>{
  const cases=[
    ['empty import','parse',{files:[]},'PART_LIMIT'],
    ['invalid STL','parse',{files:[{name:'bad.stl',buffer:new ArrayBuffer(20)}]},'INVALID_STL'],
    ['negative unit scale','parse',{files:[{buffer:binarySTL(part()),unitScale:-1}]},'INVALID_UNITS'],
    ['invalid preferred thickness','plan',{meshes:[part()],options:{preferredUm:201,bed}},'INVALID_THICKNESS'],
    ['overlapping bands','plan',{meshes:[part()],options:{bed,overrides:[{fromMm:0,toMm:.5,thicknessUm:100},{fromMm:.4,toMm:.8,thicknessUm:150}]}},'OVERLAPPING_OVERRIDES'],
    ['part cannot fit','plan',{meshes:[part()],options:{bed:{width:1,depth:1,gap:0,margin:0}}},'PART_TOO_LARGE'],
    ['nonfinite preview height','slice',{meshes:[part()],zMm:NaN},'INVALID_Z'],
    ['too many parts','plan',{meshes:Array.from({length:33},(_,i)=>part(1,String(i))),options:{bed}},'PART_LIMIT'],
  ];
  for(const [name,type,payload,code] of cases)await t.test(name,async()=>{
    const error=expectType(await job(type,payload),'error');
    assert.equal(error.code,code);assert.equal(typeof error.message,'string');assert(!error.buffer);
  });
});

test('export rejects a changed build height or malformed schedule',async()=>{
  const planned=expectType(await job('plan',{meshes:[part()],options:{automatic:false,bed}}),'planned');
  const changed=planned.meshes.map(mesh=>({...mesh,positions:Float64Array.from(mesh.positions,(v,i)=>i%3===2?v*2:v)}));
  const stale=expectType(await job('export',{meshes:changed,plan:planned.plan}),'error');
  assert.equal(stale.code,'STALE_PLAN');
  const invalid={...planned.plan,layers:planned.plan.layers.slice(1)};
  const broken=expectType(await job('export',{meshes:planned.meshes,plan:invalid}),'error');
  assert.equal(broken.code,'INVALID_PLAN');
});

test('more than 255 thickness runs remain viewable and cannot export a truncated table',async()=>{
  const overrides=Array.from({length:150},(_,i)=>({fromMm:i*.2,toMm:i*.2+.1,thicknessUm:50}));
  const planned=expectType(await job('plan',{meshes:[part(30)],options:{automatic:false,baselineUm:100,bed,overrides}}),'planned');
  assert.equal(planned.plan.slcRunCount,300);
  assert.equal(planned.plan.exportable,false);
  assert.match(planned.plan.exportWarning,/255/);
  assert(planned.plan.warnings.includes(planned.plan.exportWarning));
  const exported=await job('export',{meshes:planned.meshes,plan:planned.plan});
  assert.equal(expectType(exported,'error').code,'sampling-table-limit');
  assert.equal(exported.progress.length,0,'table overflow must fail before expensive slicing');
});

test('import cleans duplicate and zero-area facets and retains the repair report through export',async()=>{
  const mesh=part(),original=mesh.positions;
  mesh.positions=new Float64Array([...original,...original.slice(0,9),0,0,0,0,0,0,0,0,0]);
  mesh.triangleCount=mesh.positions.length/9;
  const parsing=await job('parse',{files:[{id:'cleanup',name:'cleanup.stl',buffer:binarySTL(mesh)}]});
  const parsed=expectType(parsing,'parsed');
  assert.equal(parsed.meshes[0].triangleCount,12);
  assert.equal(parsed.meshes[0].repair.removedDuplicateTriangles,1);
  assert.equal(parsed.meshes[0].repair.removedDegenerateTriangles,1);
  assert.equal(parsed.diagnostics[0].repair.changed,true);
  for(const stage of ['parsing','analyzing','repairing'])assert(parsing.progress.some(p=>p.stage===stage),stage);
  assert(parsing.progress.every(p=>p.fileName==='cleanup.stl'&&p.fileIndex===1&&p.fileCount===1));
  const planned=expectType(await job('plan',{meshes:parsed.meshes,options:{automatic:false,bed}}),'planned');
  assert.equal(planned.meshes[0].repair.changed,true);
  const exported=expectType(await job('export',{meshes:planned.meshes,plan:planned.plan}),'exported');
  assert.equal(decodeSLC(exported.buffer).layers.length,10);
  assert.equal(exported.recovery.recoveredPlanes,0);
});

test('unresolved holes retain the offending slice height in worker diagnostics',async()=>{
  const mesh=part();mesh.positions=Float64Array.from([...mesh.positions.slice(0,36),...mesh.positions.slice(45)]);
  const error=expectType(await job('slice',{meshes:[mesh],zMm:.05}),'error');
  assert.equal(error.code,'OPEN_CONTOUR');
  assert.equal(error.details.zMm,.05);
  assert.equal(error.details.degree,1);
  assert(!error.buffer);
});

test('manual XY survives planning and reaches SLC contours',async()=>{
 const {movePartXY}=await import('../dist/placement.js');
 const meshes=movePartXY([part(1)],'box',20,30,bed);
 const planned=expectType(await job('plan',{meshes,pack:false,options:{bed,baselineUm:100,preferredUm:150,supportEndMm:0,automatic:false}}),'planned');
 assert.equal(planned.meshes[0].bounds.min[0],20);assert.equal(planned.meshes[0].bounds.min[1],30);
 const exported=expectType(await job('export',{meshes:planned.meshes,plan:planned.plan}),'exported');
 for(const layer of decodeSLC(exported.buffer).layers){const pts=layer.rings.flat();assert.equal(Math.min(...pts.map(p=>p[0])),20);assert.equal(Math.max(...pts.map(p=>p[0])),22);assert.equal(Math.min(...pts.map(p=>p[1])),30);assert.equal(Math.max(...pts.map(p=>p[1])),33);}
});
