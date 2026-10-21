// A feedback session is evidence of an adjustment, not a batch of mandatory flashcards.
(function () {
  const root=typeof window==='undefined'?globalThis:window;
  const normalize=text=>String(text||'').replace(/(^|\n)\s*>\s?/g,'$1').replace(/[‘’]/g,"'").replace(/[“”]/g,'"').replace(/[*`]/g,'').replace(/\s+/g,' ').trim().toLowerCase();
  const labels={correction:'搭配 / 语法调整',meaning:'意思或适用语境不同',alternative:'可选说法，原表达不一定有错'};
  function validate(value,source) {
    if(!value||typeof value!=='object'||typeof value.summary!=='string'||!value.summary.trim()||value.summary.length>300||!Array.isArray(value.adjustments)||!value.adjustments.length||value.adjustments.length>10)return null;
    const haystack=normalize(source),seen=new Set(),adjustments=[];let omitted=0;
    for(const row of value.adjustments){
      if(!row||!Object.hasOwn(labels,row.kind)){omitted++;continue;}
      if(['before','after','reason','pattern','practiceCue','transferCue'].some(k=>typeof row[k]!=='string'||!row[k].trim())){omitted++;continue;}
      if(row.before.length>1200||row.after.length>1200||row.reason.length>700||row.pattern.length>180||row.practiceCue.length>700||row.transferCue.length>700){omitted++;continue;}
      // A model may explain a contrast, but cannot manufacture what the learner originally wrote.
      if(!haystack.includes(normalize(row.before))||!haystack.includes(normalize(row.after))){omitted++;continue;}
      if(normalize(row.before)===normalize(row.after)){omitted++;continue;}
      if([row.practiceCue,row.transferCue].some(cue=>normalize(cue).includes(normalize(row.after)))){omitted++;continue;}
      const id=normalize(row.before)+'→'+normalize(row.after);if(seen.has(id))continue;seen.add(id);
      adjustments.push(Object.fromEntries(['before','after','kind','reason','pattern','practiceCue','transferCue'].map(k=>[k,row[k].trim()])));
    }
    if(!adjustments.length)return null;
    const paragraph=field=>typeof value[field]==='string' && value[field].length<=8000 && haystack.includes(normalize(value[field])) ? value[field].trim()||null : null;
    return {summary:value.summary.trim(),originalParagraph:paragraph('originalParagraph'),polishedParagraph:paragraph('polishedParagraph'),adjustments,omitted};
  }

  function session(data,source,title,id,now){
    return {origin:'feedback-session',studyState:'inbox',better:'',input:'',sourceLabel:title.trim()||'每日英语反馈',personalContext:data.summary,
      originalParagraph:data.originalParagraph,polishedParagraph:data.polishedParagraph,adjustments:data.adjustments,
      sourceFeedback:source,omitted:data.omitted||0,feedbackId:id,createdAt:now,savedAt:now};
  }
  function activate(map,sessionKey,index,now,canActivate){
    const parent=map[sessionKey],row=parent?.adjustments?.[index];if(!row)throw new Error('这条调整已不存在');
    const key=`${sessionKey}:adjustment:${index}`;
    const prior=Object.hasOwn(map,key)?map[key]:null;
    if(!canActivate(map,prior||{studyState:'inbox'}))throw new Error('正在练的表达已有 20 条，先暂停或归档一条，再安排这次练习。');
    const item=prior?{...prior}:{input:row.before,better:row.after,origin:'feedback-adjustment',sourceLabel:parent.sourceLabel,
      feedbackId:parent.feedbackId,feedbackSessionKey:sessionKey,adjustmentKind:row.kind,construct:row.pattern,note:row.reason,
      personalContext:parent.personalContext,situation:row.practiceCue,situations:[row.transferCue],createdAt:now,stars:0};
    item.studyState='active';item.savedAt=now;
    const result={...map};Object.defineProperty(result,key,{value:item,enumerable:true,writable:true,configurable:true});
    return {map:result,key,item,existed:Boolean(prior)};
  }
  root.NuanceFeedback={validate,labels,session,activate};
})();
