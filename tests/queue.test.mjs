import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import {webcrypto} from 'node:crypto';
const c={crypto:webcrypto};vm.createContext(c);for(const f of ['learning.js','queue-core.js'])vm.runInContext(fs.readFileSync(f,'utf8'),c);
const Q=c.NuanceQueue,L=c.NuanceLearning;
const item=(state='inbox')=>({better:'An expression',studyState:state,note:'my note',sourceLabel:'PDF p8',stars:1,createdAt:10,savedAt:20});
const run=(s,a,time)=>Q.apply(s.corrections,s.drillState,a,time);
function storageHarness({backupFails=false,duringBackup}={}){
 const storage=new Map([['corrections',JSON.stringify({a:item()})],['drillState',JSON.stringify({'a::replay':{box:3,savedAt:1}})]]);let backups=0;
 const env={crypto:webcrypto,localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},indexedDB:{open(){const request={};queueMicrotask(()=>{
  if(backupFails){request.onerror?.();return;}
  request.result={close(){},transaction(){const tx={objectStore(){return {get(){const read={};queueMicrotask(()=>{read.onsuccess?.();duringBackup?.(storage);queueMicrotask(()=>tx.oncomplete?.());});return read;},put(){backups++;}};}};return tx;}};request.onsuccess?.();
 });return request;}}};vm.createContext(env);for(const file of ['learning.js','queue-core.js','queue-store.js'])vm.runInContext(fs.readFileSync(file,'utf8'),env);return {env,storage,backups:()=>backups};
}
test('a failed migration backup stops all writes to the collection and progress',async()=>{
 const h=storageHarness({backupFails:true});const original=[...h.storage];await assert.rejects(h.env.NuanceQueueStore.runLocal({type:'state',key:'a',state:'active'}),/备份/);assert.deepEqual([...h.storage],original);
});
test('saving after backup retains a concurrently edited note and new capture',async()=>{
 const h=storageHarness({duringBackup:storage=>{const map=JSON.parse(storage.get('corrections'));map.a.note='edited during backup';map.a.savedAt=Date.now()+500;map.b={...item(),better:'New capture'};storage.set('corrections',JSON.stringify(map));}});
 await h.env.NuanceQueueStore.runLocal({type:'state',key:'a',state:'active'});const map=JSON.parse(h.storage.get('corrections'));
 assert.equal(h.backups(),1);assert.equal(map.a.studyState,'active');assert.equal(map.a.note,'edited during backup');assert.equal(map.b.better,'New capture');assert.equal(JSON.parse(h.storage.get('drillState'))['a::replay'].box,3);
});


test('105 marked expressions yield the latest ten and 95 candidates, with no material removed',()=>{
 const map=Object.fromEntries(Array.from({length:105},(_,i)=>['k'+i,{...item('active'),better:'Expression '+i,queueJoinedAt:i+1}]));const before=JSON.stringify(map);
 const s=Q.apply(map,{'k0::replay':{box:5,savedAt:1}},{type:'reconcile'},1000);
 assert.equal(s.snapshot.items.length,10);assert.equal(s.snapshot.candidates.length,95);assert.equal(s.snapshot.items[0].key,'k104');assert.equal(s.snapshot.items[9].key,'k95');assert.equal(Object.keys(s.corrections).length,105);assert.equal(JSON.stringify(map),before);assert.equal(s.drillState['k0::replay'].box,5);
 const again=run(s,{type:'reconcile'},2000);assert.equal(again.changed,false);
});
test('removing a card leaves a hole through refresh; exactly one confirmed candidate fills it',()=>{
 let s=Q.apply(Object.fromEntries(Array.from({length:12},(_,i)=>['k'+i,{...item('active'),queueJoinedAt:i+1}])),{},{type:'reconcile'},100);
 const removed=s.snapshot.items[0].key,candidate=s.snapshot.candidates[0].key;
 s=run(s,{type:'state',key:removed,state:'inbox'},200);s=run(s,{type:'reconcile'},300);
 assert.equal(s.snapshot.items.length,9);assert.ok(!s.snapshot.items.some(x=>x.key===candidate));assert.equal(s.corrections[removed].note,'my note');
 s=run(s,{type:'admit',key:candidate},400);assert.equal(s.snapshot.items.length,10);assert.ok(s.snapshot.items.some(x=>x.key===candidate));
 assert.throws(()=>run(s,{type:'admit',key:s.snapshot.candidates[0].key},500),/10/);
});
test('newly marked expressions do not displace a pinned card or fill a vacancy',()=>{
 let s=Q.apply({a:item('active'),b:item()},{},{type:'reconcile'},100);s=run(s,{type:'state',key:'b',state:'active'},200);
 assert.equal(s.snapshot.items.length,1);assert.equal(s.snapshot.items[0].key,'a');assert.equal(s.snapshot.candidates[0].key,'b');
});
test('all current self-ratings must reach four; empty windows never unlock dialogue',()=>{
 let s=Q.apply({a:item('active'),b:item('active')},{},{type:'reconcile'},100);assert.equal(s.snapshot.ready,false);
 s=run(s,{type:'rate',key:'a',score:5},200);assert.equal(s.snapshot.ready,false);
 s=run(s,{type:'rate',key:'b',score:4},300);assert.equal(s.snapshot.ready,true);
 s=run(s,{type:'rate',key:'a',score:3},400);assert.equal(s.snapshot.ready,false);
 assert.throws(()=>run(s,{type:'rate',key:'a',score:6},450),/1～5/);
 s=run(s,{type:'end',keys:['a','b']},500);assert.equal(s.snapshot.ready,false);assert.equal(s.snapshot.items.length,0);
});
test('AI feedback is saved independently and cannot raise self-ratings',()=>{
 let s=Q.apply({a:item('active')},{},{type:'reconcile'},100);
 s=run(s,{type:'attempt',key:'a',answer:'I have a lot on my plate this week.',feedback:{correct:true,patternUsed:true,explanation:'用法正确。',suggestion:''}},200);
 assert.equal(s.snapshot.attempts[0].feedback.correct,true);assert.equal(s.snapshot.items[0].selfRating,0);assert.equal(s.snapshot.ready,false);assert.equal(s.drillState['a::replay'],undefined);
});
test('confirming an unrated candidate locks dialogue again without resetting other scores',()=>{
 let s=Q.apply({a:item('active'),b:item()},{},{type:'reconcile'},100);s=run(s,{type:'rate',key:'a',score:4},200);assert.equal(s.snapshot.ready,true);
 s=run(s,{type:'state',key:'b',state:'active'},300);assert.equal(s.snapshot.ready,true);
 s=run(s,{type:'admit',key:'b'},400);assert.equal(s.snapshot.ready,false);assert.equal(s.snapshot.items.find(x=>x.key==='a').selfRating,4);
});
test('ending a batch archives only its members, leaves candidates and history, and requires an explicit next batch',()=>{
 let s=Q.apply(Object.fromEntries(Array.from({length:12},(_,i)=>['k'+i,{...item('active'),queueJoinedAt:i+1}])),{},{type:'reconcile'},100);const old=s.snapshot.windowId,keys=s.snapshot.items.map(x=>x.key);
 s=run(s,{type:'end',keys},200);assert.equal(s.snapshot.items.length,0);assert.equal(s.snapshot.candidates.length,2);assert.equal(s.snapshot.history[0].members.size,10);
 s=run(s,{type:'reconcile'},300);assert.equal(s.snapshot.items.length,0);
 s=run(s,{type:'new-window'},400);assert.notEqual(s.snapshot.windowId,old);assert.equal(s.snapshot.items.length,2);assert.equal(Object.keys(s.corrections).length,12);
});
test('newer notes and stars cannot undo another device’s archive',()=>{
 const a={...item('archived'),queueChangedAt:200,savedAt:200},b={...item('active'),queueChangedAt:100,note:'new note',stars:5,savedAt:300};const m=L.mergeVersions(a,b);assert.equal(m.studyState,'archived');assert.equal(m.note,'new note');assert.equal(m.stars,5);
});
test('editing the reference invalidates a previous self-rating',()=>{
 let s=Q.apply({a:item('active')},{},{type:'reconcile'},100);s=run(s,{type:'rate',key:'a',score:5},200);s.corrections.a.better='A different expression';assert.equal(Q.snapshot(s.corrections,s.drillState).ready,false);
});

test('a response for a changed reference or window cannot be attached to another card',()=>{
 const s=Q.apply({a:item('active')},{},{type:'reconcile'},100);
 assert.throws(()=>run(s,{type:'attempt',key:'a',answer:'My new sentence.',reference:'Old expression',windowId:s.snapshot.windowId},200),/变化/);
 assert.throws(()=>run(s,{type:'attempt',key:'a',answer:'My new sentence.',reference:s.corrections.a.better,windowId:'old-window'},200),/变化/);
 assert.equal(Q.snapshot(s.corrections,s.drillState).attempts.length,0);
});
test('a stale end confirmation cannot close a different batch',()=>{
 let s=Q.apply({a:item('active'),b:item()},{},{type:'reconcile'},100);const old=s.snapshot.windowId;
 s=run(s,{type:'end',roundIds:[old]},200);s=run(s,{type:'state',key:'b',state:'active'},300);s=run(s,{type:'new-window'},400);
 assert.throws(()=>run(s,{type:'end',keys:['a'],roundIds:[old]},500),/变化/);assert.equal(s.snapshot.items[0].key,'b');assert.equal(s.snapshot.closed,false);
});

test('window membership and ratings always use storage keys over stale embedded keys',()=>{
 let s=Q.apply({real:{...item('active'),key:'stale-embedded-key'}},{},{type:'reconcile'},100);
 assert.equal(s.snapshot.items[0].key,'real');s=run(s,{type:'rate',key:'real',score:4},200);assert.equal(s.snapshot.ready,true);assert.equal(s.snapshot.items[0].key,'real');
});

const passed={correct:true,patternUsed:true,explanation:'搭配和用法正确。',suggestion:''};
function withAttempt(state,answer='My own example',feedback=passed){return run(state,{type:'attempt',key:'a',answer,feedback},200);}
test('adopting an approved sentence changes the main expression but preserves identity, reference and history',()=>{
 let s=Q.apply({a:item('active')},{'a::replay':{box:3,savedAt:1}},{type:'reconcile'},100);
 s=run(s,{type:'rate',key:'a',score:4},150);s=withAttempt(s);const id=s.attemptId;
 s=run(s,{type:'adopt',key:'a',attemptId:id},300);
 assert.equal(s.corrections.a.better,'My own example');assert.equal(s.corrections.a.originalBetter,'An expression');
 assert.equal(s.corrections.a.note,'my note');assert.equal(s.corrections.a.sourceLabel,'PDF p8');assert.equal(s.corrections.a.createdAt,10);assert.equal(s.corrections.a.stars,1);
 assert.equal(Object.keys(s.corrections).length,1);assert.equal(s.snapshot.items[0].key,'a');assert.equal(s.snapshot.items[0].selfRating,0);assert.equal(s.snapshot.ready,false);
 assert.equal(s.snapshot.attempts[0].reference,'An expression');assert.equal(s.snapshot.attempts[0].answer,'My own example');assert.equal(s.snapshot.replacements[0].before,'An expression');assert.equal(s.drillState['a::replay'].box,3);
 const again=run(s,{type:'adopt',key:'a',attemptId:id},400);assert.equal(again.changed,false);assert.equal(again.snapshot.replacements.length,1);
});
test('failed or off-pattern sentences cannot replace a card, and an unreviewed draft is never accepted',()=>{
 const start=Q.apply({a:item('active')},{},{type:'reconcile'},100);
 for(const f of [{...passed,correct:false},{...passed,patternUsed:false}]){const s=withAttempt(start,'A draft',f);assert.throws(()=>run(s,{type:'adopt',key:'a',attemptId:s.attemptId,answer:'Unreviewed override'},300),/目标用法/);assert.equal(s.corrections.a.better,'An expression');}
 let s=withAttempt(start);s=run(s,{type:'adopt',key:'a',attemptId:s.attemptId,answer:'Unreviewed override'},300);assert.equal(s.corrections.a.better,'My own example');
});
test('an approved sentence for another card or outdated reference cannot be adopted',()=>{
 let s=withAttempt(Q.apply({a:item('active'),b:item('active')},{},{type:'reconcile'},100));
 assert.throws(()=>run(s,{type:'adopt',key:'b',attemptId:s.attemptId},300),/这张卡片/);
 s.corrections.a={...s.corrections.a,better:'Changed reference'};assert.throws(()=>run(s,{type:'adopt',key:'a',attemptId:s.attemptId},300),/已变化/);
});
test('multiple adoptions retain the first reference and each version rather than overwriting them',()=>{
 let s=withAttempt(Q.apply({a:item('active')},{},{type:'reconcile'},100));s=run(s,{type:'adopt',key:'a',attemptId:s.attemptId},300);
 s=run(s,{type:'attempt',key:'a',answer:'A second personal example',feedback:passed},400);s=run(s,{type:'adopt',key:'a',attemptId:s.attemptId},500);
 assert.equal(s.corrections.a.originalBetter,'An expression');assert.equal(s.corrections.a.better,'A second personal example');assert.equal(s.snapshot.replacements.length,2);assert.equal(s.snapshot.attempts.length,2);
});
test('newer notes and stars cannot silently revert an adopted expression during sync',()=>{
 const adopted={...item('active'),better:'My sentence',originalBetter:'Original',adoptedAttemptId:'attempt-1',expressionChangedAt:200,savedAt:200};
 const stale={...item('archived'),better:'Original',note:'A newer note',stars:5,queueChangedAt:250,savedAt:300};
 for(const [a,b] of [[adopted,stale],[stale,adopted]]){const out=L.mergeVersions(a,b);assert.equal(out.better,'My sentence');assert.equal(out.originalBetter,'Original');assert.equal(out.note,'A newer note');assert.equal(out.stars,5);assert.equal(out.studyState,'archived');}
});

test('an explicit replacement advances beyond an existing expression version from a device with a faster clock',()=>{
 let s=Q.apply({a:{...item('active'),expressionChangedAt:900000,adoptedAttemptId:'old-id'}},{},{type:'reconcile'},100);
 s=run(s,{type:'attempt',key:'a',answer:'My approved example',feedback:passed},200);const id=s.attemptId;
 s=run(s,{type:'adopt',key:'a',attemptId:id},300);assert.ok(s.corrections.a.expressionChangedAt>900000);
 const merged=L.mergeVersions({...item('active'),expressionChangedAt:900000},s.corrections.a);assert.equal(merged.better,'My approved example');
});

test('a reference edited while the replacement backup is running is retained instead of overwritten',async()=>{
 let changeReference=false;
 const h=storageHarness({duringBackup:storage=>{if(!changeReference)return;const map=JSON.parse(storage.get('corrections'));map.a.better='Edited in another page';map.a.savedAt=Date.now()+100;storage.set('corrections',JSON.stringify(map));}});
 await h.env.NuanceQueueStore.runLocal({type:'state',key:'a',state:'active'});
 const checked=await h.env.NuanceQueueStore.runLocal({type:'attempt',key:'a',answer:'Approved personal example',feedback:passed});changeReference=true;
 await assert.rejects(h.env.NuanceQueueStore.runLocal({type:'adopt',key:'a',attemptId:checked.attemptId}),/未覆盖新内容/);
 assert.equal(JSON.parse(h.storage.get('corrections')).a.better,'Edited in another page');
 assert.equal(Object.values(JSON.parse(h.storage.get('drillState'))).filter(x=>x.kind==='practice-adoption').length,0);
});

test('dialogue materials use an adopted sentence without leaking its obsolete context or skeleton',()=>{
 let s=Q.apply({a:{...item('active'),personalContext:'Old context',construct:'Old skeleton',chunks:[{text:'Old chunk'}]}},{},{type:'reconcile'},100);
 s=withAttempt(s,'I knocked my coffee over');s=run(s,{type:'adopt',key:'a',attemptId:s.attemptId},300);s=run(s,{type:'rate',key:'a',score:4},400);
 const materials=Q.dialogueMaterials(s.snapshot);assert.equal(materials[0].expression,'I knocked my coffee over');assert.equal(materials[0].intent,'');assert.equal(materials[0].construct,'');assert.equal(materials[0].personalized,true);
 assert.equal(s.corrections.a.personalContext,'Old context');assert.equal(s.corrections.a.construct,'Old skeleton');
 const signature=Q.dialogueSignature(s.snapshot);s=run(s,{type:'rate',key:'a',score:5},500);assert.equal(Q.dialogueSignature(s.snapshot),signature);
 s=run(s,{type:'rate',key:'a',score:3},600);assert.notEqual(Q.dialogueSignature(s.snapshot),signature);
});

test('further AI sentence checks after adoption also use the current example without stale metadata',async()=>{
 const h=storageHarness();h.env.AbortSignal=AbortSignal;
 const map=JSON.parse(h.storage.get('corrections'));map.a.personalContext='Old scene';map.a.construct='Old skeleton';h.storage.set('corrections',JSON.stringify(map));
 await h.env.NuanceQueueStore.runLocal({type:'state',key:'a',state:'active'});
 const checked=await h.env.NuanceQueueStore.runLocal({type:'attempt',key:'a',answer:'my personal example',feedback:passed});
 await h.env.NuanceQueueStore.runLocal({type:'adopt',key:'a',attemptId:checked.attemptId});
 let body;h.env.fetch=async(_,options)=>{body=JSON.parse(options.body);return {ok:true,json:async()=>passed};};
 await h.env.NuanceQueueStore.checkLocal({key:'a',answer:'another personal example'},{origin:'http://127.0.0.1:1'});
 assert.equal(body.reference,'my personal example');assert.equal(body.context,'');assert.equal(body.pattern,'');
});
