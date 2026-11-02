import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
const c={};vm.createContext(c);for(const f of ['learning.js','queue-core.js','conversation-core.js'])vm.runInContext(fs.readFileSync(f,'utf8'),c);
const source=fs.readFileSync('tutor-server.mjs','utf8');vm.runInContext(source.slice(source.indexOf('function parseChatJson('),source.indexOf('// 解析情景出剧本返回')),c);vm.runInContext(source.slice(source.indexOf('function parseRehearseJson('),source.indexOf('function parseJudgeJson(')),c);
const expression='I have a lot on my plate.',text='She had a lot on her plate last week.',materials=[{key:'a',expression}];
const response=uses=>JSON.stringify({reply:'How did you help her?',feedback:{ok:true,better:'',tip:''},uses,done:false});
test('the model response parser preserves canonical expression IDs while storing varied learner wording',()=>{
 const result=c.parseRehearseJson(response([{expression,outcome:'used',evidence:text,support:'independent'}]),materials,text);
 assert.equal(result.used[0],expression);assert.equal(result.uses[0].evidence,text);assert.equal(result.uses[0].itemKey,'a');
});
test('meaning-only alternatives and unsupported quotes do not become target-completion marks',()=>{
 const alternative=c.parseRehearseJson(response([{expression,outcome:'alternative',evidence:'She was busy.',support:'independent'}]),materials,'She was busy.');assert.equal(alternative.used.length,0);assert.equal(alternative.uses[0].outcome,'alternative');
 const falseQuote=c.parseRehearseJson(response([{expression,outcome:'used',evidence:text,support:'independent'}]),materials,'I do not know.');assert.equal(falseQuote.used.length,0);assert.equal(falseQuote.uses.length,0);
 assert.equal(c.parseRehearseJson(JSON.stringify({reply:'Hi',used:[expression]}),materials,text),null);
});

test('an empty or unassessed dialogue is never described as flawless English',()=>{
 const chat=fs.readFileSync('chat.js','utf8'),view={weakLines:[],weakList:{},dialogueReviewState:{entries:[]}};
 vm.createContext(view);vm.runInContext(chat.slice(chat.indexOf('function renderWeak()'),chat.indexOf('async function saveWeak(')),view);
 view.renderWeak();assert.match(view.weakList.innerHTML,/还没有收到可评估/);assert.doesNotMatch(view.weakList.innerHTML,/很地道/);
 view.dialogueReviewState={entries:[{type:'response',feedback:{ok:false}}]};view.renderWeak();assert.match(view.weakList.innerHTML,/没有可展示的具体调整/);
});
