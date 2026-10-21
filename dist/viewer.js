import * as THREE from './vendor/three.module.js';
import { OrbitControls } from './vendor/OrbitControls.js';

const PALETTE = [
  [50,[116,190,255]],
  [100,[205,219,214]],
  [150,[194,247,223]],
  [200,[255,196,117]],
];
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));

export function thicknessColor(thicknessUm) {
  const n=clamp(Number(thicknessUm)||100,50,200);
  let lo=PALETTE[0],hi=PALETTE.at(-1);
  for(let i=1;i<PALETTE.length;i++)if(n<=PALETTE[i][0]){lo=PALETTE[i-1];hi=PALETTE[i];break;}
  const t=(n-lo[0])/(hi[0]-lo[0]);
  return lo[1].map((v,i)=>Math.round(v+(hi[1][i]-v)*t));
}

/** CAD preview only. All STL/slice decisions remain in the geometry engine. */
export class BuildViewer {
  constructor(container,{onRangeSelect,onLayerSelect}={}) {
    this.container=container;this.onRangeSelect=onRangeSelect;this.onLayerSelect=onLayerSelect;
    this.meshes=[];this.plan=null;this.mode='side';this.bed={width:760,depth:660};
    this.selection=null;this.layerZ=null;this.disposed=false;this.failed=false;this.dirty=true;
    this.bounds=new THREE.Box3(new THREE.Vector3(0,0,0),new THREE.Vector3(20,20,30));
    this.container.style.position=this.container.style.position||'relative';
    this.status=document.createElement('div');this.status.setAttribute('role','alert');
    Object.assign(this.status.style,{display:'none',position:'absolute',inset:'20px',padding:'18px',border:'1px solid #3d6251',background:'#101b16',color:'#d8e9e0',font:'13px/1.6 system-ui,sans-serif',zIndex:'2'});
    this.container.appendChild(this.status);
    try {
      this.renderer=new THREE.WebGLRenderer({antialias:true,alpha:false,powerPreference:'high-performance'});
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,2));
      this.renderer.setClearColor('#080d0d',1);this.renderer.outputColorSpace=THREE.SRGBColorSpace;
      this.renderer.toneMapping=THREE.NoToneMapping;
      this.canvas=this.renderer.domElement;this.canvas.setAttribute('role','img');
      this.canvas.setAttribute('aria-label','Part geometry preview with layer-thickness colors. In side view, click to inspect a height or Shift-drag to select a height range.');
      Object.assign(this.canvas.style,{display:'block',width:'100%',height:'100%',touchAction:'none',outline:'none'});
      this.container.prepend(this.canvas);
      this.scene=new THREE.Scene();this.scene.background=new THREE.Color('#080d0d');
      this.meshGroup=new THREE.Group();this.scene.add(this.meshGroup);
      this.bedGroup=new THREE.Group();this.scene.add(this.bedGroup);
      this.helperGroup=new THREE.Group();this.scene.add(this.helperGroup);
      this.scene.add(new THREE.HemisphereLight('#edfdf5','#223c30',1.65));
      const key=new THREE.DirectionalLight('#f4fff9',2.1);key.position.set(-.8,-1.2,2.1);this.scene.add(key);
      const rim=new THREE.DirectionalLight('#85caa6',.7);rim.position.set(1,.9,.5);this.scene.add(rim);
      this.ortho=new THREE.OrthographicCamera(-20,20,20,-20,.01,10000);this.ortho.up.set(0,0,1);
      this.perspective=new THREE.PerspectiveCamera(38,1,.01,10000);this.perspective.up.set(0,0,1);
      this.camera=this.ortho;
      this.controls=new OrbitControls(this.camera,this.canvas);this.controls.enableDamping=true;this.controls.dampingFactor=.08;
      this.controls.enableRotate=false;this.controls.enabled=false;this.controls.screenSpacePanning=true;
      this.controls.addEventListener('change',()=>this.requestRender());
      this._uniforms={
        uBandMap:{value:this._emptyTexture()},uBandWidth:{value:1},uBandRows:{value:1},uHeightUm:{value:1},uHasPlan:{value:0},
        uHasSelection:{value:0},uSelectionStart:{value:0},uSelectionEnd:{value:0},uHasLayer:{value:0},uLayerZ:{value:0},uLayerWidth:{value:.02},
      };
      this.material=new THREE.MeshStandardMaterial({color:'#cddbd6',roughness:.68,metalness:.06,side:THREE.DoubleSide,flatShading:true});
      this.material.onBeforeCompile=shader=>{
        Object.assign(shader.uniforms,this._uniforms);
        shader.vertexShader=shader.vertexShader.replace('#include <common>','#include <common>\nvarying float vBuildZ;')
          .replace('#include <worldpos_vertex>','#include <worldpos_vertex>\nvBuildZ = (modelMatrix * vec4(transformed, 1.0)).z;');
        shader.fragmentShader=shader.fragmentShader.replace('#include <common>',`#include <common>
          varying float vBuildZ;
          uniform sampler2D uBandMap;
          uniform float uBandWidth; uniform float uBandRows; uniform float uHeightUm; uniform float uHasPlan;
          uniform float uHasSelection; uniform float uSelectionStart; uniform float uSelectionEnd;
          uniform float uHasLayer; uniform float uLayerZ; uniform float uLayerWidth;
        `).replace('#include <color_fragment>',`#include <color_fragment>
          if (uHasPlan > 0.5) {
            float idx = clamp(floor(vBuildZ * 1000.0), 0.0, max(0.0,uHeightUm-1.0));
            vec2 uvBand = vec2((mod(idx,uBandWidth)+0.5)/uBandWidth,(floor(idx/uBandWidth)+0.5)/uBandRows);
            diffuseColor.rgb = texture2D(uBandMap,uvBand).rgb;
          }
          if (uHasSelection > 0.5) {
            if (vBuildZ >= uSelectionStart && vBuildZ <= uSelectionEnd) diffuseColor.rgb = mix(diffuseColor.rgb,vec3(0.83,1.0,0.91),0.28);
            else diffuseColor.rgb *= 0.34;
          }
          if (uHasLayer > 0.5 && abs(vBuildZ-uLayerZ) < uLayerWidth) diffuseColor.rgb = vec3(1.0,0.78,0.45);
        `);
      };
      this.material.customProgramCacheKey=()=> 'layerlab-bands-v1';
      this._pointerDown=e=>this._handlePointerDown(e);this._pointerMove=e=>this._handlePointerMove(e);this._pointerUp=e=>this._handlePointerUp(e);
      this.canvas.addEventListener('pointerdown',this._pointerDown);this.canvas.addEventListener('pointermove',this._pointerMove);this.canvas.addEventListener('pointerup',this._pointerUp);this.canvas.addEventListener('pointercancel',this._pointerUp);
      this._wheel=e=>{if(this.mode==='3d')return;e.preventDefault();this.ortho.zoom=clamp(this.ortho.zoom*Math.exp(-e.deltaY*.001),.25,12);this.ortho.updateProjectionMatrix();this._uniforms.uLayerWidth.value=(this.ortho.top-this.ortho.bottom)/(Math.max(100,this.canvas.clientHeight)*this.ortho.zoom)*.65;this.requestRender();};
      this.canvas.addEventListener('wheel',this._wheel,{passive:false});
      this._contextLost=e=>{e.preventDefault();this._showError('The graphics preview lost its WebGL context. Reload this page to restore the preview. Your source STL is not modified.');};
      this.canvas.addEventListener('webglcontextlost',this._contextLost);
      this._onResize=()=>this.resize();
      if(typeof ResizeObserver!=='undefined'){this.resizeObserver=new ResizeObserver(this._onResize);this.resizeObserver.observe(container);}else window.addEventListener('resize',this._onResize);
      this.setBed(760,660);this.resize();
      this._frame=()=>{if(this.disposed)return;this.frameId=requestAnimationFrame(this._frame);if(this.controls.enabled&&this.controls.update())this.dirty=true;if(this.dirty){this.renderer.render(this.scene,this.camera);this.dirty=false;}};
      this.frameId=requestAnimationFrame(this._frame);
    } catch(error) {
      this.failed=true;this._showError(`3D preview is unavailable on this browser. Enable WebGL or try another browser. File analysis and SLC planning remain available. ${error.message||''}`);
    }
  }

  _showError(message){this.status.textContent=message;this.status.style.display='block';}
  _emptyTexture(){const t=new THREE.DataTexture(new Uint8Array([205,219,214,255]),1,1,THREE.RGBAFormat);t.colorSpace=THREE.SRGBColorSpace;t.needsUpdate=true;return t;}
  requestRender(){this.dirty=true;}

  setMeshes(meshes){
    this.meshes=Array.isArray(meshes)?meshes:[];if(this.failed)return;
    for(const object of [...this.meshGroup.children]){this.meshGroup.remove(object);object.geometry?.dispose();if(object.material!==this.material)object.material?.dispose();}
    const allBounds=new THREE.Box3(),triangles=this.meshes.reduce((n,m)=>n+m.positions.length/9,0);
    for(const source of this.meshes){
      if(!source.positions?.length)continue;
      const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(source.positions,3));geometry.computeVertexNormals();geometry.computeBoundingBox();
      const mesh=new THREE.Mesh(geometry,this.material);mesh.name=source.name||'Part';this.meshGroup.add(mesh);allBounds.union(geometry.boundingBox);
      if(triangles<=120000){const edgeGeometry=new THREE.EdgesGeometry(geometry,28),edges=new THREE.LineSegments(edgeGeometry,new THREE.LineBasicMaterial({color:'#406955',transparent:true,opacity:.22}));edges.renderOrder=1;this.meshGroup.add(edges);}
    }
    if(!allBounds.isEmpty())this.bounds=allBounds;
    this._fitCamera();this._updateHelpers();this.requestRender();
  }

  setPlan(plan){
    this.plan=plan||null;if(this.failed)return;
    if(!plan?.layers?.length){this._uniforms.uHasPlan.value=0;this.requestRender();return;}
    const heightUm=Math.max(1,Math.round((plan.heightMm??plan.layers.at(-1).zMm)*1000)),maxSize=this.renderer.capabilities.maxTextureSize,width=Math.min(2048,maxSize),rows=Math.ceil(heightUm/width);
    if(rows>maxSize){this._uniforms.uHasPlan.value=0;this._showError('The build height exceeds this device’s layer-color texture capacity. Geometry remains visible.');return;}
    const data=new Uint8Array(width*rows*4);let previous=0;
    for(const layer of plan.layers){
      const start=clamp(Math.round((layer.zStartMm??previous)*1000),0,heightUm),end=clamp(Math.round(layer.zMm*1000),start,heightUm),rgb=thicknessColor(layer.thicknessUm);
      for(let i=start*4;i<end*4;i+=4){data[i]=rgb[0];data[i+1]=rgb[1];data[i+2]=rgb[2];data[i+3]=255;}
      previous=layer.zMm;
    }
    const texture=new THREE.DataTexture(data,width,rows,THREE.RGBAFormat);texture.colorSpace=THREE.SRGBColorSpace;texture.minFilter=THREE.NearestFilter;texture.magFilter=THREE.NearestFilter;texture.generateMipmaps=false;texture.needsUpdate=true;
    this._uniforms.uBandMap.value.dispose();this._uniforms.uBandMap.value=texture;this._uniforms.uBandWidth.value=width;this._uniforms.uBandRows.value=rows;this._uniforms.uHeightUm.value=heightUm;this._uniforms.uHasPlan.value=1;
    this._updateHelpers();this.requestRender();
  }

  setView(view){
    if(!['side','3d','plate'].includes(view))throw new Error('Unknown preview view.');this.mode=view;if(this.failed)return;
    this.camera=view==='3d'?this.perspective:this.ortho;
    // Recreate controls so a residual damped orbit cannot tilt an orthographic
    // side view after switching from 3D.
    this.controls.dispose();this.controls=new OrbitControls(this.camera,this.canvas);this.controls.enableDamping=true;this.controls.dampingFactor=.08;this.controls.screenSpacePanning=true;
    this.controls.addEventListener('change',()=>this.requestRender());this.controls.enabled=view==='3d';this.controls.enableRotate=view==='3d';this.controls.enablePan=view==='3d';this.controls.enableZoom=view==='3d';
    this.canvas.style.cursor=view==='side'?'crosshair':view==='3d'?'grab':'default';this._fitCamera();this._updateHelpers();this.requestRender();
  }

  setSelection(fromMm,toMm){
    if(Number.isFinite(fromMm)&&Number.isFinite(toMm)&&toMm>fromMm)this.selection={fromMm:Math.max(0,fromMm),toMm};else this.selection=null;
    if(this.failed)return;this._uniforms.uHasSelection.value=this.selection?1:0;if(this.selection){this._uniforms.uSelectionStart.value=this.selection.fromMm;this._uniforms.uSelectionEnd.value=this.selection.toMm;}
    this._updateHelpers();this.requestRender();
  }

  setLayer(zMm){
    this.layerZ=Number.isFinite(zMm)?zMm:null;if(this.failed)return;this._uniforms.uHasLayer.value=this.layerZ===null?0:1;if(this.layerZ!==null)this._uniforms.uLayerZ.value=this.layerZ;
    this._updateHelpers();this.requestRender();
  }

  setBed(width,depth){
    if(!Number.isFinite(width)||!Number.isFinite(depth)||width<=0||depth<=0)return;
    this.bed={width,depth};if(this.failed)return;
    for(const o of [...this.bedGroup.children]){this.bedGroup.remove(o);o.geometry?.dispose();o.material?.dispose();}
    const plate=new THREE.Mesh(new THREE.PlaneGeometry(width,depth),new THREE.MeshBasicMaterial({color:'#0c1511',side:THREE.DoubleSide}));plate.position.set(width/2,depth/2,-.025);this.bedGroup.add(plate);
    const target=Math.min(width,depth)/14,power=10**Math.floor(Math.log10(target)),step=([1,2,5,10].find(n=>n*power>=target)||10)*power,grid=[];
    for(let x=0;x<=width+1e-8;x+=step)grid.push(x,0,-.012,x,depth,-.012);
    for(let y=0;y<=depth+1e-8;y+=step)grid.push(0,y,-.012,width,y,-.012);
    const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(grid,3));this.bedGroup.add(new THREE.LineSegments(g,new THREE.LineBasicMaterial({color:'#284437',transparent:true,opacity:.55})));
    const border=new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0,0,0),new THREE.Vector3(width,0,0),new THREE.Vector3(width,depth,0),new THREE.Vector3(0,depth,0),new THREE.Vector3(0,0,0)]);
    this.bedGroup.add(new THREE.Line(border,new THREE.LineBasicMaterial({color:'#547461',transparent:true,opacity:.75})));
    if(this.mode==='plate')this._fitCamera();this.requestRender();
  }

  _fitCamera(){
    if(this.failed||!this.camera)return;
    const rect=this.container.getBoundingClientRect(),aspect=Math.max(1,rect.width)/Math.max(1,rect.height),center=this.bounds.getCenter(new THREE.Vector3()),size=this.bounds.getSize(new THREE.Vector3()),span=Math.max(1,size.x,size.y,size.z);
    if(this.mode==='3d'){
      const radius=Math.max(1,size.length()/2),dist=radius/Math.sin(THREE.MathUtils.degToRad(this.perspective.fov/2))*1.15;
      this.camera.up.set(0,0,1);this.camera.position.set(center.x+dist*.72,center.y-dist*.9,center.z+dist*.62);this.camera.near=Math.max(.01,dist/10000);this.camera.far=dist*10+Math.max(this.bed.width,this.bed.depth)*4;this.camera.aspect=aspect;
      this.camera.lookAt(center);this.controls.target.copy(center);this.controls.minDistance=radius*.35;this.controls.maxDistance=dist*8;
    }else{
      let width,height,target;
      if(this.mode==='plate'){
        const x0=Math.min(0,this.bounds.min.x),x1=Math.max(this.bed.width,this.bounds.max.x),y0=Math.min(0,this.bounds.min.y),y1=Math.max(this.bed.depth,this.bounds.max.y);
        width=Math.max(1,x1-x0)*1.13;height=Math.max(1,y1-y0)*1.13;target=new THREE.Vector3((x0+x1)/2,(y0+y1)/2,0);this.camera.up.set(0,1,0);this.camera.position.set(target.x,target.y,Math.max(span,this.bed.width,this.bed.depth)*3);this.camera.lookAt(target);
      }else{
        width=Math.max(size.x,span*.15,1)*1.3;height=Math.max(size.z,span*.15,1)*1.25;target=new THREE.Vector3(center.x,center.y,Math.max(0,this.bounds.min.z)+size.z/2);this.camera.up.set(0,0,1);this.camera.position.set(target.x,target.y-span*3,target.z);this.camera.lookAt(target);
      }
      if(width/height>aspect)height=width/aspect;else width=height*aspect;
      this.camera.left=-width/2;this.camera.right=width/2;this.camera.top=height/2;this.camera.bottom=-height/2;this.camera.zoom=1;this.camera.near=.01;this.camera.far=Math.max(span,this.bed.width,this.bed.depth)*12+100;this.controls.target.copy(target);
      this._uniforms.uLayerWidth.value=height/Math.max(100,rect.height)*.65;
    }
    this.camera.updateProjectionMatrix();this.controls.update();this.requestRender();
  }

  _updateHelpers(){
    if(this.failed||!this.helperGroup)return;
    for(const o of [...this.helperGroup.children]){this.helperGroup.remove(o);o.geometry?.dispose();o.material?.dispose();}
    const b=this.bounds,size=b.getSize(new THREE.Vector3()),margin=Math.max(size.x*.06,.5),xmin=b.min.x-margin,xmax=b.max.x+margin,y=b.min.y-Math.max(size.y*.02,.05);
    const line=(z,color,opacity=1)=>{
      const points=this.mode==='side'?[new THREE.Vector3(xmin,y,z),new THREE.Vector3(xmax,y,z)]:[new THREE.Vector3(xmin,b.min.y-margin,z),new THREE.Vector3(xmax,b.min.y-margin,z),new THREE.Vector3(xmax,b.max.y+margin,z),new THREE.Vector3(xmin,b.max.y+margin,z),new THREE.Vector3(xmin,b.min.y-margin,z)];
      const geo=new THREE.BufferGeometry().setFromPoints(points),mat=new THREE.LineBasicMaterial({color,transparent:true,opacity,depthTest:false}),obj=new THREE.Line(geo,mat);obj.renderOrder=10;this.helperGroup.add(obj);
    };
    if(this.selection){line(this.selection.fromMm,'#c2f7df',.9);line(this.selection.toMm,'#c2f7df',.9);}
    if(this.layerZ!==null)line(this.layerZ,'#ffc475',.85);
    this.helperGroup.visible=this.mode!=='plate';
  }

  _heightAt(event){
    const rect=this.canvas.getBoundingClientRect(),pointer=new THREE.Vector2((event.clientX-rect.left)/rect.width*2-1,-(event.clientY-rect.top)/rect.height*2+1),ray=new THREE.Raycaster();ray.setFromCamera(pointer,this.camera);
    const center=this.bounds.getCenter(new THREE.Vector3()),plane=new THREE.Plane(new THREE.Vector3(0,1,0),-center.y),hit=ray.ray.intersectPlane(plane,new THREE.Vector3());
    return hit?clamp(hit.z,0,this.plan?.heightMm??this.bounds.max.z):null;
  }
  /** Optional overlay helper: exact projected vertical coordinate in CSS px. */
  heightToScreen(zMm){
    if(this.failed||!Number.isFinite(zMm))return null;const center=this.bounds.getCenter(new THREE.Vector3()),point=new THREE.Vector3(center.x,center.y,zMm).project(this.camera);return (1-point.y)*this.canvas.clientHeight/2;
  }
  _handlePointerDown(event){
    if(this.mode!=='side'||event.button!==0)return;const z=this._heightAt(event);if(z===null)return;
    if(event.shiftKey){event.preventDefault();event.stopPropagation();this.drag={start:z,current:z};this.canvas.setPointerCapture(event.pointerId);}
    else{this.setLayer(z);this.onLayerSelect?.(z);}
  }
  _handlePointerMove(event){if(!this.drag)return;const z=this._heightAt(event);if(z===null)return;this.drag.current=z;this.setSelection(Math.min(z,this.drag.start),Math.max(z,this.drag.start));}
  _handlePointerUp(event){if(!this.drag)return;const {start,current}=this.drag;this.drag=null;try{this.canvas.releasePointerCapture(event.pointerId);}catch{}const lo=Math.round(Math.min(start,current)*20)/20,hi=Math.round(Math.max(start,current)*20)/20;if(hi-lo>=.05){this.setSelection(lo,hi);this.onRangeSelect?.(lo,hi);}else this.setSelection(null,null);}

  resize(){
    if(this.failed||!this.renderer)return;const rect=this.container.getBoundingClientRect();if(rect.width<1||rect.height<1)return;
    this.renderer.setSize(Math.round(rect.width),Math.round(rect.height),false);this._fitCamera();this.requestRender();
  }

  destroy(){
    this.disposed=true;cancelAnimationFrame(this.frameId);this.resizeObserver?.disconnect();window.removeEventListener('resize',this._onResize);
    if(this.canvas){this.canvas.removeEventListener('pointerdown',this._pointerDown);this.canvas.removeEventListener('pointermove',this._pointerMove);this.canvas.removeEventListener('pointerup',this._pointerUp);this.canvas.removeEventListener('pointercancel',this._pointerUp);this.canvas.removeEventListener('wheel',this._wheel);this.canvas.removeEventListener('webglcontextlost',this._contextLost);}
    this.controls?.dispose();if(this.scene)this.scene.traverse(o=>{o.geometry?.dispose();if(o.material&&o.material!==this.material)o.material.dispose();});
    this._uniforms?.uBandMap.value.dispose();this.material?.dispose();this.renderer?.dispose();this.canvas?.remove();this.status?.remove();
  }
}
