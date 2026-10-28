// Collection -> visible sentence practice and self-rating -> learned-material dialogue.
(function(){
 const root=typeof window==='undefined'?globalThis:window;
 const esc=v=>String(v??'').replace(/[&<>"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));
 const drafts=new Map(),opened=new Set(),pending=new Set(),responses=new Map();
 const scoreNames=['','还很陌生','看着例句能模仿','需要提示才能用','可以独立造句','换个场景也能用'];
 let host,api,snapshot,query='',shown=10,candidatesOpen=false;
 function draft(key){if(drafts.has(key))return drafts.get(key);try{return sessionStorage.getItem('nuance-sentence:'+key)||'';}catch(_){return '';}}
 function saveDraft(key,value){drafts.set(key,value);try{sessionStorage.setItem('nuance-sentence:'+key,value);}catch(_){}}
 function lastAttempt(item){const cached=responses.get(item.key);return (cached?.reference===item.better?cached:null)||(snapshot.attempts||[]).find(x=>x.itemKey===item.key&&x.reference===item.better&&x.feedback);}
 function feedbackHtml(attempt,item){
  if(!attempt?.feedback)return '';const f=attempt.feedback;
  const canAdopt=attempt.id&&f.correct&&f.patternUsed&&attempt.reference===item.better&&attempt.roundId===snapshot.windowId&&attempt.answer!==item.better&&attempt.answer?.length<=1200;
  return `<section class="sentence-feedback"><span class="sentence-feedback-label ${f.correct?'is-correct':''}">${f.correct?'这句表达成立':'这里需要调整'}${f.patternUsed?' · 用上了目标用法':''}</span><p>${esc(f.explanation)}</p>${f.suggestion?`<div class="sentence-suggestion">${esc(f.suggestion)}</div>`:''}${attempt.answer?`<details><summary>这次检查的造句</summary><p>${esc(attempt.answer)}</p></details>`:''}${canAdopt?`<div class="sentence-adopt"><p class="sentence-adopt-preview">${esc(attempt.answer)}</p><button type="button" class="queue-card-action" data-adopt-key="${esc(item.key)}" data-adopt-attempt="${esc(attempt.id)}">用我的句子替换</button><p class="sentence-adopt-status" role="status"></p><small>替换后请重新确认自评分。</small></div>`:''}<small>AI 反馈供参考，自评分由你决定。</small></section>`;
 }
 function bindAdoptions(scope=host){
  for(const button of scope.querySelectorAll('[data-adopt-key]'))button.onclick=async()=>{
   button.disabled=true;const status=button.parentElement.querySelector('.sentence-adopt-status');if(status)status.textContent='正在保存你的句子…';
   try{if(typeof api.adopt!=='function')throw Error('当前页面版本未更新，请刷新页面；插件版还需要重新加载插件。');await api.adopt(button.dataset.adoptKey,button.dataset.adoptAttempt);responses.delete(button.dataset.adoptKey);api.notice('已换成你的造句，请重新确认自评分。');}
   catch(error){button.disabled=false;if(status)status.textContent=error.message;api.notice(error.message);}
  };
 }
 function card(item){const score=item.selfRating||0;return `<article class="sentence-card" data-training-card="${esc(item.key)}">
  <div class="sentence-card-top"><span class="sentence-order">${String(item.slot+1).padStart(2,'0')}</span><span class="sentence-score-summary" data-score-summary>${score?`自评 ${score} / 5`:'尚未自评'}</span><button type="button" class="sentence-quiet" data-queue-state="inbox" data-queue-key="${esc(item.key)}" title="移出本轮并保留收藏">移出</button><button type="button" class="sentence-delete" data-remove="${esc(item.key)}" aria-label="删除这条收藏" title="删除这条收藏">×</button></div>
  <h2>${esc(item.better)}</h2><p class="sentence-context">${esc(item.adoptedAttemptId?'我的造句':item.personalContext||item.situation||item.intent||'照着这个用法，换成自己的事情说一句。')}</p>
  <div class="sentence-rating" role="group" aria-label="这条表达的自评分">${[1,2,3,4,5].map(n=>`<button type="button" class="sentence-score ${score===n?'selected':''}" data-rate-key="${esc(item.key)}" data-score="${n}" aria-pressed="${score===n}" title="${n} 分：${scoreNames[n]}" aria-label="自评 ${n} 分">${n}</button>`).join('')}<span>${score?esc(scoreNames[score]):'按自己的熟悉程度打分'}</span></div>
  <details class="sentence-compose" data-compose-key="${esc(item.key)}" ${opened.has(item.key)?'open':''}><summary>照着造句，让 AI 看看</summary><label><span>换成你自己的经历或想法</span><textarea rows="3" maxlength="3000" data-sentence-answer="${esc(item.key)}" placeholder="可以换主语、对象或情境，试着用上这个表达。">${esc(draft(item.key))}</textarea></label><div class="sentence-compose-actions"><button type="button" class="workspace-primary" data-check-key="${esc(item.key)}" ${pending.has(item.key)?'disabled':''}>${pending.has(item.key)?'AI 正在看…':'请 AI 看看'}</button><span class="sentence-check-status" role="status"></span></div><div class="sentence-feedback-host">${feedbackHtml(lastAttempt(item),item)}</div></details>
 </article>`;}
 function candidatesHtml(){const vacancies=snapshot.slots.filter(x=>!x).length;return `<details class="sentence-candidates" id="workspaceMaterials" ${candidatesOpen?'open':''}><summary>候补 ${snapshot.candidates.length} 条${vacancies?` · 本轮有 ${vacancies} 个空位，需逐条确认`:' · 本轮已满'}</summary><p>移出后不会自动补入。你确认哪一条，哪一条才进入本轮。</p><input type="search" id="candidateSearch" placeholder="搜索候补表达或情境…" value="${esc(query)}"><div id="candidateList"></div></details>`;}
 function render(next,callbacks){snapshot=next;api=callbacks;host=callbacks.host;
  if(!snapshot.items.length){host.innerHTML=`<section class="workspace-empty"><span class="workspace-kicker">正在练</span><h2>${snapshot.closed?'这一轮已收好':'本轮还没有卡片'}</h2><p>${snapshot.closed?'准备好后，可以用最近标记的最多 10 条开启下一轮。':'在表达库标记想练的句子；候补补入需要你确认。'}</p><button type="button" class="workspace-primary" id="emptyPrimary">${snapshot.closed&&snapshot.candidates.length?'开启下一轮':'去表达库标记'}</button></section>${snapshot.initialized&&!snapshot.closed&&snapshot.candidates.length?candidatesHtml():''}`;
   host.querySelector('#emptyPrimary').onclick=async event=>{if(snapshot.closed&&snapshot.candidates.length){event.currentTarget.disabled=true;try{await api.newWindow();}catch(error){event.currentTarget.disabled=false;api.notice(error.message);}}else api.openLibrary();};if(host.querySelector('#candidateList'))bindCandidates();return;}
  host.innerHTML=`<p class="sentence-learning-note">看着句子换成自己的经历来造句，AI 帮你看用法。自评 4 分表示可以独立造句，5 分表示能换场景使用。</p><div class="sentence-grid">${snapshot.items.map(card).join('')}</div>${candidatesHtml()}`;
  for(const details of host.querySelectorAll('[data-compose-key]'))details.addEventListener('toggle',()=>{if(details.open)opened.add(details.dataset.composeKey);else opened.delete(details.dataset.composeKey);});
  for(const input of host.querySelectorAll('[data-sentence-answer]'))input.oninput=()=>saveDraft(input.dataset.sentenceAnswer,input.value);
  for(const button of host.querySelectorAll('[data-rate-key]'))button.onclick=async()=>{
   const key=button.dataset.rateKey,card=button.closest('.sentence-card'),buttons=[...card.querySelectorAll('[data-rate-key]')];buttons.forEach(x=>x.disabled=true);
   try{const next=await api.rate(key,Number(button.dataset.score));snapshot=next;const score=next.items.find(x=>x.key===key)?.selfRating||0;card.querySelector('[data-score-summary]').textContent=`自评 ${score} / 5`;for(const b of buttons){const selected=Number(b.dataset.score)===score;b.classList.toggle('selected',selected);b.setAttribute('aria-pressed',String(selected));}card.querySelector('.sentence-rating > span').textContent=scoreNames[score]||'尚未自评';}
   catch(error){api.notice(error.message);}finally{buttons.forEach(x=>x.disabled=false);}
  };
  for(const button of host.querySelectorAll('[data-check-key]'))button.onclick=async()=>{
   const key=button.dataset.checkKey;if(pending.has(key))return;
   const item=snapshot.items.find(x=>x.key===key),card=button.closest('.sentence-card'),answer=card.querySelector('textarea').value.trim(),status=card.querySelector('.sentence-check-status');
   if(!answer){status.textContent='先写一句你自己的表达。';return;}
   pending.add(key);button.disabled=true;button.textContent='AI 正在看…';status.textContent='';
   try{const result=await api.check({key,answer});const value={id:result.attemptId,roundId:snapshot.windowId,answer,reference:item.better,feedback:result.feedback};responses.set(key,value);if(result.snapshot)snapshot=result.snapshot;
    const live=[...host.querySelectorAll('[data-training-card]')].find(x=>x.dataset.trainingCard===key);if(live){live.querySelector('.sentence-feedback-host').innerHTML=feedbackHtml(value,item);bindAdoptions(live);live.querySelector('.sentence-check-status').textContent=result.notice||'可以参考反馈，再调整你的造句。';}
   }catch(error){status.textContent=error.message||'暂时无法检查，请重试；你的造句仍保留。';}
   finally{pending.delete(key);const live=[...host.querySelectorAll('[data-check-key]')].find(x=>x.dataset.checkKey===key);if(live){live.disabled=false;live.textContent='请 AI 看看';}}
  };
  bindAdoptions();bindCandidates();
 }
 function bindCandidates(){
  const details=host.querySelector('#workspaceMaterials');if(details)details.addEventListener('toggle',()=>{candidatesOpen=details.open;});
  const input=host.querySelector('#candidateSearch');if(!input)return;input.oninput=()=>{query=input.value;shown=10;renderCandidates();};renderCandidates();
 }
 function renderCandidates(){
  const list=host.querySelector('#candidateList');if(!list)return;const items=snapshot.candidates.filter(x=>[x.better,x.personalContext,x.situation].join(' ').toLowerCase().includes(query.trim().toLowerCase()));const full=snapshot.items.length>=10;
  list.innerHTML=items.slice(0,shown).map(x=>`<div class="sentence-candidate"><div><strong>${esc(x.better)}</strong><p>${esc(x.personalContext||x.situation||'')}</p></div><button type="button" class="queue-card-action" data-confirm-candidate="${esc(x.key)}" ${full?'disabled':''}>确认补入</button></div>`).join('')+(items.length>shown?'<button type="button" class="workspace-link" id="moreCandidates">查看更多候补</button>':'');
  for(const button of list.querySelectorAll('[data-confirm-candidate]'))button.onclick=async()=>{button.disabled=true;try{await api.admit(button.dataset.confirmCandidate);}catch(error){button.disabled=false;api.notice(error.message);}};
  const more=list.querySelector('#moreCandidates');if(more)more.onclick=()=>{shown+=10;renderCandidates();};
 }
 function manage(){const details=host?.querySelector('#workspaceMaterials');if(details){details.open=true;details.scrollIntoView({behavior:'smooth',block:'nearest'});}}
 root.NuanceWorkspace={render,manage};
})();
