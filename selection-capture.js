// Isolated content script: no page text is transmitted until the learner clicks.
(function () {
  function installSelectionCapture(sendMessage, options={}) {
    const send=message=>sendMessage({...message,...(selected?.source?{pdfSource:selected.source}:{})});
    const host=document.createElement('div');host.setAttribute('data-nuance-capture','');
    const shadow=host.attachShadow({mode:'open'});
    const style=document.createElement('style');style.textContent=`
      :host{all:initial;position:fixed;z-index:2147483647;display:none;color:#251e3d;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
      *{box-sizing:border-box} .panel{width:min(350px,calc(100vw - 24px));padding:16px;background:#fff;border:1px solid #e2dcf4;border-radius:16px;box-shadow:0 12px 42px #24154230}
      .mini{max-width:calc(100vw - 24px);flex-wrap:wrap;display:flex;align-items:center;gap:4px;background:#fff;border:1px solid #dcd3f6;border-radius:18px;padding:5px;box-shadow:0 6px 22px #24154225}
      button{font:inherit;cursor:pointer;border:0;border-radius:10px;padding:8px 12px;color:#fff;background:#6d48df}button:disabled{opacity:.6;cursor:wait}
      .mini .icon{width:40px;height:40px;padding:10px;border-radius:13px;display:grid;place-items:center;background:transparent;color:#6d48df}.mini .icon:hover{background:#eee8fc}.mini .icon:active{background:#e1d5fa}.mini .icon svg{width:20px;height:20px;display:block}
      .secondary{background:#f3effc;color:#59448b}.close{float:right;background:transparent;color:#756b8e;padding:0 5px;font-size:20px}
      p{margin:8px 0;overflow-wrap:anywhere}.quote{color:#635779;border-left:3px solid #d7caf5;padding-left:10px;max-height:100px;overflow:auto;white-space:pre-wrap}
      .hint{color:#7b728a;font-size:12px}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}textarea{font:inherit;width:100%;min-height:90px;padding:8px;border:1px solid #cfc3e8;border-radius:8px}
      strong{display:block;margin-top:8px}button:focus-visible,textarea:focus-visible{outline:2px solid #7c5cff;outline-offset:3px}
    `;shadow.append(style);const surface=document.createElement('div');shadow.append(surface);
    document.documentElement.append(host);
    let selected=null,busy=false,saved=null;
    // The clipboard is read only from a paste event in our focused dialog.
    const launcher=document.createElement('button');launcher.textContent='＋ 记录截图';launcher.type='button';
    launcher.style.cssText='position:fixed;right:16px;bottom:20px;z-index:2147483646;border:1px solid #d9cef4;border-radius:24px;padding:9px 14px;background:white;color:#6544b0;cursor:pointer;font:13px sans-serif';
    launcher.addEventListener('click',openImage);if(options.showLauncher!==false)document.documentElement.append(launcher);
    function openImage(){
      if(busy)return;
      saved={image:true};const panel=shell();position({left:innerWidth-374,bottom:Math.max(12,innerHeight-440)});
      panel.append(node('strong','粘贴 AI 的对比截图'),node('p','点击下面后按 ⌘V / Ctrl+V。自动提取原表达 → 调整后的表达，不会再次润色。','hint'));
      const target=document.createElement('textarea');target.placeholder='在这里粘贴图片';target.setAttribute('aria-label','粘贴对比截图');
      target.addEventListener('paste',event=>{const file=[...event.clipboardData.items].find(x=>x.kind==='file'&&x.type.startsWith('image/'))?.getAsFile();if(file){event.preventDefault();readImage(file);}});
      const file=document.createElement('input');file.type='file';file.accept='image/png,image/jpeg,image/webp';file.addEventListener('change',()=>{if(file.files[0])readImage(file.files[0]);});
      panel.append(target,node('p','也可以选择图片。仅发送这张截图给已配置的模型；保存识别文字，不保存原图。','hint'),file);target.focus();
    }
    async function readImage(file){
      if(busy)return;if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>5*1024*1024){alert('请使用不超过 5 MB 的 PNG、JPEG 或 WebP 图片');return;}
      busy=true;const panel=shell();panel.append(node('p','正在识别并整理对比，完成后自动记下…'));
      try{
        const image=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('图片读取失败'));reader.readAsDataURL(file);});
        const preview=document.createElement('img');preview.src=image;preview.alt='本次粘贴的截图';preview.style.cssText='max-width:100%;max-height:140px;object-fit:contain';panel.append(preview);
        const result=await send({type:'nuance:feedback-image',image});if(!result?.ok)throw new Error(result?.error||'识别失败，请确认本机服务运行并连通内网');
        panel.replaceChildren(button('×',hide,'close'),node('strong',`${result.existed?'已记录过':'已记下'} ${result.item.adjustments.length} 组调整`),node('p','识别可能有误，请核对原文。没有自动增加复习任务。','hint'));
        const rows=node('div','');rows.style.cssText='max-height:260px;overflow:auto';
        for(const row of result.item.adjustments){rows.append(node('p',row.before+' → '+row.after),node('p',row.reason,'hint'));}
        panel.append(rows,button('打开表达库',()=>send({type:'nuance:open-library'})));
      }catch(error){panel.replaceChildren(button('×',hide,'close'),node('p',error.message),button('重新粘贴',()=>{busy=false;openImage();}));}finally{busy=false;}
    }

    const node=(tag,text,cls)=>{const el=document.createElement(tag);el.textContent=text;if(cls)el.className=cls;return el;};
    function button(text,handler,cls){const el=node('button',text,cls);el.type='button';if(text==='×')el.setAttribute('aria-label','关闭');el.addEventListener('click',handler);return el;}
    function iconButton(label,paths,handler){
      const el=button('',handler,'icon');el.title=label;el.setAttribute('aria-label',label);
      const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
      for(const [key,value] of Object.entries({viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'1.8','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true'}))svg.setAttribute(key,value);
      for(const d of paths){const path=document.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d',d);svg.append(path);}el.append(svg);return el;
    }
    function hide(){host.style.display='none';if(!busy){selected=null;saved=null;}}
    function shell(){surface.replaceChildren();const panel=node('div','','panel');panel.setAttribute('role','dialog');panel.setAttribute('aria-label','下次帮我用上');panel.append(button('×',hide,'close'));surface.append(panel);return panel;}
    function fitPanel(){host.style.top=`${Math.max(12,Math.min(parseFloat(host.style.top)||12,innerHeight-surface.getBoundingClientRect().height-12))}px`;}
    function position(rect){host.style.left=`${Math.max(12,Math.min(rect.left,innerWidth-362))}px`;host.style.top=`${Math.max(12,Math.min(rect.bottom+8,innerHeight-120))}px`;host.style.display='block';}
    function contextFor(range){
      if(options.contextFor)return options.contextFor(range);
      const anchor=range.commonAncestorContainer.nodeType===Node.ELEMENT_NODE?range.commonAncestorContainer:range.commonAncestorContainer.parentElement;
      const message=anchor.closest('[data-message-author-role],article');
      const block=message||anchor.closest('blockquote,p,li,section')||anchor;
      let text=block.textContent||'';const needle=selected.text;const index=text.indexOf(needle);
      text=text.slice(Math.max(0,index-1500),Math.max(0,index)+needle.length+1800);
      if(!message && !block.matches('article'))text=[block.previousElementSibling?.textContent?.slice(-700)||'',text,block.nextElementSibling?.textContent?.slice(0,700)||''].join('\n');
      return text.slice(0,5000);
    }
    async function capture(){
      if(busy||!selected)return;busy=true;
      // Selection and the nearby source context are read only after this deliberate click.
      const context=contextFor(selected.range);const text=selected.text;
      const panel=shell();panel.append(node('p',text,'quote'),node('p','正在整理你下次会用到的情境…'));panel.setAttribute('aria-busy','true');
      try{
        const result=await send({type:'nuance:capture',text,context});
        if(!result?.ok)throw new Error(result?.error||'没有保存成功，请重试');
        saved=result;showSaved();
      }catch(error){const errorPanel=shell();errorPanel.append(node('p',text,'quote'),node('p',error.message),button('重试',capture));}
      finally{busy=false;}
    }
    async function lookup(){
      if(busy||!selected)return;busy=true;
      const text=selected.text,context=contextFor(selected.range).slice(0,3000);
      const panel=shell();panel.append(node('strong',text),node('p','正在查看当前语境里的意思和用法…'));fitPanel();
      try{
        const result=await send({type:'nuance:dictionary',text,context});if(!result?.ok)throw new Error(result?.error||'查询失败');
        saved={dictionary:true};const entry=result.entry;
        panel.replaceChildren(button('×',hide,'close'),node('strong',text));
        const content=node('div','');content.style.cssText='max-height:300px;overflow:auto';
        content.append(node('strong','这里的意思'),node('p',entry.translation),node('p',entry.meaning),node('strong','怎么用'),node('p',entry.usage),node('p',entry.collocations.join(' · ')));
        for(const example of entry.examples)content.append(node('p',example.en),node('p',example.zh,'hint'));
        panel.append(content,node('p','AI 结合上下文解释，例句为生成示例。','hint'));
        const status=node('p','','hint');status.setAttribute('role','status');
        const save=button('收藏词义和用法',async()=>{
          save.disabled=true;
          try{const response=await send({type:'nuance:save-dictionary',text,context,entry});if(!response?.ok)throw new Error(response?.error||'保存失败');save.textContent=response.existed?'已收藏过':'已收藏';status.textContent=response.existed?'已有记录保持不变。':'已保留原文语境、搭配和例句；暂存，不增加复习任务。';}
          catch(error){status.textContent=error.message;save.disabled=false;}
          fitPanel();
        });panel.append(save,button('继续阅读',hide,'secondary'),status);fitPanel();
      }catch(error){panel.replaceChildren(button('×',hide,'close'),node('p',error.message),button('重试',lookup));fitPanel();}finally{busy=false;}
    }
    function showFeedback(result){
      saved={feedback:true};const panel=shell();
      panel.append(node('strong',`${result.existed?'已记录过':'已记下'} ${result.item.adjustments.length} 组调整`),node('p',result.item.personalContext),node('p',result.localOnly?'已保存在插件。可以关闭继续阅读，设置同步口令后可同步。':'已保存在插件，后台继续同步。可以关闭，继续当前对话。','hint'));
      const rows=node('div','');rows.style.cssText='max-height:260px;overflow:auto';
      for(const row of result.item.adjustments){rows.append(node('p',row.before+' → '+row.after),node('p',row.reason,'hint'));}
      panel.append(rows,node('p','没有自动增加复习任务。','hint'),button('继续阅读',hide),button('查看表达库',()=>send({type:'nuance:open-library'}),'secondary'));fitPanel();
    }
    async function captureFeedback(){
      if(busy||!selected)return;busy=true;
      const text=selected.text;const panel=shell();panel.append(node('p','正在记下选中内容中的调整…'),node('p','你可以继续阅读，完成后在这里显示结果。','hint'));fitPanel();
      try{const result=await send({type:'nuance:feedback-text',text});if(!result?.ok)throw new Error(result?.error||'没有保存成功');showFeedback(result);}
      catch(error){const panel=shell();panel.append(node('p',error.message),button('重试',captureFeedback),button('粘贴对比截图',openImage,'secondary'),button('关闭',hide,'secondary'));fitPanel();}
      finally{busy=false;}
    }
    function showSaved(){
      const panel=shell();panel.append(node('p',saved.text,'quote'),node('strong','你想表达的意思'),node('p',saved.personalContext));
      panel.append(node('strong',saved.active?'已标记想练':'已暂存'),node('p',saved.active?'到正在练里学习和造句；本轮已有卡片时，在候补中确认补入。':'先保留这次发现，可以到正在练中选择或调整本轮材料。'));
      panel.append(node('p',saved.preview?'这是隔离体验，已在本机预览保存，不会写入正式表达库。':(saved.localOnly?'已保存在插件；设置同步口令后可跨设备同步。':'已保存在插件，后台会同步到你的表达库。'),'hint'));
      const actions=node('div','','actions');actions.append(button(saved.active?'去正在练':'打开表达库',()=>send({type:'nuance:practice',key:saved.key})),button('修改练习情境',editCue,'secondary'));panel.append(actions);
      host.style.top=`${Math.max(12,Math.min(parseFloat(host.style.top)||12,innerHeight-panel.getBoundingClientRect().height-12))}px`;
    }
    function editCue(){
      const panel=shell();panel.append(node('strong','你想表达的意思'));
      const meaning=document.createElement('textarea');meaning.value=saved.personalContext;meaning.maxLength=700;meaning.setAttribute('aria-label','你想表达的意思');panel.append(meaning,node('strong','下次练习给你的情境'));
      const input=document.createElement('textarea');input.value=saved.practiceCue;input.maxLength=700;input.setAttribute('aria-label','练习情境');panel.append(input);
      const status=node('p','','hint');status.setAttribute('role','status');
      const save=button('保存修改',async()=>{
        save.disabled=true;
        try{const result=await send({type:'nuance:edit-cue',key:saved.key,cue:input.value,personalContext:meaning.value});if(!result?.ok)throw new Error(result?.error||'保存失败');saved.practiceCue=input.value;saved.personalContext=meaning.value;showSaved();}
        catch(error){status.textContent=error.message;save.disabled=false;}
      });panel.append(save,button('取消',showSaved,'secondary'),status);input.focus();
    }
    function showSelection(){
      if(busy)return;
      const selection=window.getSelection();
      if(!selection||selection.isCollapsed||!selection.rangeCount)return;
      const range=selection.getRangeAt(0);const text=(options.selectionText?options.selectionText(range):selection.toString()).trim();
      const anchor=range.commonAncestorContainer.nodeType===Node.ELEMENT_NODE?range.commonAncestorContainer:range.commonAncestorContainer.parentElement;
      if(!anchor||host.contains(anchor)||shadow.contains(anchor)||anchor.closest('input,textarea,select,[contenteditable="true"],[role="textbox"]')||text.length<1||text.length>20000)return;
      selected={text,range:range.cloneRange(),source:options.sourceFor?.(range)};saved=null;
      surface.replaceChildren();const mini=node('div','','mini');mini.setAttribute('role','toolbar');mini.setAttribute('aria-label','表达工具');
      const translate=iconButton('转化',['M4 7h13M14 4l3 3-3 3M20 17H7M10 14l-3 3 3 3'],lookup);
      const collect=iconButton('收藏',['M6 4h12v17l-6-4-6 4V4Z'],capture);
      const compare=iconButton('对比',['M9 4H4v16h5M15 4h5v16h-5M12 3v18M7 9h2M15 15h2'],text.length>=20?captureFeedback:openImage);
      translate.disabled=text.length>1200;collect.disabled=text.length<2||text.length>1200;
      mini.append(translate,collect,compare);surface.append(mini);position(range.getBoundingClientRect());
    }
    // Defer until the browser has committed keyboard/mouse selection.
    document.addEventListener('mouseup',event=>{if(event.composedPath().includes(host))return;queueMicrotask(showSelection);});
    document.addEventListener('keyup',event=>{if(event.key==='Escape')hide();else if(event.shiftKey)queueMicrotask(showSelection);});
    document.addEventListener('pointerdown',event=>{if(!busy&&!event.composedPath().includes(host))hide();});
    window.addEventListener('scroll',()=>{if(!busy&&!saved)hide();},{passive:true});
  }
  globalThis.NuanceSelectionCapture=installSelectionCapture;
  if(!document.documentElement.hasAttribute('data-nuance-pdf-reader')&&typeof chrome!=='undefined'&&chrome.runtime?.id)installSelectionCapture(message=>chrome.runtime.sendMessage(message));
})();
