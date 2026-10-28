import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
function setup(){
 const events={},selection={setBaseAndExtent(...args){this.args=args;},removeAllRanges(){}};
 function span(text,x,y){const node={nodeType:3,textContent:text,length:text.length};return {firstChild:node,textContent:text,dataset:{},contains:n=>n===node,getBoundingClientRect:()=>({left:x,right:x+text.length*10,top:y,bottom:y+20,width:text.length*10,height:20})};}
 const spans=[span('150',0,0),span('it faces the television,',50,0),span('151',0,30),span('既不会妨碍跟他人谈话',50,30),span('151',0,60),span('thus discouraging conversation,',50,60)];
 const layer={querySelectorAll:()=>spans,addEventListener:(k,fn)=>{events[k]=fn;}};
 const context={window:{getSelection:()=>selection},document:{addEventListener:(k,fn)=>{events[k]=fn;},createRange(){let el,start=0,end=0,node;return {selectNodeContents(value){el=value;node=value.firstChild;end=value.textContent.length;},setStart(n,i){node=n;start=i;},setEnd(n,i){node=n;end=i;},toString(){return el.textContent.slice(start,end);},getBoundingClientRect(){const target=spans.find(x=>x.firstChild===node),r=target.getBoundingClientRect();return {left:r.left+start*10,right:r.left+end*10,top:r.top,bottom:r.bottom};}};}}};
 vm.createContext(context);vm.runInContext(fs.readFileSync('pdf-selection.js','utf8'),context);
 const tool=context.window.NuancePdfSelection.install(layer);tool.prepare();return {tool,spans,events,selection,core:context.window.NuancePdfSelection};
}
test('bilingual cross-line selection excludes intervening Chinese and gutter labels',()=>{
 const {tool,spans}=setup();const range={startContainer:spans[1].firstChild,startOffset:0,endContainer:spans[5].firstChild,endOffset:spans[5].textContent.length,intersectsNode:()=>true};
 assert.equal(tool.text(range),'it faces the television, thus discouraging conversation,');
 assert.ok(!tool.context(range).includes('151'));assert.ok(!tool.context(range).includes('妨碍'));
});
test('partial start and end offsets survive English filtering',()=>{
 const {tool,spans}=setup();const range={startContainer:spans[1].firstChild,startOffset:3,endContainer:spans[5].firstChild,endOffset:4,intersectsNode:()=>true};
 assert.equal(tool.text(range),'faces the television, thus');
});
test('all-text mode can retain the Chinese original when explicitly selected',()=>{
 const {tool,spans}=setup();tool.setMode('all');
 const text=tool.text({startContainer:spans[1].firstChild,startOffset:0,endContainer:spans[5].firstChild,endOffset:spans[5].textContent.length,intersectsNode:()=>true});assert.ok(text.includes('既不会妨碍跟他人谈话'));assert.ok(text.includes('151'));
});
test('dragging snaps endpoints to individual glyphs rather than selecting whole text runs',()=>{
 const {events,spans,selection}=setup();events.mousedown({button:0,detail:1,clientX:81,clientY:10,preventDefault(){}});
 assert.equal(selection.args[0],spans[1].firstChild);assert.equal(selection.args[1],3);
 events.mousemove({buttons:1,clientX:91,clientY:70});assert.equal(selection.args[2],spans[5].firstChild);assert.equal(selection.args[3],4);
});
test('visual row grouping sorts PDF runs even when internal text order differs',()=>{
 const {core}=setup();const rows=core.rowsOf([{x:50,y:60,h:20,id:3},{x:50,y:0,h:20,id:1},{x:0,y:0,h:20,id:0},{x:50,y:30,h:20,id:2}]);assert.deepEqual(JSON.parse(JSON.stringify(rows.map(row=>row.map(x=>x.id)))),[[0,1],[2],[3]]);
});
