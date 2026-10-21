/* global chrome, NuanceLearning, NuanceCapture */
importScripts('learning.js', 'capture-core.js', 'feedback-core.js', 'dictionary-core.js');
const MODEL_ORIGIN = 'http://127.0.0.1:48773';
const SYNC_ORIGIN = 'https://sayright-x4a0.onrender.com';
const FIELDS = ['corrections','sceneSaves','sceneScripts','drillState'];
let mutation = Promise.resolve();
function serialized(action) { const task=mutation.then(action); mutation=task.catch(()=>{}); return task; }
async function readState() {
  const data=await chrome.storage.local.get([...FIELDS,'syncTombstones','tutorAccessKey']);
  return {...Object.fromEntries(FIELDS.map(key=>[key,data[key]||{}])),tombstones:data.syncTombstones||{},access:data.tutorAccessKey||''};
}
function requestSync() {
  // Persist a retry: a suspended MV3 worker must not lose the request to sync.
  chrome.alarms.create('nuance-capture-sync',{delayInMinutes:1});
  void serialized(syncCloud).catch(()=>{});
}
async function syncCloud() {
  const local=await readState();
  if (!local.access) return; // Plugin settings mirror the existing key into chrome.storage.local.
  const {access,...body}=local;
  const response=await fetch(`${SYNC_ORIGIN}/sync`,{method:'POST',headers:{'Content-Type':'application/json','x-tutor-key':access},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw new Error('云同步暂未完成');
  const merged=await response.json();
  if(!merged.corrections || !merged.tombstones)throw new Error('同步响应不完整');
  const fresh=await readState();
  const combined=NuanceCapture.mergeState(merged,fresh);
  await chrome.storage.local.set({corrections:combined.corrections,syncTombstones:combined.tombstones,nuanceCaptureSyncPending:false});
  if(JSON.stringify(local.corrections)!==JSON.stringify(fresh.corrections)||JSON.stringify(local.tombstones)!==JSON.stringify(fresh.tombstones)) {
    await chrome.storage.local.set({nuanceCaptureSyncPending:true});
    chrome.alarms.create('nuance-capture-sync',{delayInMinutes:1});
  } else await chrome.alarms.clear('nuance-capture-sync');
}
chrome.alarms.onAlarm.addListener(alarm=>{
  if(alarm.name==='nuance-capture-sync') void serialized(syncCloud).catch(()=>chrome.alarms.create('nuance-capture-sync',{delayInMinutes:1}));
});
async function resumePendingSync() {
  const state=await chrome.storage.local.get(['nuanceCaptureSyncPending']);
  if(state.nuanceCaptureSyncPending)requestSync();
}
chrome.runtime.onStartup?.addListener(()=>void resumePendingSync());
chrome.runtime.onInstalled?.addListener(()=>void resumePendingSync());
chrome.storage.onChanged.addListener((changes,area)=>{
  if(area==='local' && changes.tutorAccessKey?.newValue) requestSync();
});
async function capture(message,sender) {
  const text=typeof message.text==='string'?message.text.trim():'';
  if(text.length<2||text.length>1200||text.toLowerCase()==='__proto__')throw new Error('请选择 2～1200 个字符的表达');
  const context=typeof message.context==='string'?message.context.slice(0,5000):'';
  const {corrections,access}=await readState();
  const lookup=NuanceLearning.keyOf(text);
  const existing=Object.hasOwn(corrections,lookup)?corrections[lookup]:null;
  let generated=existing?.situation ? {personalContext:existing.personalContext||existing.situation,practiceCue:existing.situation,transferCue:existing.situations?.[0]||existing.situation} : null;
  if(!generated){
    let response;
    try {response=await fetch(`${MODEL_ORIGIN}/capture`,{method:'POST',headers:{'Content-Type':'application/json',...(access?{'x-tutor-key':access}:{})},body:JSON.stringify({text,context}),signal:AbortSignal.timeout(100000)});}
    catch (_) {throw new Error('本机模型服务暂不可用。请确认后台服务运行且已连通内网，再重试。');}
    const result=await response.json();
    if(!response.ok)throw new Error(result.error||'情境生成失败，请重试');
    generated=NuanceCapture.validate(result,text);
    if(!generated)throw new Error('情境里包含答案或内容不完整，没有保存，请重试');
  }
  return serialized(async()=>{
    const latest=await readState();
    const saved=NuanceCapture.captureInto(latest.corrections,{text,title:sender.tab.title,url:sender.tab.url},generated,Date.now());
    await chrome.storage.local.set({corrections:saved.map,nuanceCaptureSyncPending:true});
    requestSync();
    return {ok:true,key:saved.key,text:saved.item.better,personalContext:saved.item.personalContext,practiceCue:saved.item.situation,active:saved.active,existed:saved.existed,localOnly:!latest.access};
  });
}
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  if(!sender.tab || !/^https?:\/\//.test(sender.tab.url||''))return false;
  const work=async()=>{
    if(message.type==='nuance:dictionary'){
      const text=typeof message.text==='string'?message.text.trim():'';
      if(!text||text.length>1200)throw new Error('请选择 1～1200 个字符');
      const context=typeof message.context==='string'?message.context.slice(0,3000):'';
      const state=await readState();let response;
      try{response=await fetch(`${MODEL_ORIGIN}/dictionary`,{method:'POST',headers:{'Content-Type':'application/json',...(state.access?{'x-tutor-key':state.access}:{})},body:JSON.stringify({text,context}),signal:AbortSignal.timeout(200000)});}
      catch(_){throw new Error('请确认本机模型服务运行并连通内网，再重试');}
      const value=await response.json();if(!response.ok)throw new Error(value.error||'查询失败');
      const entry=NuanceDictionary.validate(value);if(!entry)throw new Error('返回的用法内容不完整');
      return {ok:true,entry};
    }
    if(message.type==='nuance:save-dictionary')return serialized(async()=>{
      const text=typeof message.text==='string'?message.text.trim():'';
      const context=typeof message.context==='string'?message.context.slice(0,3000):'';
      const state=await readState();
      const result=NuanceDictionary.save(state.corrections,text,message.entry,context,{title:sender.tab.title,url:NuanceCapture.cleanUrl(sender.tab.url)},Date.now());
      if(!result.existed){await chrome.storage.local.set({corrections:result.map,nuanceCaptureSyncPending:true});requestSync();}
      return {ok:true,existed:result.existed,localOnly:!state.access};
    });
    if(message.type==='nuance:open-library'){await chrome.tabs.create({url:chrome.runtime.getURL('collection.html')});return {ok:true};}
    if(message.type==='nuance:feedback-text'){
      const text=typeof message.text==='string'?message.text.trim():'';
      if(text.length<20||text.length>20000)throw new Error('请选中包含原表达与调整的内容（20～20000 字符）');
      const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));
      const id=Array.from(new Uint8Array(digest),x=>x.toString(16).padStart(2,'0')).join(''),key='feedback:'+id;
      const state=await readState();
      if(Object.hasOwn(state.corrections,key))return {ok:true,item:state.corrections[key],existed:true,localOnly:!state.access};
      let response;
      try{response=await fetch(`${MODEL_ORIGIN}/feedback`,{method:'POST',headers:{'Content-Type':'application/json',...(state.access?{'x-tutor-key':state.access}:{})},body:JSON.stringify({text}),signal:AbortSignal.timeout(200000)});}
      catch(_){throw new Error('本机模型服务暂不可用，请确认后台服务与内网连接后重试');}
      const result=await response.json();if(!response.ok)throw new Error(result.error||'提取失败，没有保存');
      const data=NuanceFeedback.validate(result,text);if(!data)throw new Error('无法与选中的原文核对，没有保存');
      return serialized(async()=>{
        const fresh=await readState();
        if(!Object.hasOwn(fresh.corrections,key)){
          const item=NuanceFeedback.session(data,text,sender.tab.title||'网页中的表达调整',id,Date.now());
          item.sourceUrl=NuanceCapture.cleanUrl(sender.tab.url);fresh.corrections[key]=item;
        }
        await chrome.storage.local.set({corrections:fresh.corrections,nuanceCaptureSyncPending:true});requestSync();
        return {ok:true,item:fresh.corrections[key],localOnly:!fresh.access};
      });
    }
    if(message.type==='nuance:feedback-image'){
      const image=message.image;
      if(typeof image!=='string'||image.length>7000000||!/^data:image\/(png|jpeg|webp);base64,/.test(image))throw new Error('请使用不超过 5 MB 的图片');
      const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(image));
      const id=Array.from(new Uint8Array(digest),x=>x.toString(16).padStart(2,'0')).join(''),key='feedback-image:'+id;
      const state=await readState();
      if(Object.hasOwn(state.corrections,key))return {ok:true,item:state.corrections[key],existed:true};
      const response=await fetch(`${MODEL_ORIGIN}/feedback-image`,{method:'POST',headers:{'Content-Type':'application/json',...(state.access?{'x-tutor-key':state.access}:{})},body:JSON.stringify({image}),signal:AbortSignal.timeout(110000)});
      const result=await response.json();if(!response.ok)throw new Error(result.error||'截图识别失败');
      const data=NuanceFeedback.validate(result,result.extractedText);if(!data)throw new Error('识别内容不完整，没有保存');
      return serialized(async()=>{
        const fresh=await readState();
        if(!Object.hasOwn(fresh.corrections,key))fresh.corrections[key]=NuanceFeedback.session(data,result.extractedText,'截图中的表达调整',id,Date.now());
        await chrome.storage.local.set({corrections:fresh.corrections,nuanceCaptureSyncPending:true});requestSync();
        return {ok:true,item:fresh.corrections[key]};
      });
    }
    if(message.type==='nuance:capture')return capture(message,sender);
    if(message.type==='nuance:practice'){
      const state=await readState();
      const item=typeof message.key==='string'&&Object.hasOwn(state.corrections,message.key)?state.corrections[message.key]:null;
      if(!item)throw new Error('这条表达已不存在');
      const page=NuanceLearning.stateOf(item)==='active'?`quiz.html?capture=${encodeURIComponent(item.captureId || "")}`:'collection.html';
      await chrome.tabs.create({url:chrome.runtime.getURL(page)});return {ok:true};
    }
    if(message.type==='nuance:edit-cue')return serialized(async()=>{
      const state=await readState(),item=typeof message.key==='string'&&Object.hasOwn(state.corrections,message.key)?state.corrections[message.key]:null;
      if(!item)throw new Error('这条表达已不存在');
      const cue=typeof message.cue==='string'?message.cue.trim():'';
      if(!cue||cue.length>700)throw new Error('情境不能为空，最多 700 个字符');
      const meaning=typeof message.personalContext==='string'?message.personalContext.trim():item.personalContext;
      if(!meaning||meaning.length>700)throw new Error('使用情境不能为空，最多 700 个字符');
      item.situation=cue;item.personalContext=meaning;item.savedAt=Date.now();
      await chrome.storage.local.set({corrections:state.corrections,nuanceCaptureSyncPending:true});
      requestSync();return {ok:true};
    });
    return {ok:false,error:'未知操作'};
  };
  work().then(respond,error=>respond({ok:false,error:error.message}));return true;
});
