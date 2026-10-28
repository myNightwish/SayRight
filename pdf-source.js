// Only file name, page and a bounded excerpt are retained; never a local file path.
(function(){
 const root=typeof window==='undefined'?globalThis:window;
 function validate(value){
  if(!value||typeof value.fileName!=='string'||!value.fileName.trim()||value.fileName.length>200||/[\\/]/.test(value.fileName)||!Number.isInteger(value.page)||value.page<1||value.page>100000)return null;
  return {type:'pdf',fileName:value.fileName.trim(),page:value.page,excerpt:typeof value.excerpt==='string'?value.excerpt.slice(0,3000):''};
 }
 function attach(item,value){const source=validate(value);if(source){item.sourceDocument=source;item.sourceLabel=`${source.fileName} · 第 ${source.page} 页`;item.sourceUrl='';}return item;}
 root.NuancePdfSource={validate,attach};
})();
