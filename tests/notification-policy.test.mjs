import {sourceBrand, knownBrandImage} from '../src/owner/brand-identity.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {isRoutineProgress, sameNotificationBranch, routineDueAt, formatQQNotification} from '../src/owner/notification-policy.mjs';
const event = {kind:'progress',source_status:'running', source_id:'a',project_id:'p',task_id:'t',run_id:'r',branch_id:'b',project_name:'演示项目',task_name:'检查',summary:'合成样例',progress:{done:3,total:8,unit:'项'}};
test('only ordinary progress waits; critical and correction updates stay immediate',()=>{
 assert.equal(routineDueAt(event,100),60100);
 for(const patch of [{kind:'completed',source_status:'completed'},{kind:'failed',source_status:'failed'},{kind:'needs_input',action:{question:'确认？'}},{blocker:'等待处理'},{kind:'correction'},{kind:'heartbeat'},{kind:'started'}]){
  assert.equal(isRoutineProgress({...event,...patch}),false);
  assert.equal(routineDueAt({...event,...patch},100),100);
 }
});
test('coalescing identity includes source, project, task, run and branch',()=>{
 assert.equal(sameNotificationBranch(event,{...event}),true);
 for(const key of ['source_id','project_id','task_id','run_id','branch_id']) assert.equal(sameNotificationBranch(event,{...event,[key]:'other'}),false);
 assert.equal(sameNotificationBranch({},{}),false);
});
test('QQ format gives compact labeled facts without invented progress or blanket disclaimers',()=>{
 const text=formatQQNotification(event,{display_name:'演示 PA'},100);
 assert.match(text,/⏳ 进行中/);assert.match(text,/3 \/ 8 项/);assert.match(text,/演示 PA → 🐧 QQ/);
 assert.doesNotMatch(text,/%|不代表|真实送达/);
 const unknown=formatQQNotification({...event,progress:{done:3,total:null,unit:'项'}},{display_name:'PA'},100);
 assert.doesNotMatch(unknown,/\/|%/);
 const action=formatQQNotification({...event,source_status:'needs_input',action:{question:'选择哪一个？'}},{display_name:'PA'},100);
 assert.match(action,/待你处理/);assert.match(action,/到原助手查看并回复/);
});

import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {DatabaseSync} from 'node:sqlite';
import {QQBridgeQueue} from '../src/owner/qq-integration.mjs';
test('real QQ admission coalesces queued progress, retains first window and preserves urgent updates',()=>{
 const db=new DatabaseSync(':memory:');
 db.exec(`CREATE TABLE events(receipt TEXT PRIMARY KEY,revision INTEGER,source_id TEXT,payload TEXT,decision TEXT);CREATE TABLE qq_continuous_outbox(receipt TEXT PRIMARY KEY,source_id TEXT,source_generation INTEGER,revision INTEGER,payload TEXT,status TEXT,recorded_at INTEGER,result TEXT);`);
 let now=1000;const rows=(q,...args)=>db.prepare(q).all(...args);
 const queue=Object.create(QQBridgeQueue.prototype);
 Object.assign(queue,{rows,now:()=>now,sources:[{source_id:'a',enabled:true}],config:()=>({enabled:true,allowedProjects:['p']}),activation:()=>({active:true,expiresAt:1e9,startAfterRevision:0}),readAuthority:()=>({selectable:true,connection_generation:1}),retentionFloor:()=>0,capacityFloor:()=>0,recordAdmissionSkip:()=>{throw Error('unexpected skip')}});
 const add=(id,patch={})=>{const e={...event,event_id:id,sensitivity:'normal',occurred_at:new Date(0).toISOString(),...patch};rows("INSERT INTO events VALUES(?,?,?,?,?)",id,Number(id.slice(1)),'a',JSON.stringify(e),'applied');assert.equal(queue.enqueue(e,id),true);return e;};
 const e1=add('e1');now=2000;add('e2');queue.enqueue(e1,'e1');
 assert.equal(rows("SELECT status FROM qq_continuous_outbox WHERE receipt='e2'")[0].status,'queued');
 assert.equal(rows("SELECT status FROM qq_continuous_outbox WHERE receipt='e1'")[0].status,'coalesced');
 assert.equal(rows("SELECT recorded_at FROM qq_continuous_outbox WHERE receipt='e2'")[0].recorded_at,1000);
 assert.equal(queue.nextAlarmAt(),61000);
 add('e3',{kind:'failed',source_status:'failed'});
 assert.equal(rows("SELECT status FROM qq_continuous_outbox WHERE receipt='e2'")[0].status,'coalesced');
 assert.equal(rows("SELECT status FROM qq_continuous_outbox WHERE receipt='e3'")[0].status,'queued');
 const e4=add('e4',{branch_id:'other'});queue.enqueue(e4,'e4');
 assert.equal(rows("SELECT status FROM qq_continuous_outbox WHERE receipt='e4'")[0].status,'queued');
 assert.equal(rows("SELECT status FROM qq_continuous_outbox WHERE receipt='e3'")[0].status,'queued');
 db.close();
});
test('shipped Discord overview coalesces within fixed window and bypasses it for urgent work',()=>{
 const source=readFileSync(new URL('../src/owner/worker.js',import.meta.url),'utf8');const a=source.lastIndexOf('            enqueue(receipt, view, intent, payload, revision) {');const b=source.indexOf('            async ingest',a);
 const box=vm.createContext({isRoutineProgress,PROGRESS_WINDOW_MS:60000,canonical:JSON.stringify,Rejected:Error});vm.runInContext('this.Queue=class {'+source.slice(a,b)+'}',box);
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE outbox(receipt TEXT PRIMARY KEY,view_key TEXT,intent TEXT,payload TEXT,revision INTEGER,status TEXT,next_at INTEGER)');
 const q=new box.Queue();let now=1000;q.projectAllowed=()=>true;q.clock=()=>now;q.rows=(sql,...args)=>db.prepare(sql).all(...args);q.one=(sql,...args)=>q.rows(sql,...args)[0];
 q.enqueue('a','overview','overview',event,1);now=2000;q.enqueue('b','overview','overview',event,2);
 assert.equal(q.one("SELECT next_at FROM outbox WHERE receipt='b'").next_at,61000);
 q.enqueue('c','overview','overview',{...event,blocker:'action needed'},3);
 assert.equal(q.one("SELECT next_at FROM outbox WHERE receipt='c'").next_at,2000);
 db.close();
});

test('shipped notification SVG uses colors and bars only for valid known totals; worst page fits',()=>{
 const source=readFileSync(new URL('../src/owner/worker.js',import.meta.url),'utf8');const a=source.indexOf('var __rivuleDisplay =');const b=source.indexOf('createMessagePreparer = __rivuleDisplay',a);
 const box=vm.createContext({initWasm:()=>{},Resvg2:class{},safeUrl:()=>null,sourceBrand,knownBrandImage});vm.runInContext(source.slice(a,b),box);
 const sources=[0,1,2].map(i=>({source_id:'s'+i,display_name:'合成来源'+i,enabled:true,selectable:true,connection_status:'verified',verification_status:'verified'}));
 const branches=sources.map((s,i)=>({...event,source_id:s.source_id,project_id:'p'+i,task_name:'长标题'.repeat(30),summary:'这是合成测试内容'.repeat(80),warning:'待核对',stale:true,occurred_at:new Date(0).toISOString(),progress:{done:3,total:8,unit:'测试项'},blocker:'阻塞描述'.repeat(50)}));
 const graph=box.__rivuleDisplay.renderOverview({sources,branches,test_only:true,rendered_at:new Date(0).toISOString()});
 assert.ok(graph.height<=1100);assert.match(graph.svg,/width="108.75" height="7"/);assert.match(graph.svg,/fill="#A52E45" stroke="#A52E45"/);assert.match(graph.svg,/进展一览/);assert.match(graph.svg,/需关注/);assert.match(graph.svg,/font-size="34"/);assert.match(graph.svg,/font-size="24"/);
 const unknown=box.__rivuleDisplay.renderOverview({sources,branches:[{...branches[0],progress:{done:3,total:null,unit:'项'}}],test_only:true});
 assert.doesNotMatch(unknown.svg,/height="7"/);
});
test('continuous settings grid reports actual quota without blanket defensive text',()=>{
 const source=readFileSync(new URL('../src/gateway/worker.mjs',import.meta.url),'utf8');const a=source.indexOf('    const used = view.quotaKnown');const b=source.indexOf('    const reviewSpecs',a);
 const render=new Function('view','status','daily','review','eligibility','active','heading','reason','canOfferEnable','stage','setupMinutes',source.slice(a,b)+';return {text,embed,metrics};');
 const panel=render({quotaKnown:true},{remainingDaily:67,bound:true},{usedMs:1000,limitMs:7200000,mode:'warn'},{count:0},{},true,'本轮通知已开启',null,false,'✓ 本轮通知',n=>n+' ms');
 assert.equal(panel.text,'**Rivule · 持续通知**');assert.equal(panel.embed.color,0x16866B);
 assert.match(panel.metrics.description,/33 \/ 100/);assert.equal(panel.metrics.title,'67 次可用');
 assert.equal([...panel.embed.fields,...panel.metrics.fields].filter(f=>f.inline).length,4);
 assert.doesNotMatch(JSON.stringify(panel),/不代表|真实送达/);
 assert.ok(JSON.stringify(panel).length<3000);
});


test('quota card never implies availability while paused, exhausted, unknown or awaiting approval',()=>{
 const source=readFileSync(new URL('../src/gateway/worker.mjs',import.meta.url),'utf8');const a=source.indexOf('    const used = view.quotaKnown');const b=source.indexOf('    const reviewSpecs',a);
 const render=new Function('view','status','daily','review','eligibility','active','heading','reason','canOfferEnable','stage','setupMinutes',source.slice(a,b)+';return {embed,metrics};');
 const panel=(remaining=67,patch={})=>render({quotaKnown:patch.known??true},{remainingDaily:remaining,bound:true},patch.daily??{usedMs:0,limitMs:7200000,mode:'warn'},{count:patch.review??0},patch.eligibility??{},patch.active??true,'状态',null,patch.enable??false,'状态',n=>n+' ms');
 assert.equal(panel(0).metrics.title,'今日额度已用完');
 assert.doesNotMatch(panel(67,{active:false}).metrics.title,/可用/);
 assert.doesNotMatch(panel(67,{eligibility:{reason:'budget_exhausted'}}).metrics.title,/可用/);
 assert.doesNotMatch(panel(67,{daily:{usedMs:0,limitMs:0,mode:'stop'}}).metrics.title,/可用/);
 assert.doesNotMatch(panel(67,{review:1}).metrics.title,/可用/);
 for(const value of [null,-1,101,NaN,Infinity,1.5]) assert.equal(panel(value).metrics.title,'额度待核对');
 assert.equal(panel(67,{known:false}).metrics.title,'额度待核对');
 assert.match(panel(100).metrics.description,/□□□□□□□□□□  0 \/ 100/);
 assert.match(panel(0).metrics.description,/■■■■■■■■■■  100 \/ 100/);
 const enable=panel(67,{active:false,enable:true});
 assert.match(enable.embed.description,/通道验证消息/);assert.match(enable.embed.description,/已授权项目.*已验证 PA.*普通内容/);
});

test('owner queue reconciliation removes quota availability when producer is paused or unknown',()=>{
 const source=readFileSync(new URL('../src/owner/qq-integration.mjs',import.meta.url),'utf8');const a=source.indexOf('function qqProducerPanel(');const b=source.indexOf('const qqAdmissionCodes',a);
 const box=vm.createContext({qqStoredDiagnostic:()=>null});vm.runInContext(source.slice(a,b),box);
 for(const active of [false,null,undefined]){
  const response={data:{content:'Rivule · 持续通知',embeds:[{title:'本轮通知已开启',fields:[{name:'本轮状态',value:'已开启'}]},{title:'67 次可用',fields:[{name:'▶ 通知节奏',value:'合并进展'}]}]}};
  box.qqProducerPanel(response,{delivery:{active}});
  assert.equal(response.data.embeds[1].title,'剩余 67 次额度');assert.doesNotMatch(response.data.embeds[0].fields[0].value,/已开启/);
 }
});


test('plain QQ identity keeps brand and status separate without rich-media syntax',()=>{
 const text=formatQQNotification({...event,source_status:'completed',kind:'completed'},{source_id:'zot-main',provider:'dot',display_name:'Zot'},100);
 assert.match(text,/zot → 🐧 QQ/);assert.match(text,/✅ 已完成/);
 assert.doesNotMatch(text,/<img|data:image|https?:|\*\*|!\[/);
 const unknown=formatQQNotification(event,{source_id:'unknown-source',provider:'custom',display_name:'团队助理'},100);
 assert.match(unknown,/团队助理/);assert.doesNotMatch(unknown,/GrokBot|Muse|Dovue/);
});

test('notification SVG accepts only pinned official image bytes and rejects external or altered assets',async()=>{
 const source=readFileSync(new URL('../src/owner/worker.js',import.meta.url),'utf8');const a=source.indexOf('var __rivuleDisplay =');const b=source.indexOf('createMessagePreparer = __rivuleDisplay',a);
 class Renderer { imagesToResolve(){return [];} render(){return {asPng:()=>new Uint8Array([137,80,78,71]),free(){}};} free(){} }
 const box=vm.createContext({Uint8Array,initWasm:()=>{},Resvg2:Renderer,safeUrl:()=>null,sourceBrand,knownBrandImage});vm.runInContext(source.slice(a,b),box);
 const render=box.__rivuleDisplay.createPngRenderer({fontBuffers:[new Uint8Array([1])],wasmModule:{}});
 const data=sourceBrand({provider:'muse',display_name:'Muse'}).iconData;
 assert.ok(data);assert.ok(knownBrandImage(data));
 const graph={width:390,height:100,svg:`<svg><image x="16" y="20" width="24" height="24" href="${data}"/></svg>`};
 assert.equal((await render(graph)).length,4);
 for(const href of ['https://example.invalid/icon.svg',data+'changed','data:image/svg+xml;base64,PHN2Zy8+']) await assert.rejects(render({...graph,svg:graph.svg.replace(data,href)}),/unsafe_svg/);
});

test('QQ transport stays within 4000 UTF-16 units without trimming identity, action or source URL',()=>{
 for(const glyph of ['a','😀']) {
  const fill=n=>glyph.repeat(n/glyph.length);
  const event={source_status:'needs_input',project_name:fill(120),task_name:fill(120),branch_name:fill(80),summary:fill(1200),blocker:fill(400),action:{question:fill(400)},progress:{done:3,total:8,unit:fill(40)},source_url:'https://example.com/'+ 'a'.repeat(2020)};
  const source={source_id:'zot-main',provider:'dot',display_name:'Assistant'};
  for(const includeSourceUrl of [false,true]) {
   const text=formatQQNotification(event,source,0,{includeSourceUrl});
   assert.ok(text.length<=4000);assert.ok(text.includes('● zot → 🐧 QQ'));assert.ok(text.includes('待办  '+event.action.question));assert.ok(text.includes('受阻  '+event.blocker));
   if(includeSourceUrl) assert.ok(text.endsWith(event.source_url));
   assert.equal(text.isWellFormed(),true);
  }
 }
});

test('failed QQ replacement admission preserves prior queued progress across committed outer transaction',()=>{
 const db=new DatabaseSync(':memory:');
 db.exec(`CREATE TABLE events(receipt TEXT PRIMARY KEY,revision INTEGER,source_id TEXT,payload TEXT,decision TEXT);CREATE TABLE qq_continuous_outbox(receipt TEXT PRIMARY KEY,source_id TEXT,source_generation INTEGER,revision INTEGER,payload TEXT,status TEXT,recorded_at INTEGER,result TEXT);CREATE TRIGGER reject_replacement BEFORE INSERT ON qq_continuous_outbox WHEN NEW.receipt='e2' BEGIN SELECT RAISE(ABORT,'fixture insert failure'); END;`);
 const rows=(sql,...args)=>db.prepare(sql).all(...args), skips=[];
 const queue=Object.create(QQBridgeQueue.prototype);
 Object.assign(queue,{rows,now:()=>1000,sources:[{source_id:'a',enabled:true}],config:()=>({enabled:true,allowedProjects:['p']}),activation:()=>({active:true,expiresAt:1e9,startAfterRevision:0}),readAuthority:()=>({selectable:true,connection_generation:1}),retentionFloor:()=>0,capacityFloor:()=>0,recordAdmissionSkip:(_,id,reason)=>skips.push({id,reason})});
 const events=[1,2].map(i=>({...event,event_id:'e'+i,sensitivity:'normal',occurred_at:new Date(0).toISOString()}));
 for(const [i,e] of events.entries()) rows('INSERT INTO events VALUES(?,?,?,?,?)',e.event_id,i+1,'a',JSON.stringify(e),'applied');
 assert.equal(queue.enqueue(events[0],'e1'),true);
 db.exec('BEGIN'); assert.equal(queue.enqueue(events[1],'e2'),false); db.exec('COMMIT');
 assert.equal(rows("SELECT status FROM qq_continuous_outbox WHERE receipt='e1'")[0].status,'queued');
 assert.equal(rows("SELECT receipt FROM qq_continuous_outbox WHERE receipt='e2'").length,0);
 assert.deepEqual(skips,[{id:'e2',reason:'admission_unavailable'}]);
 db.exec('DROP TRIGGER reject_replacement');assert.equal(queue.enqueue(events[1],'e2'),true);
 assert.equal(rows("SELECT status FROM qq_continuous_outbox WHERE receipt='e1'")[0].status,'coalesced');
 assert.equal(rows("SELECT status FROM qq_continuous_outbox WHERE receipt='e2'")[0].status,'queued');
 assert.equal(queue.enqueue(events[0],'e1'),true);assert.equal(queue.enqueue(events[1],'e2'),true);
 assert.equal(rows("SELECT COUNT(*) n FROM qq_continuous_outbox WHERE status='queued'")[0].n,1);
 assert.equal(rows("SELECT status FROM qq_continuous_outbox WHERE receipt='e2'")[0].status,'queued');
 db.close();
});
