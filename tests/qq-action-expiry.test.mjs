import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { formatQQNotification } from '../src/owner/notification-policy.mjs';
import { QQBridgeQueue } from '../src/owner/qq-integration.mjs';

const cutoff = Date.parse('2026-11-17T10:00:00.125Z');
const expiry = '2026-11-17T18:00:00.125+08:00';
const source = {source_id:'artist',display_name:'校对助手',enabled:true,allowed_hosts:[]};
const base = {
  event_id:'review-draft',source_id:'artist',project_id:'booklet',task_id:'cover',run_id:'r1',branch_id:'main',
  project_name:'秋季书目',task_name:'封面校对',kind:'needs_input',source_status:'needs_input',
  occurred_at:'2026-11-17T09:55:00Z',sensitivity:'normal',summary:'封面有两个排版版本。'
};
function sample(expiresAt=expiry, extra={}) {
  return {...base,action:{request_id:'pick',question:'选 A 版还是 B 版？',expires_at:expiresAt},...extra};
}
function report(e,at=cutoff) { return formatQQNotification(e,source,at); }
function headline(text) { return text.split('\n')[1]; }
function isExpired(text) {
  assert.match(headline(text),/请求期限已过/); assert.match(headline(text),/原平台待核对/);
  assert.doesNotMatch(text,/⚠️ 等待输入|待你处理|待办  |到原助手查看并回复|选 A 版还是 B 版/);
  assert.doesNotMatch(text,/已完成|已取消|失败|已送达/);
}
for(const [label,delta,expired] of [['one millisecond before',-1,false],['exactly at',0,true],['one millisecond after',1,true]]) {
  test(label+' the source-specified deadline',()=>{
    const text=report(sample(),cutoff+delta);
    if(expired)isExpired(text);
    else {assert.match(headline(text),/待你处理/);assert.match(text,/待办  选 A 版还是 B 版？/);assert.doesNotMatch(text,/期限已过/);}
  });
}
test('a reported temporary blocker never implies the question expired',()=>{
  const text=report(sample(expiry,{blocker:'校对员暂不可达'}),cutoff-1);
  assert.match(headline(text),/受阻/);assert.match(text,/受阻  校对员暂不可达/);
  assert.match(text,/待办  选 A 版还是 B 版？/);assert.doesNotMatch(text,/期限已过/);
});
test('a blocker does not conceal the actual expiry of the previous request',()=>{
  const text=report(sample(expiry,{blocker:'校对员暂不可达'}),cutoff);
  isExpired(text);assert.match(text,/受阻  校对员暂不可达/);
});
test('an open-ended question stays open; a task with no question is not labelled expired',()=>{
  for(const action of [{request_id:'p',question:'继续？'},{request_id:'p',question:'继续？',expires_at:null}]) {
    const text=report({...base,action},cutoff+86400000);
    assert.match(text,/待你处理/);assert.match(text,/待办  继续？/);assert.doesNotMatch(text,/期限已过/);
  }
  for(const [kind,state] of [['progress','running'],['completed','completed'],['cancelled','cancelled']]){
    const text=report({...base,kind,source_status:state,action:null});assert.doesNotMatch(text,/待你处理|待办  |期限已过|期限待核对/);
  }
});
test('an unreadable timestamp or clock is not proof of expiration and does not invite a reply',()=>{
  for(const [e,now] of [[sample('unavailable'),cutoff],[sample(),NaN]]) {
    const text=report(e,now);assert.match(headline(text),/期限待核对/);
    assert.doesNotMatch(text,/期限已过|待你处理|待办  |到原助手查看并回复|选 A 版还是 B 版/);
  }
});
async function fixture(t) {
  let clock=cutoff-1,readable=true;
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  const storage={sql:{exec(sql,...args){
    if(sql.split(';').filter(x=>x.trim()).length>1){db.exec(sql);return {toArray:()=>[]};}
    return {toArray:()=>db.prepare(sql).all(...args)};
  }},transaction:async fn=>fn(),transactionSync:fn=>fn(),sync:async()=>{}};
  db.exec('CREATE TABLE events(revision INTEGER,receipt TEXT,source_id TEXT,payload TEXT,decision TEXT)');
  const env={QQ_ENABLED:'true',QQ_OWNER_ID:'owner',QQ_APP_ID:'123',QQ_DELIVERY_ENABLED:'true',QQ_ALLOWED_SOURCE_IDS:'["artist"]',QQ_ALLOWED_PROJECT_IDS:'["booklet"]'};
  let outbound=0;
  const queue=new QQBridgeQueue(storage,env,'owner',[source],()=>{outbound++;throw Error('offline fixture');},()=>clock);
  queue.attachAuthority(()=>({selectable:readable,binding:'local-booklet',connection_generation:1,last_verified_at:clock}));
  const ref='12345678-1234-4234-8234-123456789abc';
  queue.attachMessageBridge({taskAuthority:()=>({context_ref:ref,consent_revision:4})});
  await queue.initializeContinuous();queue.saveActivation({active:true,grantId:'local-grant',bindingFingerprint:'local',startAfterRevision:1,expiresAt:cutoff+3600000});
  const raw=sample(),receipt='rcpt_'+'a'.repeat(32);
  db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run(2,receipt,source.source_id,JSON.stringify(raw),'applied');
  assert.equal(queue.enqueue(raw,receipt),true);
  const row=queue.rows('SELECT * FROM qq_continuous_outbox WHERE receipt=?',receipt)[0];
  return {read:()=>queue.currentJob(row,queue.activation()),at:n=>{clock=n;},visible:v=>{readable=v;},calls:()=>outbound,
    saved:()=>db.prepare('SELECT payload FROM events WHERE receipt=?').get(receipt).payload,
    rows:()=>db.prepare('SELECT count(*) AS n FROM qq_continuous_outbox').get().n};
}
test('reading the same admitted event on either side of the deadline changes only its rendered notice and digest',async t=>{
  const f=await fixture(t),original=f.saved();
  const first=await f.read();assert.match(headline(first.job.content),/待你处理/);assert.ok(first.job.content.includes('选 A 版还是 B 版？'));
  f.at(cutoff);
  const second=await f.read();
  t.diagnostic('QQ headline at the cutoff: '+headline(second.job.content));
  isExpired(second.job.content);
  assert.equal(second.job.contentKind,'task_update');assert.equal(second.job.contextRef,first.job.contextRef);
  assert.equal(second.job.consentRevision,first.job.consentRevision);assert.ok(second.job.content.includes('/rivule '+first.job.contextRef+' <指令>'));
  assert.equal(second.job.payloadHash,createHash('sha256').update(second.job.content).digest('hex'));
  assert.notEqual(first.job.payloadHash,second.job.payloadHash);
  assert.equal((await f.read()).job.payloadHash,second.job.payloadHash);
  assert.equal(f.rows(),1);assert.equal(f.saved(),original,'read-only formatting does not rewrite the upstream event');assert.equal(f.calls(),0);
});
test('a temporarily unreadable binding keeps its existing failure and is never converted to a deadline result',async t=>{
  const f=await fixture(t);f.visible(false);await assert.rejects(f.read(),/source_or_event_changed/);
  f.visible(true);const {job}=await f.read();assert.match(headline(job.content),/待你处理/);assert.doesNotMatch(job.content,/期限已过/);
  assert.equal(f.rows(),1);assert.equal(f.calls(),0);
});
