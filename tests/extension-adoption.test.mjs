import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import {webcrypto} from 'node:crypto';
const read=file=>fs.readFileSync(file,'utf8');
const feedback={correct:true,patternUsed:true,explanation:'用法正确。',suggestion:''};
function fixture(){
 const ctx={crypto:webcrypto};vm.createContext(ctx);for(const f of ['learning.js','queue-core.js'])vm.runInContext(read(f),ctx);
 let value=ctx.NuanceQueue.apply({a:{better:'knock something over',studyState:'active',note:'keep',savedAt:1}},{},{type:'reconcile'},100);
 value=ctx.NuanceQueue.apply(value.corrections,value.drillState,{type:'attempt',key:'a',answer:'pipi knocked my glass over',feedback},200);
 return {value,action:{type:'adopt',key:'a',attemptId:value.attemptId}};
}
function client(sendMessage){const ctx={document:{},chrome:{storage:{local:{}},runtime:{sendMessage}}};vm.createContext(ctx);vm.runInContext(read('queue-store.js'),ctx);return ctx.NuanceQueueStore;}
test('an older extension worker produces an explicit reload instruction before any mutation',async()=>{
 for(const reply of [undefined,{ok:true,queueProtocol:1},{ok:true,queueProtocol:2},{ok:true}]){let calls=0;const store=client(async message=>{calls++;assert.equal(message.type,'nuance:queue-capabilities');return reply;});await assert.rejects(store.run({type:'adopt',key:'a',attemptId:'x'}),/chrome:\/\/extensions/);assert.equal(calls,1);}
 const disconnected=client(async()=>{throw Error('Receiving end does not exist');});await assert.rejects(disconnected.run({type:'adopt'}),/原句和造句仍保留/);
});
test('a worker claiming success without the updated main sentence is rejected',async()=>{
 const {value,action}=fixture();const store=client(async message=>message.type==='nuance:queue-capabilities'?{ok:true,queueProtocol:3}:{ok:true,...value});
 await assert.rejects(store.run(action),/主句未能保存/);
});
function worker({dropWrites=false}={}){
 const {value,action}=fixture();const data={corrections:structuredClone(value.corrections),drillState:structuredClone(value.drillState)};let listener;
 const ctx={console,crypto:webcrypto,importScripts(){},indexedDB:{open(){const request={};queueMicrotask(()=>{request.result={close(){},transaction(){const tx={objectStore:()=>({get(){const r={};queueMicrotask(()=>{r.onsuccess?.();queueMicrotask(()=>tx.oncomplete?.());});return r;},put(){}})};return tx;}};request.onsuccess?.();});return request;}},chrome:{storage:{local:{get:async keys=>structuredClone(Object.fromEntries(keys.map(k=>[k,data[k]]))),set:async values=>{if(!dropWrites)Object.assign(data,structuredClone(values));}},onChanged:{addListener(){}}},alarms:{create(){},clear(){},onAlarm:{addListener(){}}},runtime:{getURL:p=>'chrome-extension://test/'+p,onMessage:{addListener(fn){listener=fn;}}}}};
 vm.createContext(ctx);for(const f of ['learning.js','queue-core.js','queue-store.js','extension-background.js'])vm.runInContext(read(f),ctx);
 const send=(message,sender={url:'chrome-extension://test/collection.html#queue'})=>new Promise(resolve=>{if(listener(message,sender,resolve)===false)resolve(undefined);});
 return {action,data,send};
}
test('the complete extension page → worker → storage path saves the reviewed sentence and preserves the original',async()=>{
 const w=worker(),result=await client(w.send).run(w.action);
 assert.equal(result.corrections.a.better,'pipi knocked my glass over');assert.equal(w.data.corrections.a.originalBetter,'knock something over');assert.equal(w.data.corrections.a.note,'keep');assert.equal(w.data.corrections.a.adoptedAttemptId,w.action.attemptId);
 const history=Object.values(w.data.drillState).filter(x=>x.kind==='practice-adoption');assert.equal(history.length,1);assert.equal(history[0].before,'knock something over');
 assert.equal(await w.send({type:'nuance:queue-capabilities'},{url:'https://example.com/collection.html'}),undefined);
});
test('a write that does not persist cannot produce a successful replacement response',async()=>{
 const w=worker({dropWrites:true});await assert.rejects(client(w.send).run(w.action),/主句未能保存/);assert.equal(w.data.corrections.a.better,'knock something over');
});
