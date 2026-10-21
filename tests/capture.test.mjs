import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const ctx={window:{},URL};
vm.createContext(ctx);
for(const file of ['learning.js','capture-core.js'])vm.runInContext(fs.readFileSync(file,'utf8'),ctx);
const core=ctx.window.NuanceCapture;
const selection={text:'The moment I sell a stock, it shoots up.',title:'Daily English',url:'https://example.com/chat?token=private#turn'};
const generated={personalContext:'想吐槽自己一卖股票它就涨',practiceCue:'You sold a stock, and its price rose immediately. Tell a friend what happened.',transferCue:'You bought a phone, and its price dropped the next day. Tell a friend about it.'};
test('capture preserves selection, creates cues, strips URL secrets, and activates without a form',()=>{
 const out=core.captureInto({},selection,generated,100);
 assert.equal(out.item.better,selection.text);assert.equal(out.item.situation,generated.practiceCue);assert.equal(out.item.studyState,'active');
 assert.equal(out.item.sourceUrl,'https://example.com/chat');assert.equal(out.item.personalContext,generated.personalContext);
 assert.equal(out.item.situations[0],generated.transferCue);assert.equal(out.item.createdAt,100);assert.ok(out.item.captureId);assert.notEqual(out.item.captureId,selection.text.toLowerCase());
});
test('duplicate capture preserves prior wording, cues, notes, timestamps and schedule references',()=>{
 const prior={better:selection.text,situation:'My own prompt',note:'keep',createdAt:1,savedAt:10,studyState:'archived',situations:['My transfer']};
 const key=selection.text.toLowerCase();const map={[key]:prior};const out=core.captureInto(map,selection,generated,100);
 assert.equal(out.existed,true);assert.equal(out.item.studyState,'active');assert.equal(out.item.note,'keep');
 assert.equal(out.item.situation,'My own prompt');assert.equal(out.item.createdAt,1);assert.equal(out.item.situations[0],'My transfer');
 assert.equal(map[key].studyState,'archived');
});
test('full active set defers new discovery without evicting or deleting existing expressions',()=>{
 const map=Object.fromEntries(Array.from({length:20},(_,i)=>[i,{studyState:'active'}]));
 const out=core.captureInto(map,selection,generated,100);assert.equal(out.active,false);assert.equal(out.item.studyState,'inbox');assert.equal(Object.keys(out.map).length,21);
});
test('unreliable or answer-leaking prompts cannot be silently saved',()=>{
 assert.ok(core.validate(generated,selection.text));
 assert.equal(core.validate({...generated,practiceCue:selection.text},selection.text),null);
 assert.equal(core.validate({...generated,personalContext:''},selection.text),null);
 assert.throws(()=>core.captureInto({},{text:'__proto__'},generated,100));
});
test('cloud merge retains edits made during sync and respects newer deletions',()=>{
 const out=core.mergeState({corrections:{old:{savedAt:1}},tombstones:{old:5}}, {corrections:{fresh:{savedAt:10},old:{savedAt:1}},tombstones:{}});
 assert.equal(out.corrections.old,undefined);assert.equal(out.corrections.fresh.savedAt,10);
});
test('server parser accepts JSON fences and rejects exposed answers or malformed structures',()=>{
 const source=fs.readFileSync('tutor-server.mjs','utf8');const c={};vm.createContext(c);
 vm.runInContext(source.slice(source.indexOf('function parseCaptureJson'),source.indexOf('async function handleCapture')),c);
 assert.ok(c.parseCaptureJson('```json\n'+JSON.stringify(generated)+'\n```',selection.text));
 assert.equal(c.parseCaptureJson(JSON.stringify({...generated,transferCue:selection.text}),selection.text),null);
 assert.equal(c.parseCaptureJson('oops',selection.text),null);
});
function worker() {
 const data={corrections:{},sceneSaves:{},sceneScripts:{},drillState:{}};let listener;const calls=[];
 const c={URL,AbortSignal,console,importScripts(){},NuanceLearning:ctx.window.NuanceLearning,NuanceCapture:core,
  fetch:async(url,opts)=>{calls.push({url,body:JSON.parse(opts.body)});return {ok:true,json:async()=>generated};},
  chrome:{storage:{local:{get:async keys=>Object.fromEntries(keys.map(k=>[k,data[k]])),set:async values=>Object.assign(data,values)},onChanged:{addListener(){}}},alarms:{create(){},clear:async()=>{},onAlarm:{addListener(){}}},runtime:{onMessage:{addListener(f){listener=f;}},getURL:p=>'chrome-extension://test/'+p},tabs:{create:async()=>{}}}};
 vm.createContext(c);vm.runInContext(fs.readFileSync('extension-background.js','utf8'),c);
 return {data,calls,send:(message,sender={tab:{url:selection.url,title:selection.title}})=>new Promise(resolve=>{if(listener(message,sender,resolve)===false)resolve(null);})};
}
test('background only calls local model after capture message; saves to plugin storage without leaking credentials',async()=>{
 const w=worker();assert.equal(w.calls.length,0);
 const result=await w.send({type:'nuance:capture',text:selection.text,context:'Original sentence and correction'});
 assert.equal(result.ok,true);assert.equal(w.calls.length,1);assert.equal(w.calls[0].url,'http://127.0.0.1:48773/capture');
 assert.equal(w.calls[0].body.context,'Original sentence and correction');assert.equal(result.localOnly,true);
 assert.equal(Object.values(w.data.corrections)[0].better,selection.text);
 assert.equal(await w.send({type:'nuance:capture',text:selection.text},{}),null);
});
test('re-selecting existing expression avoids another model call and preserves enriched context',async()=>{
 const w=worker();await w.send({type:'nuance:capture',text:selection.text,context:'context'});
 const result=await w.send({type:'nuance:capture',text:selection.text,context:'context'});
 assert.equal(result.existed,true);assert.equal(w.calls.length,1);
});
test('optional context correction changes prompts without rewriting the learned expression',async()=>{
 const w=worker();const saved=await w.send({type:'nuance:capture',text:selection.text,context:'context'});
 const updated=await w.send({type:'nuance:edit-cue',key:saved.key,cue:'Tell a friend about your trading frustration.',personalContext:'想说我卖出后就涨的无奈'});
 assert.equal(updated.ok,true);const item=w.data.corrections[saved.key];
 assert.equal(item.better,selection.text);assert.equal(item.personalContext,'想说我卖出后就涨的无奈');
});
test('invalid record keys cannot modify prototype objects',async()=>{
 const w=worker();const result=await w.send({type:'nuance:edit-cue',key:'__proto__',cue:'bad',personalContext:'bad'});
 assert.equal(result.ok,false);assert.equal({}.situation,undefined);
});
