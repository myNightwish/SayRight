// The extension uses the existing worker. The local web reader uses the same model and sync helpers.
let mutation=Promise.resolve();
function edit(action){const work=mutation.then(action);mutation=work.catch(()=>{});return work;}
function read(){return JSON.parse(localStorage.getItem('corrections')||'{}');}
function write(map){localStorage.setItem('corrections',JSON.stringify(map));window.NuanceSync?.syncSoon();}
async function request(path,body){
 const response=await fetch(`${window.NUANCE_MODEL_ORIGIN||location.origin}/${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(200000)});
 const result=await response.json();if(!response.ok)throw Error(result.error||'请求失败');return result;
}
export async function sendFromReader(message){
 if(globalThis.chrome?.runtime?.id)return chrome.runtime.sendMessage(message);
 try{
  const text=typeof message.text==='string'?message.text.trim():'',context=typeof message.context==='string'?message.context.slice(0,3000):'';
  const source=NuancePdfSource.validate(message.pdfSource);
  if(message.type==='nuance:dictionary'){const entry=NuanceDictionary.validate(await request('dictionary',{text,context}));if(!entry)throw Error('用法解释不完整');return {ok:true,entry};}
  if(message.type==='nuance:save-dictionary')return edit(()=>{const result=NuanceDictionary.save(read(),text,message.entry,context,{title:source?`${source.fileName} · 第 ${source.page} 页`:'PDF',url:''},Date.now());if(!result.existed){NuancePdfSource.attach(result.item,source);write(result.map);}return {ok:true,existed:result.existed};});
  if(message.type==='nuance:capture'){
   const value=await request('capture',{text,context});const generated=NuanceCapture.validate(value,text);if(!generated)throw Error('情境不完整，没有保存');
   return edit(async()=>{const result=NuanceCapture.captureInto(read(),{text,title:'PDF'},generated,Date.now());if(!result.existed){NuancePdfSource.attach(result.item,source);result.item.input=context||text;}write(result.map);await NuanceQueueStore.run({type:'reconcile'});return {ok:true,key:result.key,text:result.item.better,personalContext:result.item.personalContext,practiceCue:result.item.situation,active:result.active,existed:result.existed};});
  }
  if(message.type==='nuance:feedback-text'){
   const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));const id=Array.from(new Uint8Array(hash),x=>x.toString(16).padStart(2,'0')).join(''),key='feedback:'+id;
   const prior=read()[key];if(prior)return {ok:true,item:prior,existed:true};
   const raw=await request('feedback',{text}),data=NuanceFeedback.validate(raw,text);if(!data)throw Error('无法核对对比原文，没有保存');
   return edit(()=>{const map=read();if(!map[key]){map[key]=NuancePdfSource.attach(NuanceFeedback.session(data,text,'PDF 表达调整',id,Date.now()),source);write(map);}return {ok:true,item:map[key]};});
  }
  if(message.type==='nuance:edit-cue')return edit(()=>{const map=read(),item=Object.hasOwn(map,message.key)?map[message.key]:null;if(!item)throw Error('表达不存在');if(!message.cue?.trim()||message.cue.length>700||!message.personalContext?.trim()||message.personalContext.length>700)throw Error('情境不能为空，最多 700 个字符');item.situation=message.cue.trim();item.personalContext=message.personalContext.trim();item.savedAt=Date.now();write(map);return {ok:true};});
  if(message.type==='nuance:practice'){location.href='quiz.html?capture='+encodeURIComponent(read()[message.key]?.captureId||'');return {ok:true};}
  if(message.type==='nuance:open-library'){window.open('collection.html','_blank','noopener');return {ok:true};}
  throw Error('此操作请使用插件的网页入口');
 }catch(error){return {ok:false,error:error.message};}
}
