import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import {webcrypto} from 'node:crypto';
const env={crypto:webcrypto};vm.createContext(env);for(const f of ['learning.js','queue-core.js','conversation-core.js'])vm.runInContext(fs.readFileSync(f,'utf8'),env);
const Q=env.NuanceQueue,C=env.NuanceConversation,DAY=86400000;
const base=Date.UTC(2026,9,20,12),expression='I have a lot on my plate.';
function initial(){let s=Q.apply({a:{better:expression,studyState:'active',sourceLabel:'keep',savedAt:1}},{},{type:'reconcile'},base);s=Q.apply(s.corrections,s.drillState,{type:'rate',key:'a',score:4},base+100);return s;}
const run=(s,a,at)=>C.apply(s.corrections,s.drillState,a,at);
function start(s,id='s1',at=base+1000,scene='同事讨论工作'){
 return run(s,{type:'dialogue-start',sessionId:id,signature:Q.dialogueSignature(Q.snapshot(s.corrections,s.drillState)),plan:{scene,opener:'How has your week been?',opener_zh:'这周怎么样？',checklist:[{expression}]}},at);
}
function turn(s,{sessionId='s1',id='t1',text='She had a lot on her plate last week.',outcome='used',support='independent',refs=[],better='',at=base+2000}={}){
 s=run(s,{type:'dialogue-message',sessionId,id,text,support:{referenceKeys:refs}},at);
 return run(s,{type:'dialogue-response',sessionId,id:id+':reply',userTurnId:id,text:'That sounds stressful. How did you help?',feedback:{ok:!better,better,tip:better?'搭配可以调整':''},uses:[{expression,outcome,evidence:text,reason:'目标用法',support}]},at+100);
}
test('subject and tense variants are linked to a canonical target without requiring verbatim learner text',()=>{
 const s=turn(start(initial())),record=C.snapshot(s.drillState)[0];
 assert.equal(record.entries.find(x=>x.role==='me').text,'She had a lot on her plate last week.');assert.equal(record.evidence[0].reference,expression);assert.equal(record.evidence[0].outcome,'used');assert.equal(record.evidence[0].support,'independent');assert.equal(s.corrections.a.better,expression);assert.equal(s.drillState['a::replay'],undefined);
});
test('unsupported or AI-only quotes cannot create usage evidence',()=>{
 const s=turn(start(initial()));const invalid=C.uses([{expression,outcome:'used',evidence:'This was only said by the AI',support:'independent'}],[{key:'a',expression}],'I do not know');assert.equal(invalid.length,0);
 assert.equal(C.uses([{expression:'Invented target',outcome:'used',evidence:'I do not know',support:'independent'}],[{key:'a',expression}],'I do not know').length,0);
 assert.equal(C.snapshot(s.drillState)[0].evidence.length,1);
});
test('another construction can communicate successfully without falsely counting as the target',()=>{
 const s=turn(start(initial()),{text:'She was really busy.',outcome:'alternative'}),p=C.progress(s.corrections,s.drillState,base+3000).a;
 assert.equal(p.uses,0);assert.equal(p.independent,0);assert.equal(p.last.outcome,'alternative');assert.equal(p.readyToArchive,false);
});
test('viewing a reference cannot be overridden by a model claim of independent use',()=>{
 const s=turn(start(initial()),{refs:['a']}),p=C.progress(s.corrections,s.drillState).a;assert.equal(p.last.support,'reference');assert.equal(p.independent,0);
});
test('retry after a supplied correction is recorded as repaired with help',()=>{
 let s=turn(start(initial()),{text:'She had many things on plate.',outcome:'needs_work',better:'She had a lot on her plate.'});
 s=turn(s,{id:'t2',at:base+4000});const records=C.snapshot(s.drillState)[0].evidence;assert.equal(records[1].repairedFrom,'t1');assert.equal(records[1].support,'reference');assert.equal(records[0].outcome,'needs_work');
});
test('next scenes prioritize unpracticed or due material, retaining actual previous scene as context',()=>{
 const s=turn(start(initial())),current=Q.snapshot(s.corrections,s.drillState);
 const early=C.planMaterials(current,s.drillState,base+3000)[0],later=C.planMaterials(current,s.drillState,base+3*DAY)[0];
 assert.equal(early.revisitDue,false);assert.equal(later.revisitDue,true);assert.equal(later.focus,true);assert.equal(later.lastPractice.scene,'同事讨论工作');assert.equal(later.expression,expression);
});
test('same-day repeats never suggest graduation; spaced use in different scenes only suggests archiving',()=>{
 let s=turn(start(initial()));s=run(s,{type:'dialogue-end',sessionId:'s1'},base+4000);s=start(s,'s2',base+5000,'与朋友计划周末');s=turn(s,{sessionId:'s2',id:'t2',at:base+6000});assert.equal(C.progress(s.corrections,s.drillState).a.readyToArchive,false);
 s=run(s,{type:'dialogue-end',sessionId:'s2'},base+8000);s=start(s,'s3',base+2*DAY,'与家人谈生活');s=turn(s,{sessionId:'s3',id:'t3',at:base+2*DAY+1000});assert.equal(C.progress(s.corrections,s.drillState).a.readyToArchive,true);assert.equal(s.corrections.a.studyState,'active');
});
test('AI collection preserves context and remains inbox, with duplicates leaving progress untouched',()=>{
 let s=turn(start(initial()));s=run(s,{type:'dialogue-collect',sessionId:'s1',messageId:'t1:reply',text:'That sounds stressful.'},base+4000);
 const key=s.collectedKey;assert.equal(s.corrections[key].studyState,'inbox');assert.equal(s.corrections[key].sourceDialogueId,'s1');assert.match(s.corrections[key].sourceContext,/She had a lot/);assert.equal(s.corrections[key].personalContext,'同事讨论工作');
 s.corrections[key]={...s.corrections[key],note:'my note',stars:1,studyState:'archived'};const again=run(s,{type:'dialogue-collect',sessionId:'s1',messageId:'t1:reply',text:'That sounds stressful.'},base+5000);assert.equal(again.changed,false);assert.equal(again.corrections[key].note,'my note');assert.equal(again.corrections[key].studyState,'archived');
 assert.throws(()=>run(s,{type:'dialogue-collect',sessionId:'s1',messageId:'t1',text:'She had a lot'},base+5000),/AI 回复/);
 assert.throws(()=>run(s,{type:'dialogue-collect',sessionId:'s1',messageId:'t1:reply',text:'An invented sentence'},base+5000),/AI 回复/);
});
test('record IDs are idempotent and closing a dialogue preserves transcripts without archiving materials',()=>{
 let s=turn(start(initial()));const count=Object.keys(s.drillState).length;
 s=run(s,{type:'dialogue-message',sessionId:'s1',id:'t1',text:'She had a lot on her plate last week.'},base+4000);assert.equal(Object.keys(s.drillState).length,count);
 s=run(s,{type:'dialogue-end',sessionId:'s1',reason:'finished'},base+5000);const again=run(s,{type:'dialogue-end',sessionId:'s1'},base+6000);assert.equal(again.changed,false);assert.ok(C.snapshot(s.drillState)[0].endedAt);assert.equal(s.corrections.a.studyState,'active');assert.throws(()=>turn(s,{id:'t2'}),/已结束/);
});
test('replacing a reference does not reuse old utterances as new-version mastery evidence',()=>{
 const s=turn(start(initial()));s.corrections.a={...s.corrections.a,better:'A different example'};assert.equal(C.progress(s.corrections,s.drillState).a.uses,0);assert.equal(C.snapshot(s.drillState)[0].evidence.length,1);
});

test('reviewed same-pattern adoptions preserve ratings and all linked usage, including older saved adoptions',()=>{
 let s=turn(start(initial()));
 const adopt=answer=>{s=Q.apply(s.corrections,s.drillState,{type:'attempt',key:'a',answer,feedback:{correct:true,patternUsed:true,explanation:'same usage',suggestion:''}},base+5000);s=Q.apply(s.corrections,s.drillState,{type:'adopt',key:'a',attemptId:s.attemptId},base+6000);};
 adopt('My sister had a lot on her plate.');adopt('We have a lot on our plates.');
 assert.equal(Q.snapshot(s.corrections,s.drillState).items[0].selfRating,4);assert.equal(Q.snapshot(s.corrections,s.drillState).ready,true);
 assert.equal(C.progress(s.corrections,s.drillState).a.independent,1);assert.equal(C.planMaterials(Q.snapshot(s.corrections,s.drillState),s.drillState)[0].lastPractice.scene,'同事讨论工作');
 assert.equal(C.snapshot(s.drillState)[0].evidence[0].reference,expression);
 // Unreviewed edits do not inherit an arbitrary existing chain.
 s.corrections.a={...s.corrections.a,better:'A completely different construction'};
 assert.equal(Q.snapshot(s.corrections,s.drillState).items[0].selfRating,0);assert.equal(C.progress(s.corrections,s.drillState).a.independent,0);
});
test('unverified adoption records cannot transfer learning progress',()=>{
 const s=turn(start(initial()));s.corrections.a.better='New example';s.drillState.fake={kind:'practice-adoption',itemKey:'a',before:expression,after:'New example',attemptId:'missing'};
 assert.equal(C.progress(s.corrections,s.drillState).a.uses,0);assert.equal(Q.snapshot(s.corrections,s.drillState).items[0].selfRating,0);
});
test('resuming restores the plan, exact messages, evidence and help without mutating stored records',()=>{
 let s=start(initial());s=run(s,{type:'dialogue-support',sessionId:'s1',id:'view1',support:{referenceKeys:['a','not-a-member']}},base+1200);s=turn(s,{refs:['a']});
 const before=JSON.stringify(s.drillState),saved=C.resumable(Q.snapshot(s.corrections,s.drillState),s.drillState);
 assert.equal(saved.session.id,'s1');assert.equal(saved.messages.length,3);assert.equal(saved.plan.opener,'How has your week been?');assert.equal(saved.pendingTurnId,null);assert.deepEqual([...saved.referenceKeys],['a']);assert.equal(saved.session.evidence[0].support,'reference');assert.equal(JSON.stringify(s.drillState),before);
});
test('an unanswered saved turn is resumable, cannot be skipped, and receives exactly one reply',()=>{
 let s=start(initial());s=run(s,{type:'dialogue-message',sessionId:'s1',id:'pending1',text:'She had a lot on her plate.'},base+1300);
 const saved=C.resumable(Q.snapshot(s.corrections,s.drillState),s.drillState);assert.equal(saved.pendingTurnId,'pending1');
 assert.throws(()=>run(s,{type:'dialogue-message',sessionId:'s1',id:'pending2',text:'Another message'},base+1500),/等待/);
 const action={type:'dialogue-response',sessionId:'s1',id:'pending1:reply',userTurnId:'pending1',text:'How did you help?',feedback:{ok:true},uses:[]};
 s=run(s,action,base+1600);s=run(s,action,base+1700);assert.equal(C.resumable(Q.snapshot(s.corrections,s.drillState),s.drillState).pendingTurnId,null);assert.equal(C.snapshot(s.drillState)[0].entries.filter(e=>e.type==='response').length,1);
});
test('finished, outdated, unready, or superseded sessions are never silently reopened',()=>{
 let s=start(initial());const state=Q.snapshot(s.corrections,s.drillState);
 assert.equal(C.resumable({...state,ready:false},s.drillState),null);assert.equal(C.resumable({...state,windowId:'next'},s.drillState),null);
 s=run(s,{type:'dialogue-end',sessionId:'s1'},base+1200);assert.equal(C.resumable(state,s.drillState),null);
 // Even a newer finished session must not revive an older unfinished session.
 s=start(s,'s2',base+2000);s=start(s,'s3',base+3000);s=run(s,{type:'dialogue-end',sessionId:'s3'},base+4000);assert.equal(C.resumable(state,s.drillState),null);
 let changed=start(initial());changed.corrections.a.expressionChangedAt=99;assert.equal(C.resumable(Q.snapshot(changed.corrections,changed.drillState),changed.drillState),null);
});
test('legacy saved sessions without a plan snapshot can still be resumed conservatively',()=>{
 const s=start(initial()),header=s.drillState[C.SESSION+'s1'];delete header.plan;delete header.signature;
 const restored=C.resumable(Q.snapshot(s.corrections,s.drillState),s.drillState);assert.equal(restored.plan.opener,'How has your week been?');assert.equal(restored.plan.checklist[0].key,'a');
});
