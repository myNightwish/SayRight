import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync('tutor-server.mjs','utf8');
function setup(fetcher) {
 const context={fetch:fetcher,UPSTASH_URL:'https://redis.test',UPSTASH_TOKEN:'test',SYNC_PERSISTENT:true,AbortSignal,memStore:new Map(),EMPTY_STATE:()=>({corrections:{},sceneSaves:{},sceneScripts:{},drillState:{},tombstones:{}})};
 vm.createContext(context);
 vm.runInContext(source.slice(source.indexOf('async function redisCommand'),source.indexOf('// 直接调用模型')),context);
 return context;
}
test('CAS conflict reloads latest state and preserves both devices',async()=>{
 let raw=null,first=true;
 const s=setup(async(_url,opts)=>{
  const cmd=JSON.parse(opts.body);let result;
  if(cmd[0]==='GET') result=raw;
  else if(first){first=false;raw=JSON.stringify({corrections:{other:{savedAt:1}},tombstones:{}});result=0;}
  else {assert.equal(cmd[4],raw);raw=cmd[5];result=1;}
  return {ok:true,json:async()=>({result})};
 });
 const state=await s.mergeStoredState('bucket',{corrections:{mine:{savedAt:2}}});
 assert.ok(state.corrections.mine);assert.ok(state.corrections.other);
});
test('Redis errors propagate instead of returning false success',async()=>{
 const s=setup(async()=>({ok:false,status:503}));
 await assert.rejects(s.mergeStoredState('bucket',{}),/503/);
});
test('newer deletion survives merging an old local collection',()=>{
 const s=setup();const state=s.mergeStates({corrections:{},tombstones:{old:20}},{corrections:{old:{savedAt:10},fresh:{savedAt:30}}});
 assert.equal(state.corrections.old,undefined);assert.ok(state.corrections.fresh);
});
