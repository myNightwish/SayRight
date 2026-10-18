// 使用已有线上口令；不写入源码或命令行历史。node scripts/migrate-sync.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
const origin = 'https://sayright-x4a0.onrender.com';
const fields = ['corrections','sceneSaves','sceneScripts','drillState'];
function merge(a,b) {
 const out={tombstones:{...a.tombstones}};
 for(const [k,t] of Object.entries(b.tombstones||{})) out.tombstones[k]=Math.max(out.tombstones[k]||0,t);
 for(const field of fields) {
  out[field]={...a[field]};
  for(const [k,v] of Object.entries(b[field]||{})) if(!out[field][k] || (v.savedAt||0)>=(out[field][k].savedAt||0)) out[field][k]=v;
  if(['corrections','sceneSaves'].includes(field)) for(const [k,t] of Object.entries(out.tombstones)) if(out[field][k] && (out[field][k].savedAt||0)<=t) delete out[field][k];
 }
 return out;
}
async function password() {
 if(process.env.TUTOR_MIGRATION_KEY) return process.env.TUTOR_MIGRATION_KEY;
 if(!process.stdin.isTTY) throw new Error('请在交互式终端运行并输入线上口令');
 process.stdout.write('线上访问口令（不显示）：');
 process.stdin.setRawMode(true);process.stdin.resume();readline.emitKeypressEvents(process.stdin);
 return new Promise((resolve,reject)=>{
  let value='';
  const onKey=(str,key)=>{
   if(key?.ctrl && key.name==='c') {cleanup();reject(new Error('已取消'));}
   else if(key?.name==='return') {cleanup();resolve(value.trim());}
   else if(key?.name==='backspace') value=value.slice(0,-1);
   else if(str && !key?.ctrl) value+=str;
  };
  function cleanup(){process.stdin.off('keypress',onKey);process.stdin.setRawMode(false);process.stdin.pause();process.stdout.write('\n');}
  process.stdin.on('keypress',onKey);
 });
}
async function post(state,key) {
 const response=await fetch(`${origin}/sync`,{method:'POST',headers:{'Content-Type':'application/json','x-tutor-key':key},body:JSON.stringify(state),signal:AbortSignal.timeout(60000)});
 if(!response.ok) throw new Error(`线上同步 HTTP ${response.status}`);
 const result=await response.json();
 if(fields.some(f=>!result[f]) || !result.tombstones) throw new Error('线上响应不完整');
 return result;
}
const dir=path.resolve('backups',`sync-live-${new Date().toISOString().replace(/[:.]/g,'-')}`);
await fs.mkdir(dir,{recursive:true});
const save=async(name,data)=>fs.writeFile(path.join(dir,`${name}.json`),JSON.stringify(data,null,2),{mode:0o600});
try {
 const key=await password();if(!key) throw new Error('口令不能为空');
 const local=JSON.parse(await fs.readFile('local.json','utf8'));
 const snapshot=JSON.parse(await fs.readFile('online.json','utf8'));
 await save('local-original',local);await save('online-original',snapshot);
 // 再读取运行中的本地服务，纳入抓包后新增的数据；请求失败则停止，避免漏迁移。
 const response=await fetch('http://127.0.0.1:8770/sync',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(30000)});
 if(!response.ok) throw new Error(`本地服务 HTTP ${response.status}`);
 const liveLocal=await response.json();if(fields.some(f=>!liveLocal[f]))throw new Error('本地响应不完整');
 await save('local-live',liveLocal);
 const liveOnline=await post({},key);await save('online-before',liveOnline);
 const expected=merge(merge(merge(snapshot,local),liveLocal),liveOnline);
 await save('merged-preview',expected);
 const result=await post(expected,key);await save('online-write-response',result);
 const verified=await post({},key);await save('online-readback',verified);
 // 验证每条预期数据都存在或有更新的合法删除记录，并检查版本没有退回。
 const missing=[];
 for(const f of fields)for(const [k,v] of Object.entries(expected[f])) {
  const actual=verified[f][k];
  const deleted=['corrections','sceneSaves'].includes(f) && (verified.tombstones[k]||0)>=(v.savedAt||0);
  if((!actual || (actual.savedAt||0)<(v.savedAt||0)) && !deleted)missing.push({field:f,key:k});
 }
 await save('verification',{missing,counts:Object.fromEntries(fields.map(f=>[f,Object.keys(verified[f]).length]))});
 if(missing.length)throw new Error(`回读校验失败：${missing.length} 项，请保留备份排查`);
 console.log('迁移完成，回读校验通过。备份目录：',dir);
} catch(error) {console.error('迁移未完成：',error.message,'备份目录：',dir);process.exitCode=1;}
