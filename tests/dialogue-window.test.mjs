import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
const source=fs.readFileSync('chat.js','utf8');const boot=source.slice(source.indexOf('async function readLearnedWindow()'),source.indexOf('chatSend.addEventListener'));
const rules={};vm.createContext(rules);for(const f of ['learning.js','queue-core.js'])vm.runInContext(fs.readFileSync(f,'utf8'),rules);
async function start(ready,search='?talk=1'){
 let calls=0;const materials=[{key:'current',better:'knock something over',personalContext:'A cat and a glass'}];
 const ctx={conversationGeneration:0,conversationSignature:null,conversationMaterials:null,conversationStale:false,chatThread:{},rehearseCard:null,checklistPanel:null,weakPanel:{classList:{add(){}}},planCalls:[],currentState:{ready,windowId:'batch-a',items:materials},URLSearchParams,location:{search},NuanceQueueStore:{run:async()=>({corrections:{},drillState:{}})},NuanceQueue:{snapshot:()=>ctx.currentState,dialogueMaterials:rules.NuanceQueue.dialogueMaterials,dialogueSignature:rules.NuanceQueue.dialogueSignature},setComposer(value){ctx.composer=value;},setHint(value){ctx.hint=value;},swapBtn:{classList:{add(){}}},restartBtn:{disabled:false},chatScene:{},appendMsg:()=>({wrap:{append(){}}}),document:{querySelector:()=>null,createElement:()=>({}),body:{classList:{add(){}}}},roleTag:{classList:{add(){}}},endBtn:{classList:{remove(){}}},chatInput:{},loadRehearsePlan:async()=>{calls++;ctx.planCalls.push(structuredClone(ctx.conversationMaterials));}};
 vm.createContext(ctx);vm.runInContext(boot,ctx);await ctx.boot();return {ctx,calls};
}
test('legacy daily-chat links cannot call a model before all self-ratings are ready',async()=>{const {ctx,calls}=await start(false);assert.equal(calls,0);assert.equal(ctx.restartBtn.disabled,true);assert.equal(ctx.conversationMaterials,null);});
test('a dialogue for an outdated window is blocked',async()=>{assert.equal((await start(true,'?rehearse=1&window=old-batch')).calls,0);});
test('ready dialogues bind only the learned window and share one scenario mode',async()=>{const {ctx,calls}=await start(true);assert.equal(calls,1);assert.equal(ctx.rehearseMode,true);assert.equal(ctx.talkMode,false);assert.equal(ctx.conversationMaterials.length,1);assert.equal(ctx.conversationMaterials[0].key,'current');assert.equal(ctx.conversationWindow,'batch-a');});

test('extension dialogue pages can read their window through the worker; webpages cannot',async()=>{
 let listener,calls=0;const ctx={console,importScripts(){},NuanceQueueStore:{runLocal:async()=>{calls++;return {ok:true,changed:false,corrections:{},drillState:{}};}},chrome:{storage:{local:{get:async()=>({})},onChanged:{addListener(){}}},alarms:{onAlarm:{addListener(){}}},runtime:{getURL:p=>'chrome-extension://test/'+p,onMessage:{addListener(fn){listener=fn;}}}}};
 vm.createContext(ctx);vm.runInContext(fs.readFileSync('extension-background.js','utf8'),ctx);
 const result=await new Promise(resolve=>{assert.equal(listener({type:'nuance:queue',action:{type:'reconcile'}},{url:'chrome-extension://test/chat.html?rehearse=1'},resolve),true);});
 assert.equal(result.ok,true);assert.equal(calls,1);assert.equal(listener({type:'nuance:queue',action:{type:'reconcile'}},{url:'https://example.com/chat.html'},()=>assert.fail('must not respond')),false);assert.equal(calls,1);
});

test('updated sentences invalidate the old dialogue; restart rereads replacements instead of reusing its plan',async()=>{
 const {ctx}=await start(true);assert.equal(ctx.planCalls[0][0].expression,'knock something over');
 ctx.currentState.items[0]={...ctx.currentState.items[0],better:'I knocked my coffee over at work',adoptedAttemptId:'approved',expressionChangedAt:500,construct:'Old example skeleton',personalContext:'An old unrelated story'};
 assert.equal(await ctx.checkDialogueMaterials(),false);assert.equal(ctx.conversationStale,true);assert.equal(ctx.composer,'waiting');
 await ctx.boot();assert.equal(ctx.planCalls.length,2);assert.equal(ctx.planCalls[1][0].expression,'I knocked my coffee over at work');
 assert.equal(ctx.planCalls[1][0].intent,'');assert.equal(ctx.planCalls[1][0].construct,'');assert.equal(ctx.planCalls[1][0].personalized,true);
 assert.equal(JSON.stringify(ctx.planCalls[1]).includes('old unrelated'),false);assert.equal(ctx.conversationStale,false);
});

test('old and newer asynchronous scene requests cannot overwrite each other',async()=>{
 const load=source.slice(source.indexOf('async function loadRehearsePlan('),source.indexOf('async function readLearnedWindow()'));
 let resolveResponse,startRequest,resets=0;const fetched=new Promise(resolve=>{startRequest=resolve;});const ctx={conversationGeneration:1,rehearsePlan:null,REHEARSE_PLAN_API:'/rehearse-plan',appendMsg:()=>({enEl:{},wrap:{remove(){}}}),pickDueMaterials:async()=>[{expression:'My latest sentence'}],apiHeaders:()=>({}),fetch:()=>new Promise(resolve=>{resolveResponse=resolve;startRequest();}),checkDialogueMaterials:async()=>true,setComposer(){},restartBtn:{disabled:true},renderRehearsePlan(){},resetChat(){resets++;},chatScene:{}};
 vm.createContext(ctx);vm.runInContext(load,ctx);const pending=ctx.loadRehearsePlan();await fetched;ctx.conversationGeneration=2;
 resolveResponse({ok:true,json:async()=>({checklist:[{expression:'My latest sentence'}],opener:'An old response'})});await pending;
 assert.equal(ctx.rehearsePlan,null);assert.equal(resets,0);
});

test('the scene endpoint retries a model plan that reintroduces an old expression',async()=>{
 const server=fs.readFileSync('tutor-server.mjs','utf8');let response,calls=0;
 const material={expression:'i knocked my laptop over during a meeting',intent:'',construct:'',personalized:true};
 const ctx={console,readBody:async()=>({materials:[material]}),sendJson:(_,status,data)=>{response={status,data};},callRehearsePlanClaude:async payload=>{const sent=JSON.parse(payload);assert.equal(sent.materials[0].personalized,true);assert.equal(sent.materials[0].construct,'');assert.equal(sent.materials[0].expression,material.expression);calls++;return JSON.stringify({scene:'Meeting',opener:'What happened at the meeting?',checklist:[{expression:calls===1?'knock something over':material.expression}]});}};
 vm.createContext(ctx);
 vm.runInContext(server.slice(server.indexOf('async function callAndParse('),server.indexOf('const SENTENCE_PRACTICE_PROMPT')),ctx);
 vm.runInContext(server.slice(server.indexOf('function parseRehearsePlanJson('),server.indexOf('// 解析情景对练每轮返回')),ctx);
 vm.runInContext(server.slice(server.indexOf('async function handleRehearsePlan('),server.indexOf('async function handleRehearse(')),ctx);
 await ctx.handleRehearsePlan({},{});assert.equal(calls,2);assert.equal(response.status,200);assert.equal(response.data.checklist[0].expression,material.expression);
});
