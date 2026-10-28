// Marked material is unlimited. A pinned practice window has at most ten confirmed members.
(function(){
 const root=typeof window==='undefined'?globalThis:window;
 const PREFIX='@nuance/queue/',WINDOW='@nuance/window/',RATING='@nuance/rating/';
 const L=()=>root.NuanceLearning;
 const uuid=()=>root.crypto?.randomUUID?.()||`${Date.now()}-${Math.random().toString(36).slice(2)}`;
 const marked=map=>Object.entries(map).filter(([,x])=>x&&typeof x.better==='string'&&x.better.trim()&&x.origin!=='feedback-session'&&L().stateOf(x)==='active').map(([key,x])=>({...x,key})).sort((a,b)=>(b.queueJoinedAt||b.createdAt||b.savedAt||0)-(a.queueJoinedAt||a.createdAt||a.savedAt||0)||(b.createdAt||0)-(a.createdAt||0)||a.key.localeCompare(b.key));
 function feedback(value){
  if(!value||typeof value.correct!=='boolean'||typeof value.patternUsed!=='boolean'||typeof value.explanation!=='string'||!value.explanation.trim()||value.explanation.length>1000||typeof value.suggestion!=='string'||value.suggestion.length>1500)return null;
  return {correct:value.correct,patternUsed:value.patternUsed,explanation:value.explanation.trim(),suggestion:value.suggestion.trim()};
 }
 function snapshot(map,drill){
  const all=Object.values(drill||{}),events=all.filter(x=>x?.kind==='practice-queue-event').sort((a,b)=>a.at-b.at||a.id.localeCompare(b.id));
  const windows=all.filter(x=>x?.kind==='practice-window-event'&&x.version===3).sort((a,b)=>a.at-b.at||a.id.localeCompare(b.id));
  const starts=windows.filter(x=>x.action==='start'),start=starts.at(-1),pool=marked(map);
  const windowId=start?.windowId||'initial-v3';
  let slots=start?[...start.keys].slice(0,10):pool.slice(0,10).map(x=>x.key),closed=false;
  for(const e of windows.filter(x=>x.windowId===windowId&&x.action!=='start')){
   if(e.action==='remove')slots=slots.map(key=>key===e.itemKey?null:key);
   if(e.action==='admit'&&Number.isInteger(e.slot)&&e.slot>=0&&e.slot<10)slots[e.slot]=e.itemKey;
   if(e.action==='close')closed=true;
  }
  const rawSlots=[...slots];
  const seen=new Set();slots=Array.from({length:10},(_,i)=>{const key=slots[i],item=key&&Object.hasOwn(map,key)?map[key]:null;if(closed||!item||L().stateOf(item)!=='active'||seen.has(key))return null;seen.add(key);return key;});
  const items=slots.flatMap((key,index)=>{if(!key)return [];const item=map[key],rating=drill?.[RATING+encodeURIComponent(key)];const score=rating?.reference===item.better&&Number.isInteger(rating.score)&&rating.score>=1&&rating.score<=5?rating.score:0;return [{...item,key,slot:index,selfRating:score}];});
  const candidates=pool.filter(x=>!seen.has(x.key));
  const rounds=new Map();for(const e of events){if(!rounds.has(e.roundId))rounds.set(e.roundId,{id:e.roundId,startedAt:e.at,endedAt:null,members:new Map()});const r=rounds.get(e.roundId);if(e.action==='start')r.startedAt=Math.min(r.startedAt,e.at);if(e.action==='end'){r.endedAt=e.at;r.endReason=e.reason||'';}if(e.itemKey){const old=r.members.get(e.itemKey);r.members.set(e.itemKey,{key:e.itemKey,expression:e.expression||old?.expression||'',joinedAt:old?.joinedAt||(e.action==='join'?e.at:null),leftAt:e.action==='join'?null:e.at,status:e.action});}}
  const history=[...rounds.values()].filter(r=>r.endedAt).sort((a,b)=>b.endedAt-a.endedAt);
  const open=!closed&&items.length?[rounds.get(windowId)||{id:windowId,startedAt:start?.at||0,members:new Map(items.map(x=>[x.key,{key:x.key,expression:x.better,status:'join'}]))}]:start&&!closed?[rounds.get(windowId)||{id:windowId,startedAt:start.at,members:new Map()}]:[];
  const readyCount=items.filter(x=>x.selfRating>=4).length;
  return {items,candidates,pool,slots,rawSlots,windowId,initialized:Boolean(start),closed,needsSelection:false,open,history,events,readyCount,ready:items.length>0&&readyCount===items.length,attempts:all.filter(x=>x?.kind==='practice-attempt').sort((a,b)=>b.at-a.at),replacements:all.filter(x=>x?.kind==='practice-adoption').sort((a,b)=>b.at-a.at)};
 }
 function apply(map,drill,action,now=Date.now()){
  let corrections={...map},drillState={...drill},changed=false,attemptId;
  const versions=Object.values(drill||{}).filter(x=>x?.kind?.startsWith('practice-'));
  let clock=Math.max(now,...versions.map(x=>Math.max(x.at||0,x.savedAt||0)+1),...Object.values(map||{}).map(x=>(x?.expressionChangedAt||0)+1));
  function record(action,roundId,key,item,extra={}){const id=uuid(),at=clock++;drillState[PREFIX+id]={kind:'practice-queue-event',id,action,roundId,at,savedAt:at,...extra,...(key?{itemKey:key,expression:item?.better||''}:{})};changed=true;}
  function windowEvent(action,windowId,extra={},fixed){const id=fixed||uuid(),at=clock++;drillState[WINDOW+id]={kind:'practice-window-event',version:3,id,action,windowId,at,savedAt:at,...extra};changed=true;}
  function change(key,state){const old=corrections[key],item={...old,studyState:state,queueChangedAt:clock++,savedAt:clock};item.createdAt ||= old.savedAt||now;if(state==='active'&&L().stateOf(old)!=='active')item.queueJoinedAt=item.queueChangedAt;corrections[key]=item;changed=true;return item;}
  function start(keys,id=uuid(),fixed){windowEvent('start',id,{keys},fixed);record('start',id);for(const key of keys)record('join',id,key,corrections[key]);}
  // First adoption pins only the most recently marked ten. Remaining flags stay as candidates.
  let s=snapshot(corrections,drillState);
  if(!s.initialized&&s.pool.length)start(s.pool.slice(0,10).map(x=>x.key),'initial-v3','initial-v3');
  s=snapshot(corrections,drillState);
  if(s.initialized&&!s.closed)for(const key of s.rawSlots.filter(Boolean))if(!s.items.some(x=>x.key===key)){
    windowEvent('remove',s.windowId,{itemKey:key});record('leave',s.windowId,key,corrections[key]||{better:s.open[0]?.members.get(key)?.expression||''});
  }
  s=snapshot(corrections,drillState);
  function existing(key){if(typeof key!=='string'||!Object.hasOwn(corrections,key)||!corrections[key].better?.trim()||corrections[key].origin==='feedback-session')throw Error('这条表达已不存在');return corrections[key];}
  if(action.type==='state'){
   const item=existing(action.key);if(!['active','inbox','archived'].includes(action.state))throw Error('学习状态无效');
   if(L().stateOf(item)!==action.state){const updated=change(action.key,action.state);if(action.state!=='active'&&s.items.some(x=>x.key===action.key)){windowEvent('remove',s.windowId,{itemKey:action.key});record(action.state==='archived'?'archive':'leave',s.windowId,action.key,updated);}}
  }else if(action.type==='admit'){
   existing(action.key);if(s.closed)throw Error('本轮已结束，请先开启下一轮');
   if(s.items.some(x=>x.key===action.key))return {corrections,drillState,changed,snapshot:s};
   if(!s.candidates.some(x=>x.key===action.key))throw Error('这条表达还没有被标记为想练');
   const slot=s.slots.findIndex(x=>!x);if(slot<0)throw Error('本轮已满 10 条，请先移出一条，再确认候补');
   windowEvent('admit',s.windowId,{itemKey:action.key,slot});record('join',s.windowId,action.key,corrections[action.key]);
  }else if(action.type==='rate'){
   const item=s.items.find(x=>x.key===action.key);if(!item)throw Error('请对本轮卡片打分');if(!Number.isInteger(action.score)||action.score<1||action.score>5)throw Error('自评分为 1～5 分');
   drillState[RATING+encodeURIComponent(action.key)]={kind:'practice-self-rating',itemKey:action.key,reference:item.better,score:action.score,savedAt:clock++,at:clock};changed=true;
  }else if(action.type==='attempt'){
   const item=s.items.find(x=>x.key===action.key),answer=typeof action.answer==='string'?action.answer.trim():'';
   if(!item||!answer||answer.length>3000)throw Error('请先选择本轮卡片，并写下 1～3000 字符的造句');
   if((action.reference&&action.reference!==item.better)||(action.windowId&&action.windowId!==s.windowId))throw Error('本轮材料已变化，反馈未写入其他卡片。');
   const id=uuid();drillState['@nuance/practice/'+id]={kind:'practice-attempt',id,itemKey:item.key,roundId:s.windowId,reference:item.better,answer,mode:'sentence',referenceViewed:true,...(feedback(action.feedback)?{feedback:feedback(action.feedback)}:{}),at:clock,savedAt:clock++};changed=true;
   attemptId=id;
  }else if(action.type==='adopt'){
   const item=s.items.find(x=>x.key===action.key),attempt=typeof action.attemptId==='string'?drillState['@nuance/practice/'+action.attemptId]:null;
   if(!item||!attempt||attempt.kind!=='practice-attempt'||attempt.itemKey!==item.key)throw Error('请先检查这张卡片的造句');
   if(item.adoptedAttemptId===attempt.id&&item.better===attempt.answer)return {corrections,drillState,changed,snapshot:s};
   if(attempt.reference!==item.better||attempt.roundId!==s.windowId)throw Error('原句或本轮已变化，请重新检查造句后再替换');
   if(!attempt.feedback?.correct||!attempt.feedback?.patternUsed)throw Error('表达成立且用上目标用法后，才能替换原句');
   if(typeof attempt.answer!=='string'||!attempt.answer.trim()||attempt.answer.length>1200)throw Error('作为卡片主句的造句最多 1200 字符');
   if(item.better!==attempt.answer){
    const at=clock++,id=uuid();
    corrections[item.key]={...corrections[item.key],better:attempt.answer,originalBetter:item.originalBetter||item.better,adoptedAttemptId:attempt.id,expressionChangedAt:at,savedAt:at};
    drillState['@nuance/adoption/'+id]={kind:'practice-adoption',id,itemKey:item.key,roundId:s.windowId,attemptId:attempt.id,before:item.better,after:attempt.answer,at,savedAt:at};changed=true;
   }
  }else if(action.type==='end'){
   if(action.roundIds&&!action.roundIds.includes(s.windowId))throw Error('本轮已经变化，请重新确认结束本轮');
   const keys=new Set(action.keys||s.items.map(x=>x.key));for(const item of s.items)if(keys.has(item.key)){const updated=change(item.key,'archived');windowEvent('remove',s.windowId,{itemKey:item.key});record('archive',s.windowId,item.key,updated);}
   windowEvent('close',s.windowId);record('end',s.windowId);
  }else if(action.type==='new-window'||action.type==='select'){
   if(s.initialized&&!s.closed&&s.items.length)throw Error('请先结束当前一轮，再开启下一轮');
   const keys=action.type==='select'?[...new Set(action.keys||[])]:s.candidates.slice(0,10).map(x=>x.key);
   if(keys.length>10)throw Error('本轮最多 10 条');for(const key of keys)existing(key);if(keys.length)start(keys);
  }else if(action.type!=='reconcile')throw Error('未知队列操作');
  // An initially empty library may receive its first marked expression in this operation.
  s=snapshot(corrections,drillState);if(!s.initialized&&s.pool.length)start(s.pool.slice(0,10).map(x=>x.key),'initial-v3','initial-v3');
  return {corrections,drillState,changed,attemptId,snapshot:snapshot(corrections,drillState)};
 }
 function dialogueMaterials(state){
  return state.items.slice(0,10).map(item=>({key:item.key,expression:item.better,personalized:Boolean(item.adoptedAttemptId),expressionVersion:item.expressionChangedAt||0,
   intent:item.adoptedAttemptId?'':item.personalContext||item.situation||item.intent||'',construct:item.adoptedAttemptId?'':item.construct||(item.chunks||[]).map(x=>x.text).join('; ')}));
 }
 function dialogueSignature(state){return JSON.stringify([state.windowId,state.ready,dialogueMaterials(state)]);}
 root.NuanceQueue={snapshot,apply,feedback,dialogueMaterials,dialogueSignature,PREFIX,PROTOCOL:3};
})();
