import test from 'node:test';
import assert from 'node:assert/strict';
import {selectedWorkbench} from '../src/owner/presentation.mjs';
const item={state:'available',source_status:'running',task_name:'ＣｏＤｅｓｋ 设计 Café',project_name:'ＰｌｏｔＢｌｏｏｍ',branch_name:'第１期',blocker:'等待ＡＰＩ资料',archived:false};
for(const [label,query] of [['Latin fullwidth','codesk'],['decomposed accent','Cafe\u0301'],['project width','plotbloom'],['branch width','第1期']])test(label,()=>assert.deepEqual(selectedWorkbench([item],'all',query).visible,[item]));
test('normalization stays within status filter and leaves source data intact',()=>{const before=JSON.stringify(item);assert.deepEqual(selectedWorkbench([item],'completed','codesk').visible,[]);assert.equal(JSON.stringify(item),before);assert.deepEqual(selectedWorkbench([item],'all','unrelated').visible,[]);});
test('whitespace and case remain accepted',()=>assert.deepEqual(selectedWorkbench([item],'all','  CAFÉ  ').visible,[item]));
test('accent differences remain meaningful',()=>assert.deepEqual(selectedWorkbench([item],'all','Cafe').visible,[]));
