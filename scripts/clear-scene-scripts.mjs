// Run after deploying the server update. Supply TUTOR_MIGRATION_KEY through the environment.
import fs from 'node:fs/promises';
const key=process.env.TUTOR_MIGRATION_KEY;
if(!key) throw new Error('需要现有线上访问口令 TUTOR_MIGRATION_KEY');
const dir=`backups/sync-live-clear-scripts-${Date.now()}`;
await fs.mkdir(dir,{recursive:true});
async function sync(body){
 const response=await fetch('https://nuance-drfi.onrender.com/sync',{method:'POST',headers:{'Content-Type':'application/json','x-tutor-key':key},body:JSON.stringify(body),signal:AbortSignal.timeout(45000)});
 if(!response.ok)throw new Error(`同步 HTTP ${response.status}`);
 return response.json();
}
const before=await sync({});
if(!before.sceneScripts||!before.corrections)throw new Error('备份响应不完整，停止清理');
await fs.writeFile(`${dir}/before.json`,JSON.stringify(before,null,2),{mode:0o600});
const result=await sync({clearSceneScripts:true});
await fs.writeFile(`${dir}/clear-response.json`,JSON.stringify(result,null,2),{mode:0o600});
if(!result.tombstones?.__sceneScriptsClearedBefore||Object.keys(result.sceneScripts||{}).length)throw new Error('线上尚未支持清理，或旧客户端重新上传；请先部署新版服务');
const verified=await sync({});
await fs.writeFile(`${dir}/readback.json`,JSON.stringify(verified,null,2),{mode:0o600});
if(Object.keys(verified.sceneScripts||{}).length)throw new Error('回读剧本不为空');
console.log('sceneScripts 已清空，回读通过。备份：',dir);
