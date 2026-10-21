// Model-generated usage notes, never presented as quotations from a dictionary.
(function(){
 const root=typeof window==='undefined'?globalThis:window;
 const str=(v,max)=>typeof v==='string'&&v.trim()&&v.length<=max;
 function validate(v){
  if(!v||!str(v.meaning,700)||!str(v.translation,1200)||!str(v.usage,1000)||!Array.isArray(v.examples)||v.examples.length<1||v.examples.length>3||!Array.isArray(v.collocations)||v.collocations.length<1||v.collocations.length>5)return null;
  if(v.examples.some(x=>!x||!str(x.en,500)||!str(x.zh,500))||v.collocations.some(x=>!str(x,200)))return null;
  return {meaning:v.meaning.trim(),translation:v.translation.trim(),usage:v.usage.trim(),collocations:v.collocations.map(x=>x.trim()),examples:v.examples.map(x=>({en:x.en.trim(),zh:x.zh.trim()}))};
 }
 function save(map,text,value,context,source,now){
  const entry=validate(value);if(!entry||!str(text,1200))throw Error('用法内容不完整，没有保存');
  const key='dictionary:'+text.trim().toLowerCase()+':'+entry.meaning.toLowerCase();
  if(Object.hasOwn(map,key))return {map,key,item:map[key],existed:true};
  const note=[entry.meaning,'当前语境：'+entry.translation,entry.usage,'常见搭配：'+entry.collocations.join('；'),...entry.examples.map(x=>x.en+'\n'+x.zh)].join('\n\n');
  const item={origin:'dictionary',better:text.trim(),input:context.slice(0,3000),personalContext:entry.meaning,note,dictionary:entry,sourceLabel:source.title,sourceUrl:source.url,studyState:'inbox',stars:0,createdAt:now,savedAt:now};
  return {map:{...map,[key]:item},key,item,existed:false};
 }
 root.NuanceDictionary={validate,save};
})();
