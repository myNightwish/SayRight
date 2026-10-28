import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync('collection.js','utf8');
const load=source.slice(source.indexOf('async function load('),source.indexOf('listEl.addEventListener("click"'));
test('star updates do not move cards and unchanged sync never rebuilds their DOM',async()=>{
 const map={older:{createdAt:10,savedAt:1000,stars:1},newer:{createdAt:20,savedAt:20,stars:0}};
 const c={allItems:[],collectionView:'library',windowSignature:()=>'',queueData:{},NuanceQueueStore:{run:async()=>({corrections:map,drillState:{}})},NuanceQueue:{snapshot:()=>({})},renderQueueOverview(){},renders:0,applyFilter(){c.renders++;}};vm.createContext(c);vm.runInContext(load,c);
 await c.load();assert.equal(c.allItems[0].key,'newer');assert.equal(c.renders,1);
 map.older.savedAt=2000;map.older.stars=0;Object.assign(c.allItems[1],map.older);
 await c.load({skipUnchanged:true});assert.equal(c.renders,1);assert.equal(c.allItems[1].key,'older');
 map.newer.note='external change';await c.load({skipUnchanged:true});assert.equal(c.renders,2);
});
