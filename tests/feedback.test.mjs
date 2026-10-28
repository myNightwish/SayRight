import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const c={window:{}};vm.createContext(c);
for(const file of ['learning.js','feedback-core.js'])vm.runInContext(fs.readFileSync(file,'utf8'),c);
const core=c.window.NuanceFeedback,learning=c.window.NuanceLearning;
const source=`Your expression: Made a deep research. More natural: Did a ton of research.
Your expression: Have a strong grudge against me. More natural: Have a personal grudge against me.
A polished paragraph:\n> I did a ton of research.\n> Then I bought the stock.`;
const row={before:'Made a deep research',after:'Did a ton of research',kind:'correction',reason:'表达研究活动通常用 do research；research 在这里不可数。',pattern:'do research',practiceCue:'How did you prepare before buying that stock?',transferCue:'How did you prepare before choosing a school?'};
const data={summary:'想向朋友讲述买股票前做了很多准备',originalParagraph:null,polishedParagraph:'I did a ton of research.\nThen I bought the stock.',adjustments:[row,{...row,before:'Have a strong grudge against me',after:'Have a personal grudge against me',kind:'alternative',reason:'这是可选措辞，不把原说法标记为语法错误。',pattern:'have a grudge against someone',practiceCue:'How would you jokingly describe your bad luck?',transferCue:'How would you joke about a computer that keeps crashing?'}]};
test('extracts only grounded contrasts and retains the distinction between errors and style',()=>{
 const result=core.validate(data,source);assert.ok(result);assert.equal(result.adjustments.length,2);
 assert.equal(result.adjustments[1].kind,'alternative');assert.equal(result.originalParagraph,null);
 assert.equal(result.polishedParagraph,data.polishedParagraph);
});
test('does not reconstruct an original paragraph or invent missing comparison fragments',()=>{
 assert.equal(core.validate({...data,originalParagraph:'I made a deep research before buying my stock.'},source).originalParagraph,null);
 assert.equal(core.validate({...data,adjustments:[{...row,before:'I researched badly'}]},source),null);
 assert.equal(core.validate({...data,adjustments:[]},source),null);
});
test('rejects prompts exposing answers and unsupported correction categories',()=>{
 assert.equal(core.validate({...data,adjustments:[{...row,practiceCue:'Say: Did a ton of research'}]},source),null);
 assert.equal(core.validate({...data,adjustments:[{...row,kind:'wrong'}]},source),null);
});
test('a whole feedback session is one non-practice record',()=>{
 const session=core.session(data,source,'Daily conversation','session-id',100);
 assert.equal(session.better,'');assert.equal(session.studyState,'inbox');assert.equal(session.origin,'feedback-session');
 assert.equal(session.sourceFeedback,source);assert.equal(session.originalParagraph,null);assert.equal(session.adjustments.length,2);
});
test('opting into one pattern leaves the session and other adjustments inactive',()=>{
 const parent=core.session(data,source,'Daily conversation','session-id',100);
 const out=core.activate({session:parent},'session',0,200,learning.canActivate);
 assert.equal(Object.keys(out.map).length,2);assert.equal(out.item.studyState,'active');
 assert.equal(out.item.input,row.before);assert.equal(out.item.better,row.after);assert.equal(out.item.construct,'do research');
 assert.equal(out.map.session.better,'');assert.equal(out.map.session.studyState,'inbox');
});
test('re-activating a pattern preserves previous notes, prompt and record identity',()=>{
 const first=core.activate({session:core.session(data,source,'Daily','id',100)},'session',0,200,learning.canActivate);
 first.map[first.key].studyState='archived';first.map[first.key].situation='My own prompt';first.map[first.key].note='My note';
 const second=core.activate(first.map,'session',0,300,learning.canActivate);
 assert.equal(second.key,first.key);assert.equal(second.item.createdAt,200);assert.equal(second.item.situation,'My own prompt');
 assert.equal(second.item.note,'My note');assert.equal(Object.keys(second.map).length,2);
});
test('marking feedback material keeps existing records and adds a candidate',()=>{
 const map=Object.fromEntries(Array.from({length:10},(_,i)=>[i,{studyState:'active'}]));
 map.session=core.session(data,source,'Daily','id',100);
 const result=core.activate(map,'session',0,200,learning.canActivate);assert.equal(result.item.studyState,'active');
 assert.equal(Object.keys(map).length,11);
});

test('image endpoint rejects malformed and oversized images before calling the model',async()=>{
 const source=fs.readFileSync('tutor-server.mjs','utf8');let calls=0;
 const c={Buffer,readBody:async req=>req,sendJson:(_,status,data)=>({status,data}),callModel:async()=>{calls++;throw Error('must not run');}};vm.createContext(c);
 vm.runInContext(source.slice(source.indexOf('async function handleFeedbackImage'),source.indexOf('async function handleFeedback(req')),c);
 for(const image of ['data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,YmFk', 'x'.repeat(7000001)]){
  const result=await c.handleFeedbackImage({image},{});assert.equal(result.status,400);
 }
 assert.equal(calls,0);
});
test('image recognition retains grounded pairs but never stores the original screenshot',async()=>{
 const sourceCode=fs.readFileSync('tutor-server.mjs','utf8');const extractedText=source;
 let sent;
 const c={Buffer,NuanceFeedback:core,FEEDBACK_SYSTEM_PROMPT:'extract',POLISH_MODEL:'local',readBody:async req=>req,sendJson:(_,status,data)=>(sent={status,data}),callModel:async(_,__,opts)=>{assert.ok(opts.image);return JSON.stringify({...data,extractedText});}};vm.createContext(c);
 vm.runInContext(sourceCode.slice(sourceCode.indexOf('async function handleFeedbackImage'),sourceCode.indexOf('async function handleFeedback(req')),c);
 await c.handleFeedbackImage({image:'data:image/png;base64,iVBORw0KGgo='},{});
 const result=sent;
 assert.equal(result.status,200);assert.equal(result.data.adjustments.length,2);
 const saved=core.session(result.data,result.data.extractedText,'Screenshot','id',1);
 assert.ok(!JSON.stringify(saved).includes('data:image'));assert.equal(saved.better,'');
});

test('web selection saves in place, deduplicates, retains progress and never opens another tab',async()=>{
 const {webcrypto}=await import('node:crypto');const storage={corrections:{}};let listener,calls=0,opened=0;
 const c={crypto:webcrypto,TextEncoder,URL,AbortSignal,console,importScripts(){},NuanceFeedback:core,NuanceLearning:learning,NuanceCapture:{cleanUrl:url=>new URL(url).origin+new URL(url).pathname},
 fetch:async(url,opts)=>{calls++;assert.equal(url,'http://127.0.0.1:48773/feedback');assert.equal(JSON.parse(opts.body).text,source);return {ok:true,json:async()=>data};},
 chrome:{storage:{local:{get:async keys=>Object.fromEntries(keys.map(k=>[k,storage[k]])),set:async values=>Object.assign(storage,values)},onChanged:{addListener(){}}},alarms:{create(){},clear(){},onAlarm:{addListener(){}}},runtime:{onMessage:{addListener(fn){listener=fn;}}},tabs:{create(){opened++;}}}};
 vm.createContext(c);vm.runInContext(fs.readFileSync('extension-background.js','utf8'),c);
 const send=message=>new Promise(resolve=>listener(message,{tab:{title:'Daily practice',url:'https://example.com/chat?private=1'}},resolve));
 const first=await send({type:'nuance:feedback-text',text:source});assert.equal(first.ok,true);assert.equal(calls,1);assert.equal(opened,0);
 const keys=Object.keys(storage.corrections);assert.equal(keys.length,1);const item=storage.corrections[keys[0]];assert.equal(item.better,'');assert.equal(item.sourceUrl,'https://example.com/chat');item.note='preserve';
 const again=await send({type:'nuance:feedback-text',text:source});assert.equal(again.existed,true);assert.equal(calls,1);assert.equal(storage.corrections[keys[0]].note,'preserve');
 const bad=await send({type:'nuance:feedback-text',text:'short'});assert.equal(bad.ok,false);assert.equal(Object.keys(storage.corrections).length,1);
});
