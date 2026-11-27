import test from 'node:test';
import A from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {sha,stable} from '../adapter/qwenpaw-recovery.mjs';
import {open} from './fixtures/qwenpaw-mock-sql.mjs';
const binding={enabled:true,mode:'offline-fixture',provider:'qwenpaw',version:stable,scope:'public-text',dedicated:true,toolsDisabled:true,
 instance:'fixture-cn',agent:'trial-agent',user:'isolated-user',lane:'cn-text',channel:'console'};
const task='catalog-c01',args={binding,task},approvedText='Summarize the public catalog fields.';
const input={...args,approvedText,inputDigest:sha(approvedText)},now=100_000;
const isolated=t=>{
 const dir=mkdtempSync(join(tmpdir(),'rivule-qp-')),path=join(dir,'trial.sqlite'),handles=new Set();
 t.after(()=>{for(const h of handles)h.db.close();rmSync(dir,{recursive:true,force:true})});
 return {path,open(abort){const h=open(path,abort);handles.add(h);return h},close(h){handles.delete(h);h.db.close()}};
};
const recovery=(store)=>{
 const orig=store.reserve(input),first=orig.mockRequest.body.input[0].content[0].text,marker=first.split('\n')[0];
 const proof={source:'mock-owned-registry',instance:binding.instance,version:stable,agent:binding.agent,user:binding.user,
  channel:'console',session:orig.mockRequest.body.session_id,chat:'42f0dd4c-1a99-47ff-bf45-d2309c103fb5',observedAt:now};
 const request={instance:binding.instance,path:'/api/chats/'+proof.chat+'?include_app_owned=false',method:'GET',headers:{'X-Agent-Id':binding.agent}};
 const message=(role,text)=>({type:'message',role,status:'completed',content:[{type:'text',text}]});
 const observation={source:'mock-pinned-response',request,status:200,body:{status:'idle',messages:[message('user',first),message('assistant',marker+'\nPublic summary.')]}};
 return {orig,proof,base:{...args,proof,now},observation};
};
async function race(t,path,method,args){
 const file=fileURLToPath(new URL('./fixtures/qwenpaw-mock-sql.mjs',import.meta.url));
 const kids=[0,1].map(()=>fork(file,[path],{stdio:['ignore','ignore','ignore','ipc']}));
 t.after(()=>kids.forEach(p=>{if(p.exitCode===null)p.kill()}));
 const exits=kids.map(k=>once(k,'exit'));
 A.deepEqual((await Promise.all(kids.map(k=>once(k,'message')))).map(([event])=>event),[{ready:true},{ready:true}]);
 const rows=kids.map(k=>once(k,'message'));kids.forEach(k=>k.send({method,args}));
 const output=await Promise.all(rows);A.deepEqual(await Promise.all(exits),[[0,null],[0,null]]);
 return output.map(([x])=>x);
}
test('Default off and version, dedication, scope and tool gates reject before storing task',t=>{
 const {store}=isolated(t).open();
 for(const patch of [{enabled:false},{version:'main'},{version:'2.3.1-beta.1'},{scope:'private'},{dedicated:false},{toolsDisabled:false},{mode:'live'},{channel:'web'}])
  A.throws(()=>store.reserve({...input,binding:{...binding,...patch}}),/unapproved/);
 A.equal(store.view(args),null);
});
test('Two process send race returns only one original envelope; no replay after cold open',async t=>{
 const f=isolated(t),h=f.open();
 const results=await race(t,f.path,'reserve',input);
 A.equal(results.filter(r=>r.oneShot&&r.committed).length,1);
 A.equal(results.filter(r=>r.phase==='awaiting_binding').length,2);f.close(h);
 const {store}=f.open();A.equal(store.reserve(input).mockRequest,undefined);
 A.throws(()=>store.reserve({...input,approvedText:'replacement',inputDigest:sha('replacement')}),/locked/);
});
test('Bound attach after simulated loss has no input, sends no second prompt; other lane proceeds',async t=>{
 const f=isolated(t),{store}=f.open(),x=recovery(store);
 A.equal(store.bind({...x.base,expectedRevision:0}).phase,'bound');
 const results=await race(t,f.path,'reattach',{...x.base,expectedRevision:1});
 A.equal(results.filter(r=>r.oneShot).length,1);
 A.equal(store.reserve(input).mockRequest,undefined);
 const otherTask='another',l=recoveryForTask(store,otherTask);
 A.equal(l.mockRequest.method,'POST');A.notEqual(l.mockRequest.body.session_id,x.proof.session);
 function recoveryForTask(store,task){return store.reserve({...input,task})}
});
test('Original and attach bodies differ; pre-binding timeout and wrong scope emit no requests',t=>{
 const {store}=isolated(t).open(),x=recovery(store);
 A.equal(store.reattach({...x.base,expectedRevision:0}).mockRequest,undefined);
 A.equal(store.history({...x.base,expectedRevision:0}).mockRequest,undefined);
 for(const [k,v] of Object.entries({instance:'other',version:'2.3.1',agent:'other',user:'other',channel:'web',session:'another',chat:'bad',observedAt:now-30_001}))
  A.equal(store.bind({...x.base,proof:{...x.proof,[k]:v},expectedRevision:0}).committed,false,k);
 A(store.bind({...x.base,expectedRevision:0}).committed);
 const r=store.reattach({...x.base,expectedRevision:1});
 A.deepEqual(r.mockRequest.body,{user_id:binding.user,channel:'console',session_id:x.proof.session,reconnect:true});
 A.equal(r.mockRequest.headers['X-Agent-Id'],binding.agent);A.equal(r.mockRequest.path,'/api/console/chat');
 A.equal(store.reattach({...x.base,expectedRevision:2}).mockRequest,undefined);
 A.equal(store.history({...x.base,expectedRevision:2,proof:{...x.proof,chat:'42f0dd4c-1a99-47ff-bf45-d2309c103fb6'}}).mockRequest,undefined);
 A.deepEqual(store.history({...x.base,expectedRevision:2}).mockRequest,x.observation.request);
});
test('Empty attach/idle/partial/error/tool or wrong history never become a review artifact',t=>{
 const {store}=isolated(t).open(),x=recovery(store);
 store.bind({...x.base,expectedRevision:0});
 store.reattach({...x.base,expectedRevision:1});
 const {observation:o}=x;
 for(const bad of [
  null,{...o,body:{status:'idle',messages:[]}},{...o,body:{...o.body,status:'running'}},{...o,body:{...o.body,next_cursor:'extra'}},
  {...o,status:404},{...o,request:{...o.request,method:'POST'}},{...o,request:{...o.request,instance:'wrong'}},
  {...o,request:{...o.request,path:o.request.path.replace(x.proof.chat,'old')}},
  {...o,body:{...o.body,messages:[o.body.messages[0]]}},
  {...o,body:{...o.body,messages:[o.body.messages[0],{...o.body.messages[1],status:'in_progress'}]}},
  {...o,body:{...o.body,messages:[o.body.messages[0],{...o.body.messages[1],type:'reasoning'}]}},
  {...o,body:{...o.body,messages:[o.body.messages[0],{...o.body.messages[1],content:[{type:'text',text:'Rivule-Result old\nx'}]}]}},
  {...o,body:{...o.body,messages:[o.body.messages[0],{...o.body.messages[1],content:[...o.body.messages[1].content,{type:'tool_result'}]}]}},
  {...o,body:{...o.body,messages:[o.body.messages[0],o.body.messages[1],{role:'tool'}]}},
 ]){
  A.equal(store.reconcile({...x.base,expectedRevision:2,observation:bad}).committed,false);
  A.deepEqual(store.view(args),{revision:2,phase:'bound',artifact:null});
 }
});
test('Matching exact terminal history stages once across processes and restart; private input not stored',async t=>{
 const f=isolated(t),h=f.open(),x=recovery(h.store);
 h.store.bind({...x.base,expectedRevision:0});
 const results=await race(t,f.path,'reconcile',{...x.base,expectedRevision:1,observation:x.observation});
 A.equal(results.filter(r=>r.committed&&r.phase==='awaiting_main_agent').length,1);
 const raw=h.db.prepare('SELECT entry FROM lab_qwenpaw_v1').get().entry;
 A(!raw.includes(approvedText));A(!raw.includes('request_context'));
 f.close(h);const {store}=f.open();
 A.deepEqual(store.view(args),{revision:2,phase:'awaiting_main_agent',artifact:{kind:'text/plain',text:'Public summary.',digest:sha('Public summary.')}});
 A.equal(store.reconcile({...x.base,expectedRevision:2,observation:x.observation}).committed,false);
 A.equal(store.reattach({...x.base,expectedRevision:2}).mockRequest,undefined);
});
test('Injected precommit loss exposes no send; stale observations after a new revision cannot stage',t=>{
 const f=isolated(t);let fail=false;
 const {store}=f.open(()=>fail);fail=true;
 A.throws(()=>store.reserve(input),/precommit/);fail=false;
 A.equal(store.view(args),null);
 const x=recovery(store);store.bind({...x.base,expectedRevision:0});
 fail=true;A.throws(()=>store.reattach({...x.base,expectedRevision:1}),/precommit/);fail=false;
 A.equal(store.view(args).revision,1);A(store.reattach({...x.base,expectedRevision:1}).mockRequest);
 A.equal(store.reconcile({...x.base,expectedRevision:1,observation:x.observation}).reason,'stale');
});
