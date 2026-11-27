import {createHash} from 'node:crypto';
const sha=x=>createHash('sha256').update(x).digest('hex');
const id=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(x);
const host=x=>x?.enabled===true&&x.mode==='offline-fixture'&&x.surface==='agentcore-harness'&&x.scope==='public-text'&&
 x.region==='cn-mainland'&&x.toolsDisabled===true&&[x.subject,x.harness,x.lane].every(id);
const wait=(reason)=>({committed:false,reason});
const runOpen=new Set(['sending','running','reattaching']);
const excludedErrors=new Set(['RUN_ALREADY_TERMINAL','RUN_ALREADY_ATTACHED','RUN_ATTACH_UNSUPPORTED','RUN_NOT_FOUND','SESSION_UNAVAILABLE']);
const ignore=/^(REASONING(?:_[A-Z]+)*|CUSTOM)$/;
const path='/ag-ui/agent';
const base=r=>({threadId:r.thread,runId:r.run,state:{},tools:[],context:[],forwardedProps:{}});
const same=(r,t)=>t?.threadId===r.thread&&t.runId===r.run;
export function makeAgentCoreAguiFixture({enabled=false,sql,transactionSync,resolve}={}){
 if(enabled!==true||typeof sql?.exec!=='function'||typeof transactionSync!=='function'||typeof resolve!=='function')throw TypeError('offline fixture disabled');
 transactionSync(()=>sql.exec('CREATE TABLE IF NOT EXISTS lab_agentcore_agui_v1 (id TEXT PRIMARY KEY, original TEXT UNIQUE NOT NULL, rev INTEGER NOT NULL, payload TEXT NOT NULL)'));
 function auth(a){
  const b=resolve(a.request);
  if(!host(b)||!id(a.job))return null;
  return {b,key:sha(JSON.stringify(['agentcore-offline',b.subject,b.harness,b.lane,a.job]))};
 }
 function row(c){
  const x=[...sql.exec('SELECT rev,payload FROM lab_agentcore_agui_v1 WHERE id=?',c.key)][0];
  return x?{rev:x.rev,r:JSON.parse(x.payload)}:null;
 }
 const view=x=>({revision:x.rev,state:x.r.state,afterSequence:x.r.cursor,...(x.r.resultDigest?{resultDigest:x.r.resultDigest}:{})});
 const put=(c,x,r)=>{sql.exec('UPDATE lab_agentcore_agui_v1 SET rev=?,payload=? WHERE id=? AND rev=?',x.rev+1,JSON.stringify(r),c.key,x.rev);return {committed:true,...view({rev:x.rev+1,r})};};
 const ticket=(c,r,g)=>sha(JSON.stringify([c.key,r.thread,r.run,g]));
 const scope=(c,r,epoch)=>r.epoch===epoch&&r.epoch===c.b.epoch;
 return Object.freeze({
  open(a){
   return transactionSync(()=>{
    const c=auth(a);
    if(!c||!id(c.b.epoch)||c.b.explicitMockDispatch!==true||![a.thread,a.run,a.message].every(id)||
       typeof a.text!=='string'||!a.text.trim()||Buffer.byteLength(a.text)>2048||c.b.approvedDigest!==sha(a.text))return wait('binding_or_input');
    const original=sha(JSON.stringify([c.b.harness,a.thread,a.run]));
    if(row(c)||[...sql.exec('SELECT 1 FROM lab_agentcore_agui_v1 WHERE original=?',original)].length)return wait('original_reserved');
    const r={thread:a.thread,run:a.run,epoch:c.b.epoch,cursor:-1,state:'sending',generation:1,attached:false,message:null,output:null,ended:false};
    sql.exec('INSERT INTO lab_agentcore_agui_v1 (id,original,rev,payload) VALUES (?,?,0,?)',c.key,original,JSON.stringify(r));
    return {committed:true,...view({rev:0,r}),ticket:ticket(c,r,1),mockRequest:{method:'POST',path,session:r.thread,
     body:{...base(r),messages:[{id:a.message,role:'user',content:a.text}]}}};
   });
  },
  read(a){return transactionSync(()=>{const c=auth(a),x=c&&row(c);return x&&scope(c,x.r,a.epoch)?view(x):null;});},
  attach(a){
   return transactionSync(()=>{
    const c=auth(a),x=c&&row(c),r=x?.r;
    if(!r||!scope(c,r,a.epoch)||x.rev!==a.revision||r.state!=='disconnected'||r.cursor<0||r.attached||
      c.b.attachSupported!==true)return wait('original_recovery_unverified');
    const next={...r,state:'reattaching',attached:true,generation:r.generation+1};
    const done=put(c,x,next);
    return {...done,ticket:ticket(c,next,next.generation),mockRequest:{method:'POST',path,session:r.thread,body:{
      ...base(r),messages:[],forwardedProps:{agentcore:{attach:{afterSequence:r.cursor}}}}}};
   });
  },
  observe(a){
   return transactionSync(()=>{
    const c=auth(a),x=c&&row(c),r=x?.r,o=a.observation;
    if(!r||!scope(c,r,a.epoch)||x.rev!==a.revision||!runOpen.has(r.state)||
      o?.source!=='fixture-wire'||o.session!==r.thread||o.ticket!==ticket(c,r,r.generation))return wait('receipt_not_original');
    const finish=(state,cursor=r.cursor,artifact=null)=>{
     const done=put(c,x,{...r,state,cursor,message:null,output:null,ended:false,resultDigest:artifact?.sha256??null});
     return artifact?{...done,candidate:artifact}:done;
    };
    if(o.kind==='closed')return put(c,x,{...r,state:r.attached?'needs_review':'disconnected'});
    if(o.kind==='reject')return excludedErrors.has(o.code)?finish('needs_review'):wait('unknown_reject');
    const e=o.event; 
    if(o.kind!=='event'||!Number.isSafeInteger(o.sequence)||o.sequence<0||!e||typeof e.type!=='string')return wait('invalid_event');
    if(o.sequence<=r.cursor)return wait('old_event');
    if(o.sequence!==r.cursor+1)return finish('needs_review');
    const seq=o.sequence,advance=(z)=>put(c,x,{...r,...z,cursor:seq});
    if(r.cursor===-1)return e.type==='RUN_STARTED'&&same(r,e)?advance({state:'running'}):finish('needs_review');
    if(e.type==='RUN_FINISHED'){
     if(!same(r,e))return finish('needs_review');
     if(e.outcome?.type==='interrupt')return finish('waiting_for_input',seq);
     if(e.outcome?.type==='success'&&r.ended&&r.output?.trim())
      return finish('result_for_review',seq,{sha256:sha(r.output),text:r.output});
     return finish('needs_review',seq);
    }
    if(e.type==='TEXT_MESSAGE_START'&&!r.message&&e.role==='assistant'&&id(e.messageId))return advance({message:e.messageId,output:''});
    if(e.type==='TEXT_MESSAGE_CONTENT'&&r.message&&e.messageId===r.message&&!r.ended&&typeof e.delta==='string'&&Buffer.byteLength(r.output+e.delta)<=8192)
     return advance({output:r.output+e.delta});
    if(e.type==='TEXT_MESSAGE_END'&&r.message&&e.messageId===r.message&&!r.ended)return advance({ended:true});
    if(ignore.test(e.type))return advance({});
    return finish(e.type==='RUN_ERROR'?'failed':'needs_review',seq);
   });
  }
 });
}
