import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
const context={window:{}};
vm.runInNewContext(fs.readFileSync('learning.js','utf8'), context);
const learning=context.window.NuanceLearning;
test('direct capture preserves original wording, deduplicates lines and keeps cues',()=>{
 const rows=learning.parse("1. That works for me.｜同意时间\nThat works for me.\n- I'd rather not.｜委婉拒绝\n\n__proto__");
 assert.equal(rows.length,2);assert.equal(rows[0].cue,'同意时间');
 assert.equal(rows[1].expression,"I'd rather not.");
 const item=learning.create(rows[0],' GPT 对话 ',100);
 assert.equal(item.better,'That works for me.');assert.equal(item.studyState,'inbox');
 assert.equal(item.sourceLabel,'GPT 对话');assert.equal(item.savedAt,100);
});
test('import never overwrites existing learning progress or enriched metadata',()=>{
 const previous={better:'That works for me.',studyState:'active',createdAt:1,savedAt:30,note:'keep',stars:3};
 const map={'that works for me.':previous};
 const result=learning.addRows(map,learning.parse('That works for me.｜新提示\nI see.｜理解对方'),'new',100);
 assert.equal(result.added,1);assert.equal(result.map['that works for me.'],previous);
 assert.equal(Object.keys(map).length,1);assert.equal(result.map['i see.'].studyState,'inbox');
});
test('explicit states win over legacy stars; legacy data is interpreted without mutation',()=>{
 assert.equal(learning.stateOf({stars:4}),'active');assert.equal(learning.stateOf({starred:true}),'active');
 assert.equal(learning.stateOf({stars:0}),'inbox');
 assert.equal(learning.stateOf({stars:4,studyState:'archived'}),'archived');
 assert.equal(learning.stateOf({stars:4,studyState:'inbox'}),'inbox');
});
test('active limit prevents additions without evicting legacy active items',()=>{
 const map=Object.fromEntries(Array.from({length:20},(_,i)=>[i,{stars:1}]));
 assert.equal(learning.canActivate(map,{studyState:'inbox'}),false);
 assert.equal(learning.canActivate(map,map[0]),true);
 map[0]={studyState:'archived',stars:5};
 assert.equal(learning.canActivate(map,{studyState:'inbox'}),true);
});
function quizContext() {
 const source=fs.readFileSync('quiz.js','utf8');
 const c={mode:'replay',current:{key:'example'},drillMap:{'example::replay':{box:3,reps:4,lapses:0,custom:'keep'}},BOX_DAYS:[0,1,2,4,7,15],DAY:86400000,setDrillState:async()=>{},passed:0,misses:0,queue:[],updateProgress(){},nextQuestion(){}};
 vm.createContext(c);
 vm.runInContext(source.slice(source.indexOf('function drillIdOf'),source.indexOf('// 整组掌握度')),c);
 vm.runInContext(source.slice(source.indexOf('async function markPass'),source.indexOf('function stripExtra')),c);
 return c;
}
test('successful communication with another phrasing completes task and schedules target sooner',async()=>{
 const c=quizContext();await c.markAlternative();
 const progress=c.drillMap['example::replay'];
 assert.equal(c.passed,1);assert.equal(c.misses,0);assert.equal(c.queue.length,0);
 assert.equal(progress.communicationSuccess,true);assert.equal(progress.targetUsed,false);assert.equal(progress.box,1);
 assert.equal(progress.custom,'keep');assert.equal(progress.reps,5);
});
test('using target expression advances its retrieval schedule',async()=>{
 const c=quizContext();await c.markPass();
 assert.equal(c.drillMap['example::replay'].box,4);assert.equal(c.drillMap['example::replay'].targetUsed,true);
});
test('practice pool excludes inbox and archived, including starred archived items',()=>{
 const source=fs.readFileSync('quiz.js','utf8');
 const c={NuanceLearning:learning,mode:'replay',allItems:[{better:'active',studyState:'active',situations:['new']},{better:'inbox',studyState:'inbox'},{better:'archived',stars:5,studyState:'archived',situations:['new']},{better:'legacy',stars:2}]};
 vm.createContext(c);vm.runInContext(source.slice(source.indexOf('function currentPool()'),source.indexOf('// 模式选择页')),c);
 assert.equal(c.currentPool().map(x=>x.better).join(','),'active,legacy');
 c.mode='transfer';assert.equal(c.currentPool().map(x=>x.better).join(','),'active');
});
test('chat retrieves active due materials using map keys, not missing embedded keys',async()=>{
 const source=fs.readFileSync('chat.js','utf8');
 const corrections={a:{better:'Due',studyState:'active',situation:'使用情境'},b:{better:'Not due',studyState:'active'},c:{better:'Archived',studyState:'archived',stars:5},d:{better:'Inbox',studyState:'inbox'}};
 const drill={'a::replay':{due:1},'b::replay':{due:Date.now()+86400000}};
 const c={NuanceLearning:learning,CORR_KEY:'c',DRILL_KEY:'d',TALK_MATERIALS_MAX:5,getLocalMap:async key=>key==='c'?corrections:drill};
 vm.createContext(c);vm.runInContext(source.slice(source.indexOf('async function pickDueMaterials'),source.indexOf('function escapeHtml')),c);
 const items=await c.pickDueMaterials();assert.equal(items.length,1);assert.equal(items[0].expression,'Due');assert.equal(items[0].intent,'使用情境');
});
