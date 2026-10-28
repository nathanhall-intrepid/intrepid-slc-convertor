import {BuildViewer} from './viewer.js?v=20261028.1';
import {LayerCallouts} from './callouts.js?v=20261028.1';
import {transformMesh} from './engine.js?v=20261028.1';
import {DEMO_PROFILE,validateProfile,validateCycle,compareTimes,exposureSeconds,formatDuration} from './process.js';

const $=id=>document.getElementById(id), $$=s=>[...document.querySelectorAll(s)];
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const mm=v=>Number(v).toFixed(3).replace(/0+$/,'').replace(/\.$/,'');
const val=id=>Number($(id).value), optional=id=>$(id).value===''?null:val(id);
const state={sources:[],meshes:[],diagnostics:[],plan:null,placements:[],layout:null,overrides:[],view:'side',busy:false,job:null,readJob:null,seq:0,range:[25,35],profiles:[],profileId:'uncalibrated',profileDemo:false,importedSettings:false,demo:true,slice:null,selectedLayer:0,warnings:[],exportReport:null};
let viewer, toastTimer, sliceTimer;
try{viewer=new BuildViewer($('viewer'),{onRangeSelect:(a,b)=>setRange(a,b),onLayerSelect:z=>{if(state.plan){const i=state.plan.layers.findIndex(l=>l.zMm>=z);$('layerSlider').value=Math.max(0,i);inspectLayer();}}});}catch(e){$('viewer').textContent='3D preview is unavailable. Slice preview and file conversion are still available.';viewer=new Proxy({},{get:()=>()=>{}});}
const callouts=new LayerCallouts(viewer,{container:$('viewer'),onSelect:({fromMm,toMm,thicknessUm})=>{setRange(fromMm,toMm);$('manualUm').value=thicknessUm;}});

const isLight=()=>document.documentElement.dataset.theme==='light';
function applyTheme(){const light=isLight();viewer.setTheme(light?'light':'dark');$('themeButton').textContent=light?'Dark mode':'Light mode';$('themeButton').setAttribute('aria-pressed',String(light));$('themeButton').setAttribute('aria-label',light?'Switch to dark mode':'Switch to light mode');document.querySelector('meta[name="theme-color"]').content=light?'#e2ece2':'#000000';}
applyTheme();
$('themeButton').onclick=()=>{document.documentElement.dataset.theme=isLight()?'dark':'light';try{localStorage.setItem('intrepid-theme',document.documentElement.dataset.theme);}catch{}applyTheme();drawSlice();renderTime();};

function toast(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,5000);}
function showError(e){
  const detail=e?.details||{},context=[];
  if(detail.fileName)context.push(String(detail.fileName));
  if(Number.isFinite(detail.zMm))context.push(`At Z ${mm(detail.zMm)} mm`);
  else if(Number.isFinite(detail.zStartMm)&&Number.isFinite(detail.zEndMm))context.push(`Z ${mm(detail.zStartMm)}–${mm(detail.zEndMm)} mm`);
  const message=e?.message||String(e);
  $('errorBox').textContent=[message,context.join(' · '),e?.code?`Diagnostic: ${e.code}`:''].filter(Boolean).join('\n');
  $('errorBox').hidden=false;$('statusText').textContent='Operation stopped. Review the diagnostic below.';
}
function clearError(){$('errorBox').hidden=true;$('errorBox').textContent='';}
function updateButtons(){for(const id of ['planButton','demoButton','applyBandButton'])$(id).disabled=state.busy||(!state.sources.length&&id!=='demoButton');$('exportButton').disabled=state.busy||!state.plan||Boolean(state.slcError);$('recipeButton').disabled=state.busy||!state.plan;$('scheduleButton').disabled=!state.plan;$('layerSlider').disabled=!state.plan||state.busy;$('cancelButton').hidden=!state.busy;$('stlFiles').disabled=state.busy;$('recipeFile').disabled=state.busy;$('importRecipeButton').disabled=state.busy;$('dropzone').setAttribute('aria-disabled',String(state.busy));$$('.part-actions button,.remove-part,.band-row button').forEach(b=>b.disabled=state.busy);for(const id of ['unitScale','bedWidth','bedDepth','partGap','bedMargin','preferredUm','angleTolerance','autoMode','supportEnd','supportSlider'])$(id).disabled=state.busy;}
function setBusy(b){state.busy=b;$('jobProgress').hidden=!b;$('operationPanel').hidden=!b;$('planStatus').setAttribute('aria-live',b?'off':'polite');document.querySelector('.workspace').setAttribute('aria-busy',String(b));if(!b){$('operationProgress').removeAttribute('value');$('jobProgress').removeAttribute('value');$('operationAmount').textContent='';$('operationDetails').textContent='';}updateButtons();}
const CANCEL_MESSAGE='Operation cancelled.';
const cancelledError=()=>Object.assign(new Error(CANCEL_MESSAGE),{code:'CANCELLED'});
const stageNames={reading:'Reading STL files',parsing:'Parsing STL geometry',analyzing:'Checking mesh topology',repairing:'Repairing mesh geometry',layout:'Arranging the build',planning:'Scanning exterior surfaces',slicing:'Slicing layer contours',encoding:'Writing the SLC file',verifying:'Verifying the SLC file',preparing:'Preparing geometry',rendering:'Preparing the preview'};
const operationNames={parse:'Import STL',demo:'Load demonstration',plan:'Optimize build',slice:'Inspect layer',export:'Export SLC'};
function byteSize(value){if(value<1024)return `${Math.round(value)} B`;if(value<1024*1024)return `${(value/1024).toFixed(1)} KB`;return `${(value/(1024*1024)).toFixed(1)} MB`;}
function reportProgress(data={}){
  const stage=String(data.stage||'preparing'),label=stageNames[stage]||stage.replace(/[-_]/g,' ');
  const current=data.current,total=data.total,hasCounts=Number.isFinite(current)&&Number.isFinite(total)&&current>=0&&total>0;
  const percent=data.percent===null?null:hasCounts?Math.max(0,Math.min(100,current/total*100)):Number.isFinite(data.percent)?Math.max(0,Math.min(100,data.percent)):null;
  const unit=data.unit||({reading:'bytes',parsing:'files',planning:'µm',slicing:'layers'}[stage]||'');
  let amount='';
  if(hasCounts){if(unit==='bytes')amount=`${byteSize(current)} / ${byteSize(total)}`;else if(unit==='µm'||unit==='um')amount=`${mm(current/1000)} / ${mm(total/1000)} mm`;else amount=`${current.toLocaleString()} / ${total.toLocaleString()}${unit?' '+unit:''}`;}
  if(percent!==null)amount+=(amount?' · ':'')+`${Math.round(percent)}% of stage`;
  else amount+=(amount?' · ':'')+'Working…';
  const fileName=data.fileName||data.details?.fileName;
  const fileNumber=Number.isFinite(data.fileIndex)&&Number.isFinite(data.fileCount)?`File ${data.fileIndex} of ${data.fileCount}`:'';
  const details=[fileNumber,fileName,data.message].filter(Boolean).map(String).join(' · ');
  const stageText=label+(fileNumber?' · '+fileNumber:'');if($('operationStage').textContent!==stageText)$('operationStage').textContent=stageText;$('operationAmount').textContent=amount;
  $('operationDetails').textContent=details||(percent===null?'This stage has no measured total yet. You can cancel at any time.':'Progress is for the current stage; the next stage starts a new count.');
  for(const id of ['operationProgress','jobProgress']){if(percent===null)$(id).removeAttribute('value');else $(id).value=percent;$(id).setAttribute('aria-valuetext',`${label}: ${amount}`);}
  $('statusText').textContent=`${label}${amount?' · '+amount:''}`;
}
function cancelJob(silent=false){
  const reading=state.readJob;
  if(reading){reading.cancelled=true;state.readJob=null;reading.reader?.abort();reading.reject?.(cancelledError());}
  state.job?.cancel();setBusy(false);
  if(!silent){$('statusText').textContent='Operation cancelled. Your input geometry is unchanged.';toast('Operation cancelled.');}
}
function rpc(type,payload={}){
  if(state.busy)return Promise.reject(new Error('Another operation is still running. Cancel it before starting a new one.'));
  $('operationTitle').textContent=operationNames[type]||'Process build';setBusy(true);clearError();
  reportProgress({stage:type==='parse'?'parsing':type==='plan'?'analyzing':type==='export'?'slicing':'preparing'});
  return new Promise((resolve,reject)=>{
    const id=++state.seq;let worker,finished=false;
    function finish(error,data){if(finished)return;finished=true;worker?.terminate();if(state.seq===id){state.job=null;setBusy(false);}error?reject(error):resolve(data);}
    try{
      worker=new Worker(new URL('./worker.js?v=20261028.1',import.meta.url),{type:'module'});state.job={id,worker,cancel:()=>finish(cancelledError())};
      worker.onmessage=({data})=>{if(finished||data.id!==id||state.job?.id!==id)return;if(data.type==='progress'){reportProgress(data);return;}const error=data.type==='error'?Object.assign(new Error(data.message),{code:data.code,details:data.details}):null;finish(error,data);};
      worker.onerror=e=>finish(new Error(e.message||'The geometry worker could not start. Reload the app and try again.'));
      worker.onmessageerror=()=>finish(new Error('The geometry worker returned unreadable data. Retry with a smaller file or reload the app.'));
      worker.postMessage({id,type,...payload},type==='parse'?payload.files.map(f=>f.buffer):[]);
    }catch(e){finish(e);}
  });
}
async function readSTLFiles(files,unitScale){
  const job={id:++state.seq,reader:null,reject:null,cancelled:false};state.readJob=job;
  const total=files.reduce((sum,file)=>sum+file.size,0);let completed=0;
  $('operationTitle').textContent='Import STL';setBusy(true);clearError();reportProgress({stage:'reading',current:0,total,unit:'bytes',fileIndex:1,fileCount:files.length,fileName:files[0].name});
  try{
    // Let the newly visible progress panel paint before starting file I/O.
    await new Promise(resolve=>requestAnimationFrame(()=>setTimeout(resolve,0)));
    const result=[];
    for(let i=0;i<files.length;i++){
      if(job.cancelled)throw cancelledError();
      const file=files[i],context={stage:'reading',total,unit:'bytes',fileIndex:i+1,fileCount:files.length,fileName:file.name};
      reportProgress({...context,current:completed});
      const buffer=await new Promise((resolve,reject)=>{
        const reader=new FileReader();job.reader=reader;job.reject=reject;
        reader.onprogress=event=>{if(state.readJob===job&&!job.cancelled)reportProgress({...context,current:completed+Math.min(file.size,event.loaded)});};
        reader.onload=()=>job.cancelled?reject(cancelledError()):resolve(reader.result);
        reader.onerror=()=>reject(new Error(`Could not read ${file.name}. Confirm that the file is available locally and try again.`));
        reader.onabort=()=>reject(cancelledError());
        reader.readAsArrayBuffer(file);
      });
      job.reader=null;job.reject=null;if(job.cancelled)throw cancelledError();completed+=file.size;
      result.push({name:file.name,id:crypto.randomUUID(),unitScale,buffer});reportProgress({...context,current:completed});
    }
    return result;
  }finally{if(state.readJob===job){state.readJob=null;setBusy(false);}}
}
function cleanMesh(m){return {id:m.id,name:m.name,positions:m.positions,triangleCount:m.triangleCount,bounds:m.bounds,format:m.format,unitScale:m.unitScale,repair:m.repair,repairReport:m.repairReport};}
function bedSettings(){return {width:val('bedWidth'),depth:val('bedDepth'),gap:val('partGap'),margin:val('bedMargin'),allowRotate:true};}
function planOptions(){return {baselineUm:100,preferredUm:val('preferredUm'),supportEndMm:val('supportEnd'),verticalToleranceDeg:val('angleTolerance'),automatic:$('autoMode').checked,overrides:state.overrides.map(o=>({...o})),bed:bedSettings()};}
function height(){return state.plan?.heightMm||Math.max(0,...state.sources.map(m=>m.bounds.size[2]));}
function invalidate(message='Settings changed. Scan again to update the plan.'){if(state.job||state.readJob)cancelJob(true);state.plan=null;state.slcError=null;state.slice=null;state.exportReport=null;viewer.setPlan(null);drawSlice();inspectLayer();clearError();$('statusText').textContent=message;renderPlan();updateButtons();}
function thicknessColor(h){const colors=[[50,[127,190,255]],[100,[213,225,219]],[150,[166,231,197]],[200,[227,183,130]]];const i=Math.min(2,Math.floor((h-50)/50));const t=(h-colors[i][0])/50;return `rgb(${colors[i][1].map((c,k)=>Math.round(c+(colors[i+1][1][k]-c)*t)).join(',')})`;}
function reasonLabel(reason){return {support:'User-defined supports',vertical:'Vertical exterior wall',standard:'Slope / standard detail',manual:'Manual override'}[reason]||reason;}

async function loadDemo(){if(state.busy)return;try{const r=await rpc('demo');state.sources=r.meshes.map((m,i)=>({...cleanMesh(m),id:m.id||`demo-${i}`}));state.diagnostics=r.diagnostics||[];state.overrides=[];state.importedSettings=false;state.demo=true;state.range=[25,35];renderParts();renderBands();setRange(25,35);await scan();}catch(e){if(e.message!=='Operation cancelled.')showError(e);}}
async function loadFiles(files){
  const list=[...files];if(!list.length)return;if(state.busy){toast('An operation is running. Cancel it before adding another file.');return;}
  try{
    if(list.some(f=>!f.name.toLowerCase().endsWith('.stl')))throw new Error('Choose STL files. Both binary and ASCII STL are supported.');
    if(list.length+(state.demo?0:state.sources.length)>32)throw new Error('A build can contain up to 32 parts. Remove a part before importing more.');
    if(list.reduce((s,f)=>s+f.size,0)>200*1024*1024)throw new Error('Selected files exceed the 200 MB import limit.');
    const input=await readSTLFiles(list,val('unitScale'));
    const parsed=await rpc('parse',{files:input});
    if(state.demo){state.sources=[];state.diagnostics=[];if(!state.importedSettings)state.overrides=[];}
    state.demo=false;state.importedSettings=false;state.sources.push(...parsed.meshes.map(cleanMesh));state.diagnostics.push(...(parsed.diagnostics||[]));state.meshes=state.sources;
    invalidate('STL loaded. Scan to arrange parts and generate the layer plan.');viewer.setMeshes(state.meshes);viewer.setBed(val('bedWidth'),val('bedDepth'));renderParts();renderBands();syncHeight();setRange(0,Math.min(10,height()));
    const repaired=(parsed.diagnostics||[]).filter(d=>d.repair?.changed||d.repairReport?.changed).length;
    if(repaired)toast(`STL loaded. Mesh cleanup applied to ${repaired} part${repaired===1?'':'s'}; see Geometry checks for the report.`);
  }catch(e){if(e.message!==CANCEL_MESSAGE)showError(e);}finally{$('stlFiles').value='';}
}
function repairSummary(diagnostic){
  const repair=diagnostic?.repair||diagnostic?.repairReport;if(!repair)return '';
  if(typeof repair.summary==='string'&&repair.summary)return repair.summary;
  const changes=[];
  for(const [key,label] of [['weldedVertices','vertices welded'],['removedDegenerateTriangles','degenerate triangles removed'],['removedDuplicateTriangles','duplicate triangles removed'],['reorientedTriangles','triangles reoriented']])if(Number.isFinite(repair[key])&&repair[key]>0)changes.push(`${repair[key].toLocaleString()} ${label}`);
  if(!changes.length&&Array.isArray(repair.actions))changes.push(...repair.actions.filter(action=>typeof action==='string'));
  return changes.length?changes.join(' · '):repair.changed?'Mesh cleanup applied; inspect the geometry checks.':'';
}
function renderParts(){$('partsList').innerHTML=state.sources.map((m,i)=>{const d=state.diagnostics.find(d=>d.id===m.id)||{},repair=d.repair||d.repairReport||m.repair||m.repairReport,summary=repairSummary({repair});return `<div class="part-row"><strong title="${esc(m.name)}">${esc(m.name)}</strong><button class="remove-part" data-remove="${i}" aria-label="Remove ${esc(m.name)}">×</button><small>${m.bounds.size.map(x=>mm(x)).join(' × ')} mm · ${m.triangleCount.toLocaleString()} triangles</small><span class="mesh-valid ${d.watertight===false||d.consistentWinding===false?'mesh-invalid':''}">${d.watertight===false?'OPEN MESH':d.consistentWinding===false?'CHECK WINDING':repair?.changed?'MESH CLEANED':'MESH LOADED'}</span>${summary?`<span class="mesh-repair-note">${esc(summary)}</span>`:''}<div class="part-actions"><button data-rotate="${i}:0" title="Rotate 90 degrees about X">X ↻</button><button data-rotate="${i}:1" title="Rotate 90 degrees about Y">Y ↻</button><button data-rotate="${i}:2" title="Rotate 90 degrees about Z">Z ↻</button><button data-copy="${i}" aria-label="Duplicate ${esc(m.name)}">Duplicate</button></div></div>`;}).join('');$('meshSummary').textContent=`${state.sources.length} part${state.sources.length===1?'':'s'} · ${state.sources.reduce((s,m)=>s+m.triangleCount,0).toLocaleString()} triangles${state.demo?' · DEMO GEOMETRY':''}`;$('buildName').textContent=state.sources.length===1?state.sources[0].name:state.sources.length?`${state.sources.length} parts in build`:'No geometry loaded';$('emptyView').hidden=Boolean(state.sources.length);updateButtons();}
function syncHeight(){const h=height();$('supportSlider').max=Math.max(.05,h);$('railTop').textContent=`${mm(h)} mm`;$('heightRail').setAttribute('aria-valuemax',h);$('rangeFrom').max=h;$('rangeTo').max=h;setRange(Math.min(state.range[0],h),Math.min(state.range[1],h));}
async function scan(){if(state.busy)return;try{if(!state.sources.length)return;const options=planOptions();const result=await rpc('plan',{meshes:state.sources.map(cleanMesh),options,pack:true});state.meshes=result.meshes;state.plan=result.plan;if(Array.isArray(result.diagnostics))state.diagnostics=result.diagnostics;state.exportReport=null;renderParts();state.placements=result.placements||[];state.layout=result.layout;state.warnings=result.warnings||[];state.slcError=result.plan.exportable===false?(result.plan.exportWarning||'This plan exceeds the SLC sampling-table limit. Simplify the height schedule.'):null;state.slice=null;viewer.setBed(options.bed.width,options.bed.depth);viewer.setMeshes(state.meshes);viewer.setPlan(state.plan);viewer.setView(state.view==='slice'?'side':state.view);syncHeight();renderPlan();$('statusText').textContent=`Plan ready · ${state.plan.layers.length.toLocaleString()} layers · ${mm(state.plan.heightMm)} mm build height${state.layout?` · ${(state.layout.utilization*100).toFixed(1)}% bed footprint`:''}`;updateButtons();inspectLayer();}catch(e){state.plan=null;state.slice=null;viewer.setPlan(null);drawSlice();inspectLayer();renderPlan();updateButtons();if(e.message!=='Operation cancelled.')showError(e);}}
function runs(){if(!state.plan)return [];const out=[];for(const l of state.plan.layers){const p=out.at(-1);if(p&&p.thicknessUm===l.thicknessUm&&p.reason===l.reason&&p.adjusted===l.adjusted){p.to=l.zMm;p.count++;}else out.push({from:l.zStartMm??l.zMm-l.thicknessUm/1000,to:l.zMm,thicknessUm:l.thicknessUm,reason:l.reason,adjusted:l.adjusted,count:1});}return out;}
function renderPlan(){callouts.setPlan(state.plan);const p=state.plan,r=runs();$('scheduleStrip').innerHTML=p?r.map((g,i)=>`<button data-run="${i}" style="width:${100*(g.to-g.from)/p.heightMm}%;background:${thicknessColor(g.thicknessUm)}" title="${mm(g.from)}–${mm(g.to)} mm · ${g.thicknessUm} µm · ${esc(reasonLabel(g.reason))}" aria-label="${mm(g.from)} to ${mm(g.to)} mm, ${g.thicknessUm} microns, ${esc(reasonLabel(g.reason))}"></button>`).join(''):'';$('stripHeight').textContent=p?`${mm(p.heightMm)} mm`:'— mm';const featured=r.filter(g=>g.to-g.from>.3).sort((a,b)=>(b.to-b.from)-(a.to-a.from)).slice(0,6).sort((a,b)=>a.from-b.from);$('regionCards').innerHTML=p?featured.map(g=>`<button class="region-card" data-range="${g.from},${g.to}" style="--region-color:${thicknessColor(g.thicknessUm)}"><span class="range">Z ${mm(g.from)}–${mm(g.to)} mm</span><strong>${g.thicknessUm}<span class="micro"> µm</span></strong><small>${esc(reasonLabel(g.reason))}</small>${g.adjusted?'<small class="range-fit">Section-end adjustment</small>':''}</button>`).join(''):'<p class="micro muted">Scan the model to see where the thickness changes.</p>';$('planFootnote').textContent=p?`${r.length} height regions · ${p.layers.filter(l=>l.adjusted).length} section-end adjustments · select a region to edit it`:'Changes take effect after scanning.';$('layerSlider').max=p?Math.max(0,p.layers.length-1):1;state.selectedLayer=Math.min(state.selectedLayer,p?.layers.length-1||0);$('layerSlider').value=state.selectedLayer;$('scheduleRows').innerHTML=r.map((g,i)=>`<tr data-run="${i}"><td>${mm(g.from)}–${mm(g.to)}</td><td>${g.thicknessUm} µm${g.adjusted?' *':''}</td><td>${g.count}</td><td>${esc(reasonLabel(g.reason))}</td></tr>`).join('');renderWarnings();renderTime();}
function renderWarnings(){const activeIds=new Set(state.sources.map(m=>m.id)),diagnostics=state.diagnostics.filter(d=>activeIds.has(d.id));const repairNotes=diagnostics.flatMap(d=>{const summary=repairSummary(d),repair=d.repair||d.repairReport;return [...(summary?[`${d.name||'Part'}: ${summary}`]:[]),...(Array.isArray(repair?.warnings)?repair.warnings.map(w=>`${d.name||'Part'}: ${w}`):[])];});const warnings=[...(state.plan?.warnings||[]),...(state.layout?.warnings||[]),...state.warnings,...diagnostics.flatMap(d=>d.warnings||[]),...repairNotes];if(state.slcError)warnings.unshift(typeof state.slcError==='string'?state.slcError:state.slcError.message);if(state.plan)warnings.push('A thickness interval applies to every part at that height. Internal nested contours are excluded from the exterior-wall rule.');const unique=[...new Set(warnings)];$('warningCount').textContent=unique.length?`(${unique.length})`:'';$('warningsList').innerHTML=unique.map(w=>`<li>${esc(w)}</li>`).join('');}
function setRange(a,b,{syncInputs=true}={}){const h=height()||45;if(!Number.isFinite(a)||!Number.isFinite(b))return;a=Math.max(0,Math.min(h,a));b=Math.max(0,Math.min(h,b));if(a>b)[a,b]=[b,a];state.range=[a,b];callouts.setSelection(a,b);if(syncInputs){$('rangeFrom').value=mm(a);$('rangeTo').value=mm(b);}viewer.setSelection(a,b);$('selectionReadout').textContent=`SELECTED Z ${mm(a)}–${mm(b)} MM`;$('railSelection').style.top=`${100*(1-b/h)}%`;$('railSelection').style.height=`${100*(b-a)/h}%`;$('heightRail').setAttribute('aria-valuenow',a);}
function renderBands(){$('bandsList').innerHTML=state.overrides.length?state.overrides.map(o=>`<div class="band-row"><span>${mm(o.fromMm)}–${mm(o.toMm)} mm</span><b>${o.thicknessUm} µm</b><button data-delete-band="${esc(o.id)}" aria-label="Remove ${mm(o.fromMm)} to ${mm(o.toMm)} mm band">×</button></div>`).join(''):'<p class="micro muted">No manual bands yet.</p>';}
async function addBand(){if(state.busy)return;try{if(['rangeFrom','rangeTo','manualUm'].some(id=>$(id).value===''))throw new Error('Enter both height limits and a layer thickness.');let a=val('rangeFrom'),b=val('rangeTo'),t=val('manualUm');if(!Number.isInteger(t)||t<50||t>200)throw new Error('Choose a whole-number layer thickness from 50 to 200 µm.');a=Math.round(a*20)/20;b=Math.round(b*20)/20;if(!(a>=0&&b>a&&b<=height()+1e-6))throw new Error('The band must be within the part height, and its end must be above its start.');if(state.overrides.some(o=>a<o.toMm-1e-8&&b>o.fromMm+1e-8))throw new Error('This band overlaps an existing manual band. Remove that band first.');if(state.overrides.length>=500)throw new Error('A build supports up to 500 manual bands.');state.overrides.push({id:crypto.randomUUID(),fromMm:a,toMm:b,thicknessUm:t});state.overrides.sort((a,b)=>a.fromMm-b.fromMm);setRange(a,b);renderBands();invalidate();await scan();}catch(e){showError(e);}}
function inspectLayer(){const l=state.plan?.layers[Number($('layerSlider').value)];if(!l){$('layerReadout').textContent='—';$('layerZ').textContent='Z — mm';return;}state.selectedLayer=Number($('layerSlider').value);$('layerReadout').textContent=`${state.selectedLayer+1} / ${state.plan.layers.length}`;$('layerZ').textContent=`Z ${mm(l.zMm)} mm · ${l.thicknessUm} µm`;viewer.setLayer(l.zMm);if(state.view==='slice'){clearTimeout(sliceTimer);sliceTimer=setTimeout(loadSlice,120);}}
async function loadSlice(){if(!state.plan||state.busy)return;const l=state.plan.layers[state.selectedLayer];try{const r=await rpc('slice',{meshes:state.meshes.map(cleanMesh),zMm:(l.zStartMm+l.zMm)/2});state.slice=r.section;drawSlice();$('statusText').textContent=`Layer ${state.selectedLayer+1} · ${r.section.rings.length} contours · ${r.section.areaMm2.toFixed(2)} mm² filled area`;}catch(e){if(e.message!=='Operation cancelled.')showError(e);}}
function drawSlice(){const c=$('sliceCanvas'),dpr=devicePixelRatio||1,w=c.clientWidth,h=c.clientHeight;if(!w||!h)return;c.width=w*dpr;c.height=h*dpr;const ctx=c.getContext('2d');ctx.scale(dpr,dpr);ctx.fillStyle='#0c140f';ctx.fillRect(0,0,w,h);const rings=state.slice?.rings;if(!rings?.length){ctx.fillStyle='#a4b7aa';ctx.font='12px monospace';ctx.fillText('Select a layer to inspect its contour.',30,h/2);return;}const pts=rings.flat(),xs=pts.map(p=>p[0]),ys=pts.map(p=>p[1]);let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;for(const p of pts){minX=Math.min(minX,p[0]);maxX=Math.max(maxX,p[0]);minY=Math.min(minY,p[1]);maxY=Math.max(maxY,p[1]);}const scale=Math.min((w-110)/(maxX-minX||1),(h-100)/(maxY-minY||1)),ox=(w-(maxX-minX)*scale)/2,oy=(h-(maxY-minY)*scale)/2;ctx.beginPath();for(const ring of rings){ring.forEach((p,i)=>{const x=ox+(p[0]-minX)*scale,y=h-oy-(p[1]-minY)*scale;i?ctx.lineTo(x,y):ctx.moveTo(x,y);});ctx.closePath();}ctx.fillStyle='#a6e7c533';ctx.fill('evenodd');ctx.strokeStyle='#bce9ce';ctx.lineWidth=1;ctx.stroke();}
function setView(v){state.view=v;$('resetViewButton').disabled=v==='slice';callouts.setView(v);$$('[data-view]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.view===v)));$('viewer').hidden=v==='slice';$('sliceCanvas').hidden=v!=='slice';$('heightRail').hidden=v!=='side';$('viewBadge').textContent={side:'SIDE / X–Z','3d':'PERSPECTIVE / ORBIT',plate:'BUILD PLATE / X–Y',slice:'SECTION / X–Y'}[v];$('orbitHint').textContent=v==='3d'?'Drag to orbit · right-drag to pan · scroll to zoom':v==='plate'?'Drag to pan · scroll to zoom · bed coordinates in mm':v==='slice'?'Filled mask at the selected layer midpoint':'Drag to pan · scroll to zoom · Shift-drag to select height';if(v==='slice')loadSlice();else viewer.setView(v);}

function profileFromForm(){return {id:state.profileId,name:$('resinName').value,ecMjCm2:optional('ecValue'),dpUm:optional('dpValue'),irradianceMwCm2:optional('irradianceValue'),cureDepthFactor:val('cureFactor'),cureDepthAllowanceUm:val('cureAllowance'),demo:state.profileDemo};}
function cycleFromForm(){return {overheadSeconds:$('overheadSeconds').value===''?NaN:val('overheadSeconds'),setupSeconds:val('setupSeconds'),baseLayerCount:val('baseLayerCount'),baseExposureSeconds:optional('baseExposure')};}
function applyProfile(p){state.profileDemo=p.demo===true;$('resinName').value=p.name||'My resin';$('ecValue').value=p.ecMjCm2??'';$('dpValue').value=p.dpUm??'';$('irradianceValue').value=p.irradianceMwCm2??'';$('cureFactor').value=p.cureDepthFactor??1.1;$('cureAllowance').value=p.cureDepthAllowanceUm??0;renderTime();}
function loadProfiles(){try{const p=JSON.parse(localStorage.getItem('intrepid-layer-profiles-v1')||'[]');state.profiles=Array.isArray(p)?p.filter(x=>validateProfile(x).valid).slice(0,100):[];}catch{state.profiles=[];}renderProfileSelect();}
function renderProfileSelect(){$('resinSelect').replaceChildren(new Option('No calibration yet','uncalibrated'),new Option(DEMO_PROFILE.name,DEMO_PROFILE.id),...state.profiles.map(p=>new Option(p.name,p.id)));$('resinSelect').value=state.profileId;}
function renderTime(){const p=profileFromForm();drawExposure(p);if(!state.plan){
  $('layerCount').textContent='—';$('estimatedTime').textContent='—';$('savedPercent').textContent='—';
  $('layerBaseline').textContent='vs — at 100 µm';$('timeLabel').textContent='Estimated print time';$('timeBaseline').textContent='Scan a build to estimate time';
  $('savingLabel').textContent='Estimated time saved';$('savingDetail').textContent='Compared with 100 µm';$('estimateBadge').textContent='SCAN REQUIRED';
  $('timeBreakdown').textContent='Scan your build to estimate its cycle count.';$('estimateNote').textContent='Scan the current geometry to compare its layer schedule with the 100 µm baseline.';return;
}try{const comparison=compareTimes(state.plan.layers,p,cycleFromForm());const {optimized:o,baseline:b}=comparison,fullSavings=o.complete&&b.complete&&comparison.savedPercent!==null;$('layerCount').textContent=o.layerCount.toLocaleString();$('layerBaseline').textContent=`vs ${b.layerCount.toLocaleString()} at 100 µm`;$('timeLabel').textContent=o.complete?'Estimated print time':'Known time only';$('estimatedTime').textContent=formatDuration(o.complete?o.totalSeconds:o.knownSeconds);$('timeBaseline').textContent=b.complete?`vs ${formatDuration(b.totalSeconds)} at 100 µm`:'Exposure not fully estimated';$('savingLabel').textContent=fullSavings?'Estimated time saved':'Fewer layer cycles';const pc=fullSavings?comparison.savedPercent:comparison.layerReductionPercent;$('savedPercent').textContent=`${pc>=0?'':'−'}${Math.abs(pc).toFixed(1)}%`;$('savingDetail').textContent=fullSavings?`${formatDuration(Math.abs(comparison.savedSeconds))} ${comparison.savedSeconds>=0?'less':'more'} than baseline`:`${b.layerCount-o.layerCount} fewer cycles than baseline`;$('estimateBadge').textContent=p.demo?'DEMO · ILLUSTRATIVE':o.complete?'BASED ON YOUR INPUTS':'PARTIAL · ADD CALIBRATION';$('timeBreakdown').innerHTML=`<span>EXPOSURE ${o.complete?formatDuration(o.exposureSeconds):'NOT FULLY ESTIMATED'}</span><span>CYCLE OVERHEAD ${formatDuration(o.overheadSeconds)}</span><span>SETUP ${formatDuration(o.setupSeconds)}</span>`;$('estimateNote').textContent=(p.demo?'Illustrative resin data. ':'')+(o.complete?'Flood-exposure estimate using the entered curve and cycle times. This does not predict Ra or establish a resin optimum.':'Enter Ec, Dp and irradiance, plus base exposure if applicable, to estimate total print time. The displayed known time is not a total.');}catch(e){$('estimatedTime').textContent='Check inputs';$('savedPercent').textContent='—';$('timeBaseline').textContent='';$('estimateNote').textContent=e.message;$('timeBreakdown').textContent='Estimate unavailable until the parameters are valid.';}}
function drawExposure(profile){const c=$('exposureChart'),w=c.clientWidth,h=130,dpr=devicePixelRatio||1;if(!w)return;c.width=w*dpr;c.height=h*dpr;const ctx=c.getContext('2d');ctx.scale(dpr,dpr);ctx.clearRect(0,0,w,h);ctx.font='10px monospace';ctx.fillStyle=isLight()?'#4d554f':'#8da696';let pts;try{pts=Array.from({length:31},(_,i)=>[50+i*5,exposureSeconds(50+i*5,profile)]);}catch{return;}if(pts.some(p=>p[1]===null)){ctx.fillText('Add your working curve to preview exposure by thickness.',10,50);return;}const max=pts.at(-1)[1]*1.15,xx=x=>44+(w-62)*(x-50)/150,yy=y=>100-77*y/max;ctx.strokeStyle=isLight()?'#b9c7b9':'#2e4234';ctx.beginPath();ctx.moveTo(44,16);ctx.lineTo(44,100);ctx.lineTo(w-18,100);ctx.stroke();ctx.strokeStyle=isLight()?'#b33200':'#bce9ce';ctx.lineWidth=1.5;ctx.beginPath();pts.forEach(([x,y],i)=>i?ctx.lineTo(xx(x),yy(y)):ctx.moveTo(xx(x),yy(y)));ctx.stroke();ctx.fillStyle=isLight()?'#4d554f':'#b1c7b7';for(const x of [50,100,150,200])ctx.fillText(`${x} µm`,xx(x)-15,119);for(const fraction of [0,.5,1])ctx.fillText((max*fraction).toFixed(1)+' s',2,yy(max*fraction)+3);ctx.fillStyle=isLight()?'#4d554f':'#8da696';ctx.fillText('Predicted normal-layer exposure',52,17);}

function download(bytes,type,name){const url=URL.createObjectURL(new Blob([bytes],{type})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);}
function safeName(){return state.sources.length===1?state.sources[0].name.replace(/\.stl$/i,'').replace(/[^a-z0-9_-]+/gi,'-').slice(0,80):'intrepid-build';}
function recipe(){const p=validateProfile(profileFromForm()),c=validateCycle(cycleFromForm());if(!p.valid||!c.valid)throw new Error([...p.errors,...c.errors].join(' '));return {format:'intrepid-layer-studio-v1',createdAt:new Date().toISOString(),units:'mm',options:planOptions(),profile:profileFromForm(),cycle:cycleFromForm(),parts:state.sources.map(m=>({id:m.id,name:m.name,triangleCount:m.triangleCount,bounds:m.bounds})),placements:state.placements,exportReport:state.exportReport,layerConvention:'SLC minimum Z, midpoint sampled contours',plan:state.plan?{heightMm:state.plan.heightMm,layers:state.plan.layers.map(l=>({zStartMm:l.zStartMm,zMm:l.zMm,thicknessUm:l.thicknessUm,reason:l.reason}))}:null,notes:['STL geometry is not included. Reload the original files, confirm units, and reapply any manual rotations when reusing these settings.','Ec/Dp time predictions do not replace printer validation.']};}
async function exportSLC(){
  if(!state.plan||state.busy)return;
  try{
    const r=await rpc('export',{meshes:state.meshes.map(cleanMesh),plan:state.plan});
    const warnings=Array.isArray(r.warnings)?r.warnings.filter(w=>typeof w==='string'):[],recovery=r.recovery||{};
    const recovered=Number.isFinite(recovery.recoveredPlanes)?recovery.recoveredPlanes:0;
    state.exportReport={warnings,recovery};state.warnings=[...state.warnings,...warnings];renderWarnings();
    download(r.buffer,'application/octet-stream',`${safeName()}-adaptive.slc`);
    $('statusText').textContent=`SLC exported · ${r.layerCount} layers · ${(r.byteLength/1024).toFixed(1)} KB · read-back validation passed${recovered?` · ${recovered} sampling planes adjusted`:''}`;
    toast(recovered?`SLC exported. ${recovered} sampling planes were adjusted; review Geometry checks and download the companion recipe.`:'SLC exported. Download the companion recipe for resin and exposure settings.');
  }catch(e){if(e.message!==CANCEL_MESSAGE)showError(e);}
}
async function importSettings(file){if(!file||state.busy)return;try{
  if(file.size>20*1024*1024)throw new Error('Settings files must be under 20 MB.');
  const r=JSON.parse(await file.text());
  if(r.format!=='intrepid-layer-studio-v1')throw new Error('This is not a Layer Studio settings file.');
  const p=validateProfile(r.profile),c=validateCycle(r.cycle);
  if(!p.valid||!c.valid)throw new Error([...p.errors,...c.errors].join(' '));
  const o=r.options||{},bed=o.bed||{};
  function number(v,min,max,label,integer=false){if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max||(integer&&!Number.isInteger(v)))throw new Error('Invalid '+label+' in settings.');return v;}
  number(o.preferredUm,50,200,'preferred thickness',true);number(o.supportEndMm,0,100000,'support height');number(o.verticalToleranceDeg,0,45,'wall angle');
  if(o.baselineUm!==100||typeof o.automatic!=='boolean')throw new Error('Settings must use the 100 µm baseline and an explicit automatic mode.');
  number(bed.width,.1,100000,'bed width');number(bed.depth,.1,100000,'bed depth');number(bed.gap,0,100000,'part gap');number(bed.margin,0,Math.min(bed.width,bed.depth)/2-.00001,'bed margin');
  if(!Array.isArray(o.overrides)||o.overrides.length>500)throw new Error('Settings support up to 500 manual bands.');
  const bands=o.overrides.map(b=>({id:crypto.randomUUID(),fromMm:number(b.fromMm,0,100000,'band start'),toMm:number(b.toMm,0,100000,'band end'),thicknessUm:number(b.thicknessUm,50,200,'manual thickness',true)})).sort((a,b)=>a.fromMm-b.fromMm);
  for(let i=0;i<bands.length;i++){if(bands[i].toMm<=bands[i].fromMm||(i&&bands[i].fromMm<bands[i-1].toMm-1e-8))throw new Error('Imported height bands must have positive height and must not overlap.');}
  for(const [id,key] of [['preferredUm','preferredUm'],['supportEnd','supportEndMm'],['angleTolerance','verticalToleranceDeg']])$(id).value=o[key];
  $('autoMode').checked=o.automatic;
  for(const [id,key] of [['bedWidth','width'],['bedDepth','depth'],['partGap','gap'],['bedMargin','margin']])$(id).value=bed[key];
  state.overrides=bands;state.importedSettings=true;state.profileId=p.profile.demo?'demo-illustrative':'uncalibrated';applyProfile(p.profile);
  for(const [id,key] of [['overheadSeconds','overheadSeconds'],['setupSeconds','setupSeconds'],['baseLayerCount','baseLayerCount'],['baseExposure','baseExposureSeconds']])$(id).value=c.cycle[key]??'';
  $('supportSlider').value=$('supportEnd').value;renderProfileSelect();renderBands();invalidate('Settings imported. Reload matching STLs, confirm units and orientation, then scan.');toast('Settings imported. Reload STLs and reapply any manual rotations.');
}catch(e){showError(e);}finally{$('recipeFile').value='';}}


$('stlFiles').addEventListener('change',e=>loadFiles(e.target.files));$('dropzone').addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();$('stlFiles').click();}});for(const event of ['dragenter','dragover'])$('dropzone').addEventListener(event,e=>{e.preventDefault();$('dropzone').classList.add('dragover');});for(const event of ['dragleave','drop'])$('dropzone').addEventListener(event,e=>{e.preventDefault();$('dropzone').classList.remove('dragover');});$('dropzone').addEventListener('drop',e=>loadFiles(e.dataTransfer.files));$('demoButton').onclick=loadDemo;$('planButton').onclick=scan;$('applyBandButton').onclick=addBand;$('cancelButton').onclick=()=>cancelJob();$('operationCancel').onclick=()=>cancelJob();
$('partsList').addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;if(b.dataset.remove!==undefined){state.sources.splice(Number(b.dataset.remove),1);}if(b.dataset.copy!==undefined){const m=state.sources[Number(b.dataset.copy)];state.sources.push({...cleanMesh(m),id:crypto.randomUUID(),name:m.name.replace(/\.stl$/i,'')+' copy.stl',positions:m.positions.slice()});}if(b.dataset.rotate){const [i,axis]=b.dataset.rotate.split(':').map(Number),rotation=[0,0,0];rotation[axis]=90;state.sources[i]=transformMesh(state.sources[i],{rotation,ground:true});if(axis!==2&&state.overrides.length){state.overrides=[];renderBands();toast('Orientation changed. Manual height bands were cleared for the new Z direction.');}}state.meshes=state.sources;invalidate();renderParts();viewer.setMeshes(state.meshes);syncHeight();});
$('bandsList').addEventListener('click',e=>{const id=e.target.closest('[data-delete-band]')?.dataset.deleteBand;if(id){state.overrides=state.overrides.filter(o=>o.id!==id);renderBands();invalidate();scan();}});
for(const id of ['bedWidth','bedDepth','partGap','bedMargin','preferredUm','angleTolerance','autoMode'])$(id).addEventListener('change',()=>invalidate());$('supportEnd').addEventListener('change',()=>{$('supportSlider').value=$('supportEnd').value;invalidate();});$('supportSlider').addEventListener('input',()=>{$('supportEnd').value=$('supportSlider').value;});$('supportSlider').addEventListener('change',()=>invalidate());$('unitScale').addEventListener('change',()=>toast('The selected units apply to newly added STL files. Reload existing files to change their scale.'));
// Keep draft text (including empty values and trailing decimal points) intact.
// Only valid ranges update the preview; Add height band validates on submission.
for(const id of ['rangeFrom','rangeTo'])$(id).addEventListener('input',()=>{
  if($('rangeFrom').value===''||$('rangeTo').value==='')return;
  const a=val('rangeFrom'),b=val('rangeTo');
  if(Number.isFinite(a)&&Number.isFinite(b)&&a>=0&&b>=a&&b<=height())setRange(a,b,{syncInputs:false});
});$$('[data-thickness]').forEach(b=>b.onclick=()=>{$('manualUm').value=b.dataset.thickness;$$('[data-thickness]').forEach(q=>q.classList.toggle('selected',q===b));});$('manualUm').addEventListener('input',()=>$$('[data-thickness]').forEach(b=>b.classList.toggle('selected',Number(b.dataset.thickness)===val('manualUm'))));
let railStart=null;$('heightRail').addEventListener('pointerdown',e=>{if(state.view!=='side')return;const r=e.currentTarget.getBoundingClientRect();railStart=Math.round((1-(e.clientY-r.top)/r.height)*height()*20)/20;e.currentTarget.setPointerCapture(e.pointerId);setRange(railStart,railStart);});$('heightRail').addEventListener('pointermove',e=>{if(railStart===null)return;const r=e.currentTarget.getBoundingClientRect(),z=Math.round((1-(e.clientY-r.top)/r.height)*height()*20)/20;setRange(railStart,z);});$('heightRail').addEventListener('pointerup',()=>{railStart=null;});$('heightRail').addEventListener('pointercancel',()=>{railStart=null;});$('heightRail').addEventListener('keydown',e=>{if(['ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();const step=e.key==='ArrowUp'?.05:-.05;setRange(state.range[0]+step,state.range[1]+step);}});
$('resetViewButton').onclick=()=>viewer.resetView();
$$('[data-view]').forEach(b=>b.onclick=()=>setView(b.dataset.view));$('layerSlider').addEventListener('input',inspectLayer);function chooseRegion(e){const b=e.target.closest('[data-run],[data-range]');if(!b)return;const g=b.dataset.run!==undefined?runs()[Number(b.dataset.run)]:null;const range=g?[g.from,g.to]:b.dataset.range.split(',').map(Number);setRange(...range);if(g)$('manualUm').value=g.thicknessUm;if($('scheduleDialog').open)$('scheduleDialog').close();setView('side');}$('scheduleStrip').onclick=chooseRegion;$('regionCards').onclick=chooseRegion;$('scheduleRows').onclick=chooseRegion;
$('scheduleButton').onclick=()=>$('scheduleDialog').showModal();$('helpButton').onclick=()=>$('helpDialog').showModal();$$('[data-close]').forEach(b=>b.onclick=()=>$(b.dataset.close).close());$('scheduleCsvButton').onclick=()=>{const rows=['z_start_mm,z_end_mm,thickness_um,layer_count,rule',...runs().map(g=>[g.from,g.to,g.thicknessUm,g.count,g.reason].join(','))];download(rows.join('\r\n'),'text/csv',`${safeName()}-schedule.csv`);};
$('resinSelect').onchange=()=>{state.profileId=$('resinSelect').value;const p=state.profileId===DEMO_PROFILE.id?DEMO_PROFILE:state.profiles.find(p=>p.id===state.profileId)||{name:'My resin'};applyProfile(p);};$('newResinButton').onclick=()=>{state.profileId='uncalibrated';$('resinSelect').value='uncalibrated';applyProfile({name:'New resin'});$('resinName').focus();};$('saveResinButton').onclick=()=>{const checked=validateProfile(profileFromForm());if(!checked.valid)return showError(new Error(checked.errors.join(' ')));const p={...checked.profile,id:state.profileId!=='uncalibrated'&&state.profileId!==DEMO_PROFILE.id?state.profileId:crypto.randomUUID(),demo:checked.profile.demo};state.profiles=state.profiles.filter(q=>q.id!==p.id);state.profiles.push(p);state.profileId=p.id;try{localStorage.setItem('intrepid-layer-profiles-v1',JSON.stringify(state.profiles));renderProfileSelect();renderTime();clearError();toast(checked.complete?'Resin profile saved in this browser.':'Draft resin profile saved. Fill in calibration values for a total time estimate.');}catch{showError(new Error('Browser storage is unavailable. Download the recipe to keep your settings.'));}};
for(const id of ['resinName','ecValue','dpValue','irradianceValue','cureFactor','cureAllowance','overheadSeconds','setupSeconds','baseLayerCount','baseExposure'])$(id).addEventListener('input',renderTime);
$('exportButton').onclick=exportSLC;$('recipeButton').onclick=()=>{try{download(JSON.stringify(recipe(),null,2),'application/json',`${safeName()}-recipe.json`);clearError();}catch(e){showError(e);}};$('importRecipeButton').onclick=()=>$('recipeFile').click();$('recipeFile').onchange=e=>importSettings(e.target.files[0]);$('shareButton').onclick=async()=>{try{await navigator.clipboard.writeText(location.href.split('#')[0]);toast('App link copied. Your STL files and resin profiles are not included.');}catch{toast('Copy this page’s address to share the app.');}};
new ResizeObserver(()=>{drawExposure(profileFromForm());if(state.view==='slice')drawSlice();}).observe($('buildName').closest('.build-column'));
loadProfiles();renderBands();loadDemo();
