// Selection helpers for bilingual PDFs. Visible geometry defines reading order.
(function(){
 const root=typeof window==='undefined'?globalThis:window;
 function rowsOf(items){
  const rows=[];
  for(const item of [...items].sort((a,b)=>a.y-b.y||a.x-b.x)){
   let row=rows.find(r=>Math.abs(r.y-item.y)<Math.max(2,Math.min(r.h,item.h)*.4));
   if(!row){row={y:item.y,h:item.h,items:[]};rows.push(row);}row.items.push(item);
  }
  return rows.sort((a,b)=>a.y-b.y).map(r=>r.items.sort((a,b)=>a.x-b.x));
 }
 const hasHan=text=>/\p{Script=Han}/u.test(text);
 function join(parts){return parts.join(' ').replace(/\s+([,.;:!?])/g,'$1').replace(/([“‘(])\s+/g,'$1').replace(/\s+([”’)])/g,'$1').replace(/\s+/g,' ').trim();}
 function install(layer){
  let mode='english',spans=[],rows=[],drag=null;
  function prepare(){
   spans=[...layer.querySelectorAll('span')].filter(el=>el.firstChild?.nodeType===3&&el.textContent.trim());
   rows=rowsOf(spans.map(el=>{const r=el.getBoundingClientRect();return {el,x:r.left,y:r.top+r.height/2,h:r.height};}));
   // A number is a gutter label only when a separate text run follows to its right.
   for(const row of rows)for(const [index,item] of row.entries()){
    const gutter=index===0&&/^\s*\d{1,5}\s*$/.test(item.el.textContent)&&row.length>1&&row[1].x>item.x+item.el.getBoundingClientRect().width+3;
    item.el.dataset.pdfSkip=String(mode==='english'&&(gutter||hasHan(item.el.textContent)));
   }
  }
  function allowed(el){return el.dataset.pdfSkip!=='true';}
  function pieces(range,includeContext=false){
   const out=[];
   for(const row of rows){const line=[];
    for(const {el} of row){if(!allowed(el)||(!includeContext&&!range.intersectsNode(el)))continue;
     let value=el.textContent;
     if(!includeContext){
      const part=document.createRange();part.selectNodeContents(el);
      if(el.contains(range.startContainer))part.setStart(range.startContainer,range.startOffset);
      if(el.contains(range.endContainer))part.setEnd(range.endContainer,range.endOffset);
      value=part.toString();
     }
     if(value.trim())line.push(value);
    }
    if(line.length)out.push(join(line));
   }
   return out;
  }
  function text(range){return join(pieces(range));}
  function context(range){
   const selected=text(range),all=join(pieces(range,true));const index=all.indexOf(selected);
   return index>=0?all.slice(Math.max(0,index-850),index+selected.length+850).slice(0,3000):selected;
  }
  function point(x,y){
   const candidates=spans.filter(allowed);let best=null,score=Infinity;
   for(const el of candidates){const r=el.getBoundingClientRect();const dy=Math.max(r.top-y,0,y-r.bottom),dx=Math.max(r.left-x,0,x-r.right);const d=dy*10000+dx;if(d<score){score=d;best=el;}}
   if(!best)return null;
   const node=best.firstChild,length=node.length;let offset=0,distance=Infinity;
   // Glyph bounds follow the actual PDF text transform, including horizontally scaled runs.
   for(let i=0;i<length;i++){const r=document.createRange();r.setStart(node,i);r.setEnd(node,i+1);const box=r.getBoundingClientRect();for(const [pos,value] of [[box.left,i],[box.right,i+1]]){const delta=Math.abs(pos-x);if(delta<distance){distance=delta;offset=value;}}}
   return {node,offset};
  }
  layer.addEventListener('mousedown',event=>{
   if(event.button!==0||event.shiftKey||event.detail>1)return;
   const start=point(event.clientX,event.clientY);if(!start)return;
   event.preventDefault();drag=start;window.getSelection().setBaseAndExtent(start.node,start.offset,start.node,start.offset);
  });
  document.addEventListener('mousemove',event=>{if(!drag||!(event.buttons&1))return;const end=point(event.clientX,event.clientY);if(end)window.getSelection().setBaseAndExtent(drag.node,drag.offset,end.node,end.offset);});
  document.addEventListener('mouseup',()=>{drag=null;});
  layer.addEventListener('copy',event=>{const selection=window.getSelection();if(selection?.rangeCount&&layer.contains(selection.anchorNode)){event.clipboardData.setData('text/plain',text(selection.getRangeAt(0)));event.preventDefault();}});
  return {prepare,text,context,setMode(value){mode=value==='all'?'all':'english';prepare();window.getSelection()?.removeAllRanges();},reset(){drag=null;spans=[];rows=[];}};
 }
 root.NuancePdfSelection={rowsOf,join,install};
})();
