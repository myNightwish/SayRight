(function(){
 const root=window,esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 function collector(host,source){
  const existing=host.querySelector('.dialogue-collector');if(existing){existing.hidden=!existing.hidden;return;}
  const panel=document.createElement('div');panel.className='dialogue-collector';
  panel.innerHTML=`<label>留下想会用的那一句或短语<textarea maxlength="1200" rows="3">${esc(source.text)}</textarea></label><div><button type="button" class="dialogue-save">收藏到表达库</button><span role="status"></span></div>`;
  panel.querySelector('button').onclick=async event=>{const button=event.currentTarget,status=panel.querySelector('[role=status]');button.disabled=true;
   try{await NuanceQueueStore.run({type:'dialogue-collect',sessionId:source.sessionId,messageId:source.messageId,text:panel.querySelector('textarea').value});status.textContent='已收藏，保留对话语境；没有加入正在练。';button.textContent='已收藏';}
   catch(error){status.textContent=error.message;button.disabled=false;}
  };host.append(panel);
 }
 function progressText(p){if(!p?.last)return '';const last=p.last,description=last.outcome==='used'?(last.repairedFrom?'调整后用上了核心表达':last.support==='independent'?'换着说，用上了核心表达':last.support==='unknown'?'用上了核心表达（帮助程度未确认）':'借助提示或参考用上了'):last.outcome==='alternative'?'用另一种说法表达清楚了':'这个用法还需要再试一次';return `上次在「${last.scene}」${description}`;}
 function history(host,drill){
  const sessions=NuanceConversation.snapshot(drill);const limit=Number(host.dataset.limit)||5,signature=JSON.stringify([limit,sessions]);if(host.dataset.signature===signature)return;host.dataset.signature=signature;
  const opened=new Set([...host.querySelectorAll('details[open]')].map(x=>x.dataset.session));
  host.innerHTML=sessions.length?sessions.slice(0,limit).map(session=>`<details class="dialogue-history-session" data-session="${esc(session.id)}" ${opened.has(session.id)?'open':''}><summary>${esc(session.scene)} <small>${new Date(session.at).toLocaleDateString('zh-CN')} · ${session.endedAt?'已结束':'未结束'}</small></summary><div class="dialogue-transcript">${session.entries.filter(x=>x.role).map(entry=>`<div class="dialogue-history-turn ${entry.role}"><strong>${entry.role==='me'?'你':'对方'}</strong><p>${esc(entry.text)}</p>${entry.role==='them'?`<button type="button" class="dialogue-bookmark" data-session-id="${esc(session.id)}" data-message-id="${esc(entry.id)}" aria-label="收藏这条回复" title="收藏这条回复"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 3h12v18l-6-4-6 4z"/></svg></button>`:''}${entry.feedback?.better?`<p class="dialogue-feedback-note">建议：${esc(entry.feedback.better)} · ${esc(entry.feedback.tip)}</p>`:''}${(entry.uses||[]).map(x=>`<p class="dialogue-feedback-note">${x.outcome==='used'?'用上核心表达':x.outcome==='alternative'?'另一种说法':'需要再试'} · ${x.support==='independent'?'未依赖语言提示':x.support==='unknown'?'帮助程度未确认':'本轮有提示或参考'}：${esc(x.evidence)}</p>`).join('')}</div>`).join('')}</div></details>`).join('')+(sessions.length>limit?'<button type="button" class="dialogue-save" data-more-dialogues>查看更多记录</button>':''):'<p class="dialogue-empty">开始对话后，回应和反馈会保存在这里。</p>';
  const more=host.querySelector('[data-more-dialogues]');if(more)more.onclick=()=>{host.dataset.limit=limit+5;history(host,drill);};
  for(const button of host.querySelectorAll('[data-message-id]'))button.onclick=()=>{const session=sessions.find(x=>x.id===button.dataset.sessionId),entry=session.entries.find(x=>x.id===button.dataset.messageId);collector(button.parentElement,{sessionId:session.id,messageId:entry.id,text:entry.text});};
 }
 root.NuanceDialogueUI={collector,progressText,history};
})();
