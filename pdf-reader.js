import {getDocument,GlobalWorkerOptions,TextLayer,PasswordResponses} from './vendor/pdfjs/pdf.mjs';
import {sendFromReader} from './pdf-reader-bridge.js';
GlobalWorkerOptions.workerSrc=new URL('./vendor/pdfjs/pdf.worker.mjs',import.meta.url).href;
const $=id=>document.getElementById(id);
let pdf=null,loading=null,renderTask=null,textTask=null,generation=0,fileName='',pageNumber=1,readKey='';
let renderQueue=Promise.resolve();
const selectionTools=NuancePdfSelection.install($('textLayer'));
const status=text=>{$('status').textContent=text;};
function controls(enabled){for(const id of ['previous','next','pageNumber','zoom'])$(id).disabled=!enabled;if(enabled){$('previous').disabled=pageNumber<=1;$('next').disabled=pageNumber>=pdf.numPages;}}
async function openFile(file){
 if(!file)return;
 if(file.size>50*1024*1024){status('第一版支持 50 MB 以内的 PDF。');return;}
 const ticket=++generation;controls(false);status('正在打开本地 PDF…');
 renderTask?.cancel();textTask?.cancel();await loading?.destroy();pdf=null;loading=null;
 try{
  const data=new Uint8Array(await file.arrayBuffer());if(ticket!==generation)return;
  if(!new TextDecoder().decode(data.subarray(0,1024)).includes('%PDF-'))throw Error('文件不是有效的 PDF');
  loading=getDocument({data,cMapUrl:new URL('./vendor/pdfjs/cmaps/',import.meta.url).href,cMapPacked:true,standardFontDataUrl:new URL('./vendor/pdfjs/standard_fonts/',import.meta.url).href,wasmUrl:new URL('./vendor/pdfjs/wasm/',import.meta.url).href,isEvalSupported:false,useWasm:false,enableScripting:false});
  loading.onPassword=(update,reason)=>{const value=prompt(reason===PasswordResponses.INCORRECT_PASSWORD?'密码不正确，请重新输入 PDF 密码：':'此 PDF 需要密码（仅在本机使用）：');if(value===null){void loading.destroy();return;}update(value);};
  const doc=await loading.promise;if(ticket!==generation){await doc.destroy();return;}
  pdf=doc;fileName=file.name;readKey=`nuance-pdf-position:${file.name}:${file.size}:${file.lastModified}`;
  let remembered=1;try{remembered=Number(localStorage.getItem(readKey))||1;}catch(_){}
  pageNumber=Math.max(1,Math.min(pdf.numPages,remembered));$('fileName').textContent=fileName;document.title=`${fileName} · Nuance PDF`;
  $('pageCount').textContent=pdf.numPages;$('pageNumber').max=pdf.numPages;$('empty').hidden=true;$('pdfPage').hidden=false;
  await render();
 }catch(error){if(ticket===generation){status('打开失败：'+(error.message||'请换一个 PDF 重试'));$('empty').hidden=false;$('pdfPage').hidden=true;controls(false);}}
 finally{$('pdfFile').value='';}
}
function render(){
 renderTask?.cancel();textTask?.cancel();
 const ticket=++generation;
 renderQueue=renderQueue.catch(()=>{}).then(async()=>{
  if(!pdf||ticket!==generation)return;
  controls(false);window.getSelection()?.removeAllRanges();status('正在显示页面…');
  try{
   const page=await pdf.getPage(pageNumber);if(ticket!==generation)return;
   const base=page.getViewport({scale:1});
   const width=Math.max(280,$('reader').clientWidth-48);
   const scale=$('zoom').value==='fit'?Math.min(1.6,width/base.width):Number($('zoom').value);
   const viewport=page.getViewport({scale});const canvas=$('canvas'),layer=$('textLayer');
   const ratio=Math.min(devicePixelRatio||1,2,Math.sqrt(16000000/(viewport.width*viewport.height)));
   canvas.width=Math.ceil(viewport.width*ratio);canvas.height=Math.ceil(viewport.height*ratio);canvas.style.width=viewport.width+'px';canvas.style.height=viewport.height+'px';
   $('pdfPage').style.width=viewport.width+'px';$('pdfPage').style.height=viewport.height+'px';$('pdfPage').style.setProperty('--scale-factor',String(scale));$('pdfPage').style.setProperty('--user-unit',String(page.userUnit||1));
   selectionTools.reset();layer.replaceChildren();
   renderTask=page.render({canvasContext:canvas.getContext('2d'),viewport,transform:ratio!==1?[ratio,0,0,ratio,0,0]:null});await renderTask.promise;if(ticket!==generation)return;
   const text=await page.getTextContent();if(ticket!==generation)return;
   textTask=new TextLayer({textContentSource:text,container:layer,viewport});await textTask.render();selectionTools.prepare();
   if(ticket!==generation)return;
   $('pageNumber').value=pageNumber;try{localStorage.setItem(readKey,String(pageNumber));}catch(_){}
   status(text.items.some(x=>x.str?.trim())?'选中文字，即可翻译、收藏或对比。':'这一页没有可选择的文字，可能是扫描图片。第一版暂不支持 OCR。');controls(true);
  }catch(error){if(ticket===generation){status('页面显示失败：'+error.message);controls(Boolean(pdf));}}
 });return renderQueue;
}
function excerpt(range){return selectionTools.context(range);}
NuanceSelectionCapture(sendFromReader,{selectionText:range=>selectionTools.text(range),contextFor:excerpt,sourceFor:range=>({fileName,page:pageNumber,excerpt:excerpt(range)}),showLauncher:false});
$('selectionMode').addEventListener('change',()=>{selectionTools.setMode($('selectionMode').value);status($('selectionMode').value==='english'?'只选英文：拖选可跳过中文和行号；双击可选词。':'全部文字：保留中英文原文。');});
$('pdfFile').addEventListener('change',event=>openFile(event.target.files[0]));$('chooseFile').addEventListener('click',()=>$('pdfFile').click());
$('previous').addEventListener('click',()=>{if(pdf&&pageNumber>1){pageNumber--;void render();}});$('next').addEventListener('click',()=>{if(pdf&&pageNumber<pdf.numPages){pageNumber++;void render();}});
$('pageNumber').addEventListener('change',()=>{if(pdf){pageNumber=Math.max(1,Math.min(pdf.numPages,Number.parseInt($('pageNumber').value)||1));void render();}});$('zoom').addEventListener('change',()=>void render());
document.addEventListener('dragover',event=>event.preventDefault());document.addEventListener('drop',event=>{event.preventDefault();if(event.dataTransfer.files[0])void openFile(event.dataTransfer.files[0]);});
let resizeTimer;window.addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{if(pdf&&$('zoom').value==='fit')void render();},200);});
