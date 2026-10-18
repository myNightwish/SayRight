import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const empty = () => ({ corrections: {}, sceneSaves: {}, sceneScripts: {}, drillState: {}, tombstones: {} });
const tick = () => new Promise(r => setImmediate(r));
function setup(fetcher) {
  const data = new Map(), events = {}, calls = [];
  let timer;
  const context = { location: { protocol: 'http:', origin: 'http://localhost:8770' },
    localStorage: { getItem: k => data.get(k) ?? null, setItem: (k,v) => data.set(k,v) },
    window: { NUANCE_REMOTE_ORIGIN: 'https://say-50s9.onrender.com', addEventListener: (k,f) => events[k]=f, dispatchEvent() {} },
    document: { visibilityState:'hidden', addEventListener:(k,f)=>events[k]=f },
    CustomEvent: class {}, console, AbortSignal,
    setTimeout: f => { timer=f; return 1; }, clearTimeout:()=>{timer=null;},
    fetch: async (url,opts) => { calls.push({url,body:JSON.parse(opts.body)}); return fetcher ? fetcher(calls.length,opts) : {ok:true,json:async()=>empty()}; }
  };
  vm.runInNewContext(fs.readFileSync('sync.js','utf8'),context);
  return { context, data, events, calls, api:context.window.NuanceSync, timer:()=>timer };
}
test('local web shares remote environment; unchanged lifecycle events do not upload',async()=>{
 const s=setup(); await s.api.syncNow();
 assert.equal(s.calls[0].url,'https://say-50s9.onrender.com/sync');
 s.events.visibilitychange(); s.events.pagehide(); await tick();
 assert.equal(s.calls.length,1);
});
test('immediate upload cancels debounce and duplicate concurrent calls',async()=>{
 const s=setup(); await s.api.syncNow();
 s.data.set('corrections',JSON.stringify({a:{savedAt:1}}));s.api.syncSoon();
 await Promise.all([s.api.syncNow(),s.api.syncNow()]);
 assert.equal(s.timer(),null);assert.equal(s.calls.length,2);
});
test('new edits during request survive and are uploaded again',async()=>{
 let release;const gate=new Promise(r=>release=r);
 const s=setup(async n=>{if(n===1)await gate;return {ok:true,json:async()=>empty()};});
 await tick();s.data.set('corrections',JSON.stringify({new:{savedAt:2}}));
 release();await s.api.syncNow();
 assert.equal(s.calls.length,2);assert.ok(s.calls[1].body.corrections.new);
 assert.ok(JSON.parse(s.data.get('corrections')).new);
});
test('failed sync keeps data and retries on next trigger',async()=>{
 const s=setup(async n=>({ok:n>1,status:503,json:async()=>empty()}));
 await s.api.syncNow();s.data.set('corrections',JSON.stringify({a:{savedAt:1}}));
 await s.api.syncNow();assert.equal(s.calls.length,2);assert.ok(JSON.parse(s.data.get('corrections')).a);
});
test('incomplete response never overwrites local storage',async()=>{
 const s=setup(async()=>({ok:true,json:async()=>({})}));
 s.data.set('corrections',JSON.stringify({a:{savedAt:1}}));
 await s.api.syncNow();assert.ok(JSON.parse(s.data.get('corrections')).a);
});
