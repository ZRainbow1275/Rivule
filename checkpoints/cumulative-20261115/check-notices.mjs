// Exercise the cumulative notification formatter directly; no real account or network calls.
import assert from 'node:assert/strict';
import {resolve, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {test} from 'node:test';

if (!process.argv[2]) throw Error('Usage: node check-notices.mjs PATH_TO_RESTORED_SOURCE');
const src = resolve(process.argv[2]);
const {formatQQNotification} = await import(pathToFileURL(join(src,'src/owner/notification-policy.mjs')));
const source={display_name:'视觉测试',source_id:'fixture',provider:'dot'};
const now=1893456000000, ref='01234567-89ab-4def-8123-456789abcdef';
const event={kind:'progress',project_name:'纸上花园',task_name:'阅读卡片',branch_name:'测试路线',source_status:'running',summary:'今天完成一张卡片'};
const format=(payload, options={}, time=now) => formatQQNotification(payload,source,time,options);
const footer='回复指令：/rivule '+ref+' <指令>';
const opts={commandContextRef:ref};
test('short notice retains the summary, task and registered reply footer',()=>{
  const msg=format(event,opts);for(const s of [event.summary,event.task_name,footer]) assert.ok(msg.includes(s));
  assert.ok(!format(event).includes('回复指令：'));assert.doesNotMatch(msg,/…/);
});
for (const glyph of ['👩🏽‍💻','🇨🇳','e\u0301','1\uFE0F\u20E3','🙂','漢']) {
  test('oversized summary preserves full visible characters and one complete footer: '+glyph,()=>{
    const token={...event,summary:glyph.repeat(4200)};
    const result=format(token,opts);
    assert.ok(result.length<=4000);assert.ok(result.includes(footer));
    const part=result.split('\n\n')[1].split('\n')[0];
    assert.ok(part.endsWith('…'));assert.equal(part.slice(0,-1),glyph.repeat((part.length-1)/glyph.length));
    assert.equal(result.split(footer).length,2);
  });
}
test('exact fit and one extra unit',()=>{
  const overhead=format({...event,summary:''},opts).length;
  const fit='A'.repeat(4000-overhead);const uncut=format({...event,summary:fit},opts);
  assert.equal(uncut.length,4000);assert.ok(uncut.includes(fit));assert.ok(!uncut.includes('…'));
  const clipped=format({...event,summary:fit+'B'},opts);assert.equal(clipped.length,4000);assert.ok(clipped.includes('…'));assert.ok(clipped.includes(footer));
});
test('registered reply context still rejects an invalid reference',()=>{
  assert.throws(()=>format(event,{commandContextRef:'not-a-task-reference'}),/invalid/);
});
const due={...event,kind:'needs_input',source_status:'needs_input',action:{question:'选择哪张卡片？',expires_at:new Date(now).toISOString()}};
test('a pending request exposes its question until the exact boundary',()=>{
  const msg=format(due,{},now-1);assert.ok(msg.includes('待你处理'));assert.ok(msg.includes(due.action.question));
});
for(const t of [now,now+1,new Date(now)]) test('past-due request has no live question at '+String(t),()=>{
  const msg=format(due,{},t);assert.ok(msg.includes('请求期限已过'));assert.ok(!msg.includes(due.action.question));
});
test('unknown deadline prompts verification; undated action remains pending',()=>{
  assert.ok(format({...due,action:{...due.action,expires_at:'not-a-date'}}).includes('回复期限待核对'));
  assert.ok(format({...due,action:{question:due.action.question}}).includes('待你处理'));
});
test('terminal state remains terminal even when an earlier action had a date',()=>{
  const msg=format({...due,source_status:'completed'});assert.ok(msg.includes('已完成'));assert.ok(!msg.includes('请求期限已过'));
});

