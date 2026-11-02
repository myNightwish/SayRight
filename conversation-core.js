// Durable dialogue evidence. Records are append-only and share the existing sync store.
(function(){
 const root=typeof window==='undefined'?globalThis:window,SESSION='@nuance/dialogue/',EVENT='@nuance/dialogue-event/',DAY=86400000;
 const clean=(value,max=3000)=>typeof value==='string'?value.trim().slice(0,max):'';
 const norm=value=>String(value||'').normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}\s]+/gu,'');
 const validId=id=>typeof id==='string'&&/^[\w:-]{1,160}$/.test(id);
 function uses(value,materials,text,support={}){
  if(!Array.isArray(value))return [];
  const seen=new Set();return value.slice(0,20).flatMap(use=>{
   const target=materials.find(x=>x.expression===use?.expression),quote=clean(use?.evidence,3000);
   if(!target||seen.has(target.key)||!['used','alternative','needs_work'].includes(use.outcome)||norm(quote).length<3||!norm(text).includes(norm(quote)))return [];
   seen.add(target.key);
   const assistance=(support.referenceKeys||[]).includes(target.key)?'reference':(support.hintedKeys||[]).includes(target.key)?'prompted':['independent','prompted','reference'].includes(use.support)?use.support:'unknown';
   return [{expression:target.expression,itemKey:target.key,reference:target.expression,outcome:use.outcome,evidence:quote,reason:clean(use.reason,700),support:assistance}];
  });
 }
 function snapshot(drill){
  const values=Object.values(drill||{}),events=values.filter(x=>x?.kind==='dialogue-event').sort((a,b)=>a.at-b.at||a.id.localeCompare(b.id));
  return values.filter(x=>x?.kind==='dialogue-session').map(session=>{
   const entries=events.filter(x=>x.sessionId===session.id),end=entries.find(x=>x.type==='end');
   const evidence=entries.filter(x=>x.type==='response').flatMap(x=>(x.uses||[]).map(use=>({...use,at:x.at,sessionId:session.id,scene:session.scene,turnId:x.userTurnId,responseId:x.id})));
   return {...session,entries,evidence,endedAt:end?.at||null,endReason:end?.reason||'',lastAt:entries.at(-1)?.at||session.at};
  }).sort((a,b)=>b.lastAt-a.lastAt);
 }
 function progress(map,drill,now=Date.now()){
  const sessions=snapshot(drill),all=sessions.flatMap(x=>x.evidence).sort((a,b)=>a.at-b.at),out={};
  for(const [key,item] of Object.entries(map||{})){
   const refs=root.NuanceQueue.learningReferences(item,key,drill),records=all.filter(x=>x.itemKey===key&&refs.has(x.reference)),last=records.at(-1),success=records.filter(x=>x.outcome==='used'),independent=success.filter(x=>x.support==='independent');
   const days=new Set(independent.map(x=>Math.floor(x.at/DAY))),scenes=new Set(independent.map(x=>x.scene));
   const span=independent.length?independent.at(-1).at-independent[0].at:0;
   const interval=last?.outcome==='used'&&last.support==='independent'?(span>=4*DAY&&days.size>=3?7:span>=DAY?4:2):1;
   out[key]={records,last,uses:success.length,independent:independent.length,readyToArchive:independent.length>=2&&independent.at(-1).at-independent[0].at>=DAY&&scenes.size>=2,days:days.size,scenes:scenes.size,dueAt:last?last.at+interval*DAY:0,due:!last||last.at+interval*DAY<=now};
  }
  return out;
 }
 function planMaterials(state,drill,now=Date.now()){
  const map=Object.fromEntries(state.items.map(x=>[x.key,x])),stats=progress(map,drill,now);
  const materials=root.NuanceQueue.dialogueMaterials(state).map(item=>{const p=stats[item.key];return {...item,intent:p.last?'':item.intent,revisitDue:p.due,lastPractice:p.last?{scene:p.last.scene,outcome:p.last.outcome,support:p.last.support,at:p.last.at}:null};});
  materials.sort((a,b)=>Number(b.revisitDue)-Number(a.revisitDue)||(a.lastPractice?.at||0)-(b.lastPractice?.at||0));
  return materials.map((item,i)=>({...item,focus:i<3}));
 }
 // A resume never generates a new scene or changes stored events.
 function resumable(state,drill){
  if(!state.ready)return null;
  const current=root.NuanceQueue.dialogueMaterials(state),signature=root.NuanceQueue.dialogueSignature(state);
  const session=snapshot(drill).find(s=>s.roundId===state.windowId);
  if(!session||session.endedAt||!session.materials?.length||!(session.signature?session.signature===signature:session.materials.every(m=>current.some(x=>x.key===m.key&&x.expression===m.expression&&x.expressionVersion===m.expressionVersion))))return null;
  const opener=session.entries.find(x=>x.id===session.id+':opener');
  const plan=session.plan||{scene:session.scene,learnerRole:session.learnerRole,aiRole:session.aiRole,goal:session.goal,opener:opener?.text||'',opener_zh:opener?.translation||'',checklist:session.materials.map(m=>({...m}))};
  const messages=session.entries.filter(x=>x.role==='me'||x.role==='them'),last=messages.at(-1);
  const referenceKeys=new Set(),hintedKeys=new Set();
  for(const e of session.entries){
   for(const key of e.support?.referenceKeys||[])referenceKeys.add(key);
   for(const key of e.support?.hintedKeys||[])hintedKeys.add(key);
   for(const use of e.uses||[]){if(use.support==='reference'||e.feedback?.better)referenceKeys.add(use.itemKey);if(use.support==='prompted')hintedKeys.add(use.itemKey);}
  }
  return {session,plan,messages,referenceKeys:[...referenceKeys],hintedKeys:[...hintedKeys],pendingTurnId:last?.role==='me'?last.id:null};
 }
 function apply(map,drill,action,now=Date.now()){
  let corrections={...map},drillState={...drill},changed=false;
  const at=Math.max(now,...Object.values(drill).filter(x=>x?.kind==='dialogue-event'||x?.kind==='dialogue-session').map(x=>(x.at||0)+1));
  const session=validId(action.sessionId)?drillState[SESSION+action.sessionId]:null;
  function requireSession(){if(!session||session.kind!=='dialogue-session')throw Error('对话记录不存在，请重新开始');return session;}
  function append(id,event){if(!validId(id))throw Error('对话记录标识无效');const key=EVENT+id;if(drillState[key]){const previous=drillState[key];if(previous.sessionId!==action.sessionId||previous.type!==event.type||(event.text&&previous.text!==event.text))throw Error('对话记录标识冲突，请重试');return previous;}const record={kind:'dialogue-event',id,sessionId:action.sessionId,at,savedAt:at,...event};drillState[key]=record;changed=true;return record;}
  function open(){requireSession();if(drillState[EVENT+session.id+':end'])throw Error('这场对话已结束，请重新开始');}
  if(action.type==='dialogue-start'){
   if(!validId(action.sessionId))throw Error('对话记录标识无效');
   if(session)return {corrections,drillState,changed,sessionId:session.id};
   const current=root.NuanceQueue.snapshot(map,drill);
   if(!current.ready||action.signature!==root.NuanceQueue.dialogueSignature(current))throw Error('学习材料已变化，请重新开始对话');
   const available=root.NuanceQueue.dialogueMaterials(current),plan=action.plan;
   if(!plan||!clean(plan.opener)||!Array.isArray(plan.checklist)||!plan.checklist.length||plan.checklist.some(x=>!available.some(m=>m.expression===x.expression)))throw Error('演练材料未能对应当前卡片');
   const chosen=new Set(plan.checklist.map(x=>x.expression)),materials=available.filter(x=>chosen.has(x.expression));
   drillState[SESSION+action.sessionId]={kind:'dialogue-session',id:action.sessionId,roundId:current.windowId,scene:clean(plan.scene,300),learnerRole:clean(plan.learnerRole,200),aiRole:clean(plan.aiRole,200),goal:clean(plan.goal,700),materials,signature:action.signature,plan:{scene:clean(plan.scene,300),learnerRole:clean(plan.learnerRole,200),aiRole:clean(plan.aiRole,200),goal:clean(plan.goal,700),opener:clean(plan.opener),opener_zh:clean(plan.opener_zh),checklist:plan.checklist.map(x=>({expression:x.expression,intent:clean(x.intent,700),construct:clean(x.construct,700),key:materials.find(m=>m.expression===x.expression).key}))},at,savedAt:at};changed=true;
   append(action.sessionId+':opener',{type:'message',role:'them',text:clean(plan.opener),translation:clean(plan.opener_zh)});
  }else if(action.type==='dialogue-support'){
   open();const keys=new Set(session.materials.map(x=>x.key));
   append(action.id,{type:'support',support:{referenceKeys:(action.support?.referenceKeys||[]).filter(x=>keys.has(x)),hintedKeys:(action.support?.hintedKeys||[]).filter(x=>keys.has(x))}});
  }else if(action.type==='dialogue-message'){
   open();const last=snapshot(drill).find(s=>s.id===session.id)?.entries.filter(e=>e.role).at(-1);if(last?.role==='me'&&last.id!==action.id)throw Error('上条回应正在等待反馈，请先重试或等待 AI 回复');const text=clean(action.text);if(!text||action.text.length>3000)throw Error('请输入 1～3000 字符的英文回应');
   const keys=new Set(session.materials.map(x=>x.key)),support={referenceKeys:(action.support?.referenceKeys||[]).filter(x=>keys.has(x)),hintedKeys:(action.support?.hintedKeys||[]).filter(x=>keys.has(x))};
   append(action.id,{type:'message',role:'me',text,support});
  }else if(action.type==='dialogue-response'){
   open();const user=drillState[EVENT+action.userTurnId];if(user?.sessionId!==session.id||user?.role!=='me')throw Error('反馈未能对应本次回应');
   const text=clean(action.text);if(!text)throw Error('AI 回复不完整，未写入学习证据');
   const approved=uses(action.uses,session.materials,user.text,user.support),previous=snapshot(drill).find(x=>x.id===session.id)?.evidence||[];
   const evidence=approved.map(use=>{const earlier=[...previous].reverse().find(x=>x.itemKey===use.itemKey&&x.reference===use.reference);return {...use,...(earlier?.outcome==='needs_work'&&use.outcome==='used'?{repairedFrom:earlier.turnId,...(drillState[EVENT+earlier.responseId]?.feedback?.better?{support:'reference'}:{})}:{})};});
   const f=action.feedback||{};append(action.id,{type:'response',role:'them',text,translation:clean(action.translation),userTurnId:action.userTurnId,done:action.done===true,support:{hintedKeys:action.hintRevealed?session.materials.map(x=>x.key):[]},feedback:{ok:f.ok===true,better:clean(f.better,1500),tip:clean(f.tip,1000)},uses:evidence});
  }else if(action.type==='dialogue-end'){
   requireSession();append(session.id+':end',{type:'end',reason:clean(action.reason,100)||'finished'});
  }else if(action.type==='dialogue-collect'){
   requireSession();const source=drillState[EVENT+action.messageId],text=clean(action.text,1201);
   if(source?.sessionId!==session.id||source?.role!=='them'||!text||text.length>1200||!source.text.includes(text))throw Error('请选择这条 AI 回复中的原文（最多 1200 字符）');
   const key=root.NuanceLearning.keyOf(text);if(key==='__proto__')throw Error('表达无效');
   if(!Object.hasOwn(corrections,key)){
    const prior=snapshot(drill).find(x=>x.id===session.id)?.entries.filter(x=>x.role==='me'&&x.at<source.at).at(-1);
    corrections[key]={better:text,input:text,origin:'dialogue',studyState:'inbox',stars:0,personalContext:session.scene,situation:session.scene,sourceLabel:'情境对话 · '+session.scene,sourceDialogueId:session.id,sourceMessageId:source.id,sourceContext:(prior?.text?prior.text+'\n':'')+source.text,createdAt:at,savedAt:at};changed=true;
   }
   return {corrections,drillState,changed,collectedKey:key,sessionId:session.id};
  }else throw Error('未知对话记录操作');
  return {corrections,drillState,changed,sessionId:action.sessionId};
 }
 root.NuanceConversation={uses,snapshot,progress,planMaterials,resumable,apply,SESSION,EVENT};
})();
