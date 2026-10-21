// Preview adapter only. No production credentials, extension storage or cloud writes.
NuanceSelectionCapture(async message=>{
  try {
    const map=JSON.parse(localStorage.getItem('nuanceCapturePreviewCorrections')||'{}');
    if(message.type==='nuance:capture'){
      const existing = map[NuanceLearning.keyOf(message.text)];
      let generated = existing?.situation ? {personalContext:existing.personalContext,practiceCue:existing.situation,transferCue:existing.situations?.[0]||existing.situation} : null;
      if (!generated) {
        const response=await fetch('http://127.0.0.1:48773/capture',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:message.text,context:message.context}),signal:AbortSignal.timeout(110000)});
        const result=await response.json();if(!response.ok)throw new Error(result.error||'生成失败');
        generated=NuanceCapture.validate(result,message.text);if(!generated)throw new Error('情境不完整，没有保存');
      }
      const saved=NuanceCapture.captureInto(map,{text:message.text,title:document.title,url:location.href},generated,Date.now());
      localStorage.setItem('nuanceCapturePreviewCorrections',JSON.stringify(saved.map));
      return {ok:true,key:saved.key,text:saved.item.better,personalContext:saved.item.personalContext,practiceCue:saved.item.situation,active:saved.active,localOnly:true,preview:true};
    }
    if(message.type==='nuance:edit-cue'){
      map[message.key].situation=message.cue;map[message.key].personalContext=message.personalContext;map[message.key].savedAt=Date.now();localStorage.setItem('nuanceCapturePreviewCorrections',JSON.stringify(map));return {ok:true};
    }
    if(message.type==='nuance:practice'){location.href=`capture-preview-practice.html?capture=${encodeURIComponent(map[message.key].captureId)}`;return {ok:true};}
  } catch(error){return {ok:false,error:error.message};}
});
document.querySelector('#trySelection').addEventListener('click',()=>{
  const range=document.createRange();range.selectNodeContents(document.querySelector('#exampleExpression'));
  const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
  document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
});
