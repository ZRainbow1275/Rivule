import test from 'node:test';
import A from 'node:assert/strict';
import {createBoardReadBridge} from '../yuanbao/read-board.mjs';
import {runCoordinationExample} from '../examples/coordination-board-demo.mjs';
const sample=runCoordinationExample(),rev=n=>sample.phases[n].asOfVersion;
const aliases=new Map([['A','overseas-a'],['B','overseas-b'],['MERGE','editorial']]);
const fixtures=()=>{
 let revision=rev(2),reads=0,resolves=0;
 const principal={board:'training',subject:'demo',active:true,rights:new Set(['pa:board:read']),aliases};
 const m=createBoardReadBridge({demoBoard:'training',
  resolve:async r=>{resolves++;return {...principal,audience:r.audience,...r.patch};},
  loadJournal:async r=>{A.equal(r.board,'training');reads++;return {...sample.journal,events:sample.journal.events.slice(0,revision)};}
 });
 const invoke=(name,args,audience='yuanbao',patch)=>m.invoke({audience,patch},name,args);
 const read=(alias,audience,patch)=>invoke('get_task_status',{alias},audience,patch);
 const list=(filter='all',audience,patch)=>invoke('list_board_status',{filter},audience,patch);
 return {m,invoke,read,list,getReads:()=>reads,getResolves:()=>resolves,advance:n=>revision=rev(n)}
};
// Scripted client dispatch fixture, not an emulation of Tencent identity, hosting, or NLU.
const prompts=async (f, turns)=>{
 let selected,result;
 for(const q of turns){
  const m=q.match(/(?:改查|查一下演练任务|换成)\s*([A-Z]+)/);
  if(m){selected=m[1];result=await f.read(selected);continue;}
  if(q==='看一下调度看板') result=await f.list();
  else if(q==='再刷新一下'&&selected) result=await f.read(selected);
  else if(q==='它谁来验收？'&&selected) result={card:(await f.read(selected)).card,role:'主 Agent'};
  else result=null;
 }
 return result;
};
test('T01 explicit board request reaches read path',async()=>{const f=fixtures();A.equal((await prompts(f,['看一下调度看板'])).cards.length,3);});
test('T02 unrelated request stays idle',async()=>{const f=fixtures();A.equal(await prompts(f,['今晚吃什么']),null);A.equal(f.getReads(),0);});
test('T03 explicit alias reads one card',async()=>{const f=fixtures();A.equal((await prompts(f,['查一下演练任务 A'])).card.alias,'A');});
test('T04 unrelated device request stays idle',async()=>{const f=fixtures();A.equal(await prompts(f,['先帮我把手机日历打开']),null);A.equal(f.getResolves(),0);});
test('F01 accepted filter excludes awaiting review',async()=>{const f=fixtures();A.deepEqual((await f.list('accepted')).cards.map(c=>c.alias),['B']);});
test('F02 delivery evidence from exact acknowledged attempt',async()=>{const f=fixtures();A.equal((await f.read('B')).card.delivery.evidence,'confirmed');A.equal((await f.read('A')).card.delivery.evidence,'uncertain');});
test('F03 submitted is not accepted, even when delivery is confirmed',async()=>{const f=fixtures();f.advance(3);let {card:c}=await f.read('A');A(c.submitted);A(!c.accepted);A.equal(c.delivery.evidence,'confirmed');});
test('F04 dependencies derived by canonical board owner',async()=>{const f=fixtures();const c=(await f.list('blocked')).cards[0];A.equal(c.alias,'MERGE');A.deepEqual(c.dependencies.map(x=>x.accepted),[false,true]);});
test('M01 scripted follow-up retains previous authorized alias',async()=>{const f=fixtures();const z=await prompts(f,['查一下演练任务 A','它谁来验收？']);A.equal(z.card.alias,'A');A.equal(z.role,'主 Agent');});
test('M02 explicit switch replaces alias',async()=>{A.equal((await prompts(fixtures(),['查一下演练任务 A','换成 B'])).card.alias,'B');});
test('M03 authoritative revision advances at refresh',async()=>{const f=fixtures();const prev=await f.read('A');f.advance(3);const n=await f.read('A');A(prev.asOfVersion<n.asOfVersion);A(n.card.submitted);});
test('E01 nonexistent alias is scoped empty',async()=>{A.deepEqual(await fixtures().read('Z'),{asOfVersion:rev(2),card:null});});
test('E02 no dispatch or fallback method on lost response',async()=>{const f=fixtures();await A.rejects(f.invoke('dispatch',{alias:'A'}),{code:'unknown_tool'});A.equal(f.getResolves(),0);A.equal(f.getReads(),0);});
test('E03 merge cannot jump ahead of marked review',async()=>{const f=fixtures();f.advance(3);A.equal((await f.read('MERGE')).card.state,'blocked');f.advance(4);A.equal((await f.read('MERGE')).card.state,'submitting');});
test('A01 no records outside board or assigned aliases',async()=>{const f=fixtures();await A.rejects(f.read('A','yuanbao',{board:'other'}),{code:'not_authorized'});A.equal(f.getReads(),0);A.equal((await f.read('B','yuanbao',{aliases:new Map([['A','overseas-a']])})).card,null);});
test('A02 scoped revocation precludes any read',async()=>{const f=fixtures();await A.rejects(f.read('A','yuanbao',{active:false}),{code:'not_authorized'});A.equal(f.getReads(),0);});
test('A03 forbidden credential/request fields not available',async()=>{const f=fixtures();const {card}=await f.read('A');A.deepEqual(Object.keys(card),['alias','state','label','delivery','submitted','accepted','updatedAt','revision','dependencies']);await A.rejects(f.invoke('get_task_status',{alias:'A',receipt:true}),{code:'invalid_input'});});
test('C01 selected output has status and stable event clock',async()=>{const {card}=await fixtures().read('A');A.equal(card.label,'待核对');A.equal(card.updatedAt,new Date(sample.journal.events[card.revision-1].at).toISOString());});
test('C02 same revision, identical output for Yuanbao, Muse and owner',async()=>{const f=fixtures();for(let n=0;n<6;n++){f.advance(n);const results=await Promise.all(['yuanbao','muse-personal','owner'].map(a=>f.list('all',a)));A.deepEqual(results[0],results[1]);A.deepEqual(results[1],results[2]);A.equal(results[0].asOfVersion,rev(n));}});
test('C03 empty authorization presents empty card collection',async()=>{const f=fixtures();A.deepEqual(await f.list('all','yuanbao',{aliases:new Map()}),{asOfVersion:rev(2),cards:[]});});
test('A04 revoke while waiting for storage returns zero public cards',async()=>{
 let active=true,loads=0;
 const m=createBoardReadBridge({demoBoard:'training',
  resolve:async()=>({board:'training',active,subject:'demo',audience:'yuanbao',aliases,rights:new Set(['pa:board:read'])}),
  loadJournal:async()=>{loads++;active=false;return sample.journal;}
 });
 await A.rejects(m.invoke({},'get_task_status',{alias:'A'}),{code:'not_authorized'});
 A.equal(loads,1);
});
test('A05 mixed board pings fail closed; resolver never trusts caller args',async()=>{
 const f=fixtures();
 await A.rejects(f.invoke('list_board_status',{filter:'all',board:'training'}),{code:'invalid_input'});
 A.equal(f.getResolves(),0);
});
