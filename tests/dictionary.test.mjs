import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const c={};vm.createContext(c);vm.runInContext(fs.readFileSync('dictionary-core.js','utf8'),c);const core=c.NuanceDictionary;
const entry={translation:'皮皮把杯子碰倒了。',meaning:'knock over：碰倒、撞翻',usage:'可分动词短语；代词放中间：knock it over。',collocations:['knock something over','knock it over'],examples:[{en:'I accidentally knocked my coffee over.',zh:'我不小心把咖啡碰翻了。'}]};
test('dictionary validates complete contextual usage, rejects incomplete or excessive model output',()=>{
 assert.ok(core.validate(entry));assert.equal(core.validate({...entry,examples:[]}),null);assert.equal(core.validate({...entry,collocations:['x'.repeat(201)]}),null);assert.equal(core.validate({...entry,examples:[{en:'Example'}]}),null);
});
test('dictionary save keeps context, collocations and examples without activating practice',()=>{
 const result=core.save({},'knock over',entry,'Pipi knocked my glass over.',{title:'Daily English',url:'https://example.com'},100);
 assert.equal(result.item.studyState,'inbox');assert.equal(result.item.input,'Pipi knocked my glass over.');assert.ok(result.item.note.includes('knock it over'));assert.ok(result.item.note.includes(entry.examples[0].en));assert.equal(result.item.dictionary.translation,entry.translation);
});
test('dictionary duplicate preserves notes, edits and learning progress',()=>{
 const first=core.save({},'knock over',entry,'context',{title:'Daily English'},100);first.item.note='my note';first.item.studyState='active';
 const next=core.save(first.map,'KNOCK OVER',entry,'changed',{title:'Other'},200);
 assert.equal(next.existed,true);assert.equal(next.item.note,'my note');assert.equal(next.item.studyState,'active');assert.equal(next.item.savedAt,100);assert.equal(Object.keys(next.map).length,1);
});
