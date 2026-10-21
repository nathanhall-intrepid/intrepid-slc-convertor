import {computeBounds,createBoxMesh,planLayers,sliceBuild} from '../dist/engine.js';

function denseShell(steps){
  const outer=createBoxMesh(40,40,60),p=new Float64Array(outer.positions.length+(steps*8+4)*9);p.set(outer.positions);let offset=outer.positions.length;
  const level=i=>{const z=5+50*i/steps,r=4+(i%2)*.03;return [[20-r,20-r,z],[20+r,20-r,z],[20+r,20+r,z],[20-r,20+r,z]];};
  // Reversed inner component is a closed cavity, with dense sloped facets inside
  // the stable exterior. This exercises the same Z-event load as internal lattice.
  const tri=(a,b,c)=>{p.set([...a,...c,...b],offset);offset+=9;};
  const bottom=level(0),top=level(steps);tri(bottom[0],bottom[2],bottom[1]);tri(bottom[0],bottom[3],bottom[2]);
  for(let i=0;i<steps;i++){const low=level(i),high=level(i+1);for(let k=0;k<4;k++){const next=(k+1)%4;tri(low[k],low[next],high[next]);tri(low[k],high[next],high[k]);}}
  tri(top[0],top[1],top[2]);tri(top[0],top[2],top[3]);
  return {name:'Dense cavity benchmark.stl',positions:p,triangleCount:p.length/9,bounds:computeBounds(p)};
}
for(const steps of [12500,60000]){
  const mesh=denseShell(steps),start=performance.now(),plan=planLayers([mesh],{supportEndMm:0});
  const planningMs=performance.now()-start;
  if(plan.layers.length!==400||plan.layers.some(l=>l.reason!=='vertical'))throw new Error('Dense internal geometry altered the vertical schedule.');
  const output={triangles:mesh.triangleCount,planningMs:Math.round(planningMs),layers:plan.layers.length,classificationSamples:plan.classificationSamples};
  if(steps===12500){const begin=performance.now(),build=sliceBuild([mesh],plan);output.slicingAndValidationMs=Math.round(performance.now()-begin);output.outputVertices=build.contourVertexCount;}
  console.log(JSON.stringify(output));
}
