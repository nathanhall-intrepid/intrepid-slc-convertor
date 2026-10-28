import {transformMesh} from './engine.js';
import {validateLayout} from './layout.js';
/** Place a part by its minimum X/Y. Never rotate or ground its Z. */
export function movePartXY(meshes,id,x,y,bed){
  if(!Number.isFinite(x)||!Number.isFinite(y))throw new Error('Enter finite X and Y positions in millimetres.');
  const source=meshes.find(m=>m.id===id);if(!source)throw new Error('Select a part to move.');
  const moved=transformMesh(source,{translation:[x-source.bounds.min[0],y-source.bounds.min[1],0],ground:false});
  const result=meshes.map(m=>m.id===id?moved:m),check=validateLayout(result,bed);
  if(!check.valid)throw new Error(check.errors.join(' '));
  return result;
}
