// Membership and round history commit together; original data is backed up before the first change.
(function(){
 const root=typeof window==='undefined'?globalThis:window;
 let pending=Promise.resolve();
 const extension=()=>typeof chrome!=='undefined'&&chrome.storage?.local;
 async function read(){
  if(extension()){const value=await chrome.storage.local.get(['corrections','drillState']);return {corrections:value.corrections||{},drillState:value.drillState||{}};}
  return {corrections:JSON.parse(localStorage.getItem('corrections')||'{}'),drillState:JSON.parse(localStorage.getItem('drillState')||'{}')};
 }
 function backup(state){
  return new Promise((resolve,reject)=>{
   const request=indexedDB.open('nuance-learning-backup',1);
   request.onupgradeneeded=()=>request.result.createObjectStore('snapshots');
   request.onerror=()=>reject(Error('无法备份原数据，已停止队列改动。'));
   request.onsuccess=()=>{const db=request.result,tx=db.transaction('snapshots','readwrite'),store=tx.objectStore('snapshots');const old=store.get('queue-v1');old.onsuccess=()=>{if(!old.result)store.put({at:Date.now(),...state},'queue-v1');};tx.oncomplete=()=>{db.close();resolve();};tx.onabort=()=>{db.close();reject(Error('备份失败，原数据未改动。'));};};
  });
 }
 async function applyLocal(action){
  const previous=await read();let map=previous.corrections;
  if(!map||typeof map!=='object'||Array.isArray(map)||!previous.drillState||typeof previous.drillState!=='object'||Array.isArray(previous.drillState))throw Error('学习数据格式异常，已停止改动');
  let operation=action;
  if(action.type==='feedback'){
   const created=root.NuanceFeedback.activate(map,action.sessionKey,Number(action.index),Date.now(),root.NuanceLearning.canActivate);
   map=created.map;operation={type:'reconcile'};
  }
  const result=root.NuanceQueue.apply(map,previous.drillState,operation);
  if(result.changed||map!==previous.corrections){
   await backup(previous);
   // Backup is async: retain notes, stars, new captures and progress changed while it ran.
   const fresh=await read(),combined={...fresh.corrections};
   if(operation.type==='adopt'){
    const before=previous.corrections[operation.key],current=fresh.corrections[operation.key];
    if(!current||current.better!==before?.better||(current.expressionChangedAt||0)!==(before?.expressionChangedAt||0))throw Error('保存期间原句已被其他页面更新，未覆盖新内容。请重新检查后再替换。');
   }
   for(const [key,item] of Object.entries(result.corrections)){
    if(Object.hasOwn(previous.corrections,key)&&!Object.hasOwn(fresh.corrections,key))continue;
    combined[key]=root.NuanceLearning.mergeVersions(combined[key],item);
   }
   const progress={...fresh.drillState};for(const [key,item] of Object.entries(result.drillState))if(!progress[key]||(item.savedAt||0)>=(progress[key].savedAt||0))progress[key]=item;
   if(operation.type==='adopt')verifyAdoption(operation,combined,progress);
   result.corrections=combined;result.drillState=progress;
   if(extension())await chrome.storage.local.set({corrections:result.corrections,drillState:result.drillState,nuanceCaptureSyncPending:true});
   else{
    // Persist event history first. If the second write fails, retry can reconcile against the untouched records.
    try{localStorage.setItem('drillState',JSON.stringify(result.drillState));localStorage.setItem('corrections',JSON.stringify(result.corrections));}
    catch(error){localStorage.setItem('drillState',JSON.stringify(fresh.drillState));throw Error('本机存储空间不足，队列未保存。请保留页面后重试。');}
   }
  }
  if(operation.type==='adopt'){const persisted=await read();verifyAdoption(operation,persisted.corrections,persisted.drillState);result.corrections=persisted.corrections;result.drillState=persisted.drillState;}
  return {ok:true,changed:result.changed,attemptId:result.attemptId,corrections:result.corrections,drillState:result.drillState};
 }
 function verifyAdoption(action,corrections,drillState){
  const attempt=drillState?.['@nuance/practice/'+action.attemptId],item=corrections?.[action.key];
  if(!attempt||!item||item.better!==attempt.answer||item.adoptedAttemptId!==action.attemptId)throw Error('主句未能保存为这次造句，请重试。原句和审核记录仍保留。');
 }
 function runLocal(action){const task=()=>root.navigator?.locks?root.navigator.locks.request('nuance-learning-queue',()=>applyLocal(action)):applyLocal(action);const work=pending.then(task);pending=work.catch(()=>{});return work;}
 async function requireCurrentWorker(){
  let info;try{info=await chrome.runtime.sendMessage({type:'nuance:queue-capabilities'});}catch(_){}
  if(!info?.ok||info.queueProtocol<3||!Number.isFinite(info.queueProtocol))throw Error('插件后台版本较旧：请到 chrome://extensions 重新加载 Nuance，再刷新此页重试。原句和造句仍保留。');
 }
 async function run(action){
  const viaWorker=extension()&&typeof document!=='undefined';
  if(viaWorker&&action.type==='adopt')await requireCurrentWorker();
  const result=viaWorker?await chrome.runtime.sendMessage({type:'nuance:queue',action}):await runLocal(action);
  if(!result?.ok)throw Error(result?.error||'队列未保存，请重新加载插件后重试');
  if(action.type==='adopt')verifyAdoption(action,result.corrections,result.drillState);
  if(!viaWorker&&result.changed)root.NuanceSync?.syncSoon();return result;
 }
 async function checkLocal(input,{origin,access=''}={}){
  const state=await read(),snapshot=root.NuanceQueue.snapshot(state.corrections,state.drillState);
  const item=snapshot.items.find(x=>x.key===input.key),answer=typeof input.answer==='string'?input.answer.trim():'';
  if(!item||!answer||answer.length>3000)throw Error('请先选择本轮卡片，并写下你的造句');
  const material=root.NuanceQueue.dialogueMaterials(snapshot).find(x=>x.key===input.key);
  const response=await fetch(`${origin||root.NUANCE_MODEL_ORIGIN||location.origin}/sentence-practice`,{method:'POST',headers:{'Content-Type':'application/json',...(access?{'x-tutor-key':access}:{})},body:JSON.stringify({reference:item.better,answer,context:material.intent,pattern:material.construct}),signal:AbortSignal.timeout(190000)});
  const value=await response.json();if(!response.ok)throw Error(value.error||'AI 暂时无法给出反馈，请重试');
  const feedback=root.NuanceQueue.feedback(value);if(!feedback)throw Error('AI 返回内容不完整，请重试');
  // The request is bound to the original card; never attach its feedback to a replacement.
  const fresh=await read(),current=root.NuanceQueue.snapshot(fresh.corrections,fresh.drillState).items.find(x=>x.key===input.key);
  if(!current||current.better!==item.better||root.NuanceQueue.snapshot(fresh.corrections,fresh.drillState).windowId!==snapshot.windowId)return {ok:true,feedback,saved:false,notice:'本轮材料已变化，这次反馈保留在当前页面，未写入其他卡片。'};
  const saved=await runLocal({type:'attempt',key:input.key,answer,feedback,reference:item.better,windowId:snapshot.windowId});
  return {...saved,feedback,saved:true};
 }
 async function check(input){
  const viaWorker=extension()&&typeof document!=='undefined';
  if(viaWorker)await requireCurrentWorker();
  const result=viaWorker?await chrome.runtime.sendMessage({type:'nuance:sentence-check',input}):await checkLocal(input);
  if(!result?.ok)throw Error(result?.error||'暂时无法检查造句，请重试');
  if(!viaWorker&&result.changed)root.NuanceSync?.syncSoon();return result;
 }
 root.NuanceQueueStore={run,runLocal,read,check,checkLocal};
})();
