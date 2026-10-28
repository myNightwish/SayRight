import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
test('star storage echoes and sync acknowledgements preserve the live card',async()=>{
 const source=fs.readFileSync('collection.js','utf8');let handler,renders=0,syncs=0;
 let stored={example:{better:'An example',savedAt:100,stars:0,studyState:'inbox'}};
 const classes=new Set(),cardClasses=new Set();
 const star={dataset:{toggleStar:'example'},classList:{toggle:(key,on)=>on?classes.add(key):classes.delete(key)},setAttribute(){},removeAttribute(){},closest:()=>({classList:{toggle:(key,on)=>on?cardClasses.add(key):cardClasses.delete(key)}})};
 const ctx={collectionView:'library',windowSignature:()=>'',queueData:{},NuanceQueueStore:{run:async()=>({corrections:structuredClone(stored),drillState:{}})},NuanceQueue:{snapshot:()=>({})},renderQueueOverview(){},pendingStars:new Set(),allItems:[{key:'example',...stored.example}],NuanceLearning:{stateOf:x=>x.studyState||'inbox'},getCorrections:async()=>structuredClone(stored),applyFilter(){renders++;},window:{NuanceSync:{syncSoon(){syncs++;}}},listEl:{addEventListener:(_,fn)=>{handler=fn;}},alert:message=>assert.fail(message)};
 vm.createContext(ctx);
 vm.runInContext(source.slice(source.indexOf('async function load('),source.indexOf('listEl.addEventListener("click"')),ctx);
 ctx.setCorrections=async map=>{stored=structuredClone(map);await ctx.load({skipUnchanged:true});};
 vm.runInContext(source.slice(source.indexOf('listEl.addEventListener("click"'),source.indexOf('  const practice=event.target'))+'});',ctx);
 for(const expected of [true,false]){
  await handler({target:{closest:selector=>selector==='[data-toggle-star]'?star:null},preventDefault(){},stopPropagation(){}});
  assert.equal(classes.has('is-starred'),expected);assert.equal(cardClasses.has('starred'),expected);
  await ctx.load({skipUnchanged:true});assert.equal(renders,0);
  assert.equal(ctx.pendingStars.size,0);assert.equal(stored.example.studyState,'inbox');assert.equal(stored.example.createdAt,100);
 }
 assert.equal(syncs,2);
});
