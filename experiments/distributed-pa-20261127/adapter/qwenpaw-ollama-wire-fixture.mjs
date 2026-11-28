// Isolated Rivule lab only. This fixture deliberately knows one fake model and
// one public prompt. Never point its port at a real model or provider.
import {createHash} from 'node:crypto';
import {request} from 'node:http';
const model='rivule-local-fixture';
const task='只根据下列公开事实写两句中文。2026年11月14日，TPS 首班 Cherry Express 从瓦尔帕莱索启航，载有388个集装箱、8500吨智利车厘子。2026年11月18日，ProChile 在深圳举办新一季车厘子启动活动。保留日期、地点和数量，不推断到港，不把活动说成该船到港。';
const no=(reason)=>({phase:'holding',reason});
const int=(v,lo,hi)=>Number.isSafeInteger(v)&&v>=lo&&v<=hi;
const obj=(x)=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const fields=(o,keys)=>obj(o)&&Object.keys(o).every(k=>keys.includes(k));
export const taggedRequestShape=Object.freeze({model,stream:true,stream_options:Object.freeze({include_usage:true}),
 max_completion_tokens:1000,messages:Object.freeze([Object.freeze({role:'user',content:task})])});
// Encoded body, not a count of characters, is bound to the reserved plan.
// Policy requires exactly one spelling; do not collapse a conflicting pair.
export function makeFixtureWire(client){
 if(!fields(client,['model','stream','stream_options','messages','max_completion_tokens','max_tokens'])||
  client.model!==model||client.stream!==true||!fields(client.stream_options,['include_usage'])||
  client.stream_options.include_usage!==true||!Array.isArray(client.messages)||client.messages.length!==1||
  !fields(client.messages[0],['role','content'])||client.messages[0].role!=='user'||client.messages[0].content!==task)return;
 const names=['max_completion_tokens','max_tokens'].filter(k=>Object.hasOwn(client,k));
 if(names.length!==1||!int(client[names[0]],1,1000))return;
 const cap=client[names[0]];
 const body=JSON.stringify({model,messages:[{role:'user',content:task}],stream:true,stream_options:{include_usage:true},max_tokens:cap});
 return {body,proof:{payloadDigest:createHash('sha256').update(body).digest('hex'),maxBillableOutput:cap}};
}
function collect(port,body,timeoutMs){
 return new Promise(resolve=>{
  const req=request({hostname:'127.0.0.1',port,path:'/v1/chat/completions',method:'POST',agent:false,
    signal:AbortSignal.timeout(timeoutMs),headers:{'content-type':'application/json','content-length':Buffer.byteLength(body)}},res=>{
   if(res.statusCode!==200||!/^text\/event-stream(?:;|$)/i.test(res.headers['content-type']??'')){
    resolve(null);res.destroy();return;
   }
   const chunks=[];let n=0;
   res.on('data',c=>{n+=c.length;if(n>65536){resolve(null);res.destroy();return;}chunks.push(c);});
   res.on('end',()=>{try{
    resolve(res.complete?new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)):null);
   }catch{resolve(null);}});
   res.on('error',()=>resolve(null));res.on('aborted',()=>resolve(null));
  });
  req.on('error',()=>resolve(null));req.end(body);
 });
}
export function stagedSse(body){
 if(typeof body!=='string'||Buffer.byteLength(body)>65536)return;
 const stack=body.replaceAll('\r\n','\n').split('\n\n');
 if(stack.pop()!==''||stack.length<4||stack.at(-1)!=='data: [DONE]')return;
 let streamId,text='',finish=false,usage;
 for(const event of stack.slice(0,-1)){
  if(!event.startsWith('data: ')||event.includes('\n'))return;
  let x;try{x=JSON.parse(event.slice(6));}catch{return;}
  if(!obj(x)||Object.hasOwn(x,'error')||x.object!=='chat.completion.chunk'||x.model!==model||
   typeof x.id!=='string'||!/^[-_.a-zA-Z0-9]{1,100}$/.test(x.id)||!Array.isArray(x.choices)||
   (streamId&&streamId!==x.id)||usage)return;
  streamId=x.id;
  if(x.choices.length===0){
   const u=x.usage;
   if(!finish||!obj(u)||!int(u.prompt_tokens,1,2**31-1)||!int(u.completion_tokens,0,2**31-1)||
    u.total_tokens!==u.prompt_tokens+u.completion_tokens)return;
   usage={input:u.prompt_tokens,output:u.completion_tokens};
   continue;
  }
  if(finish||x.choices.length!==1||x.usage!=null)return;
  const c=x.choices[0],d=c?.delta;
  if(c?.index!==0||!fields(d,['role','content','reasoning','reasoning_content'])||
   (d.role!==undefined&&d.role!=='assistant')||
   ['content','reasoning','reasoning_content'].some(k=>Object.hasOwn(d,k)&&typeof d[k]!=='string'))return;
  if(c.finish_reason==='stop'){if(Object.keys(d).length!==0)return;finish=true;continue;}
  if(c.finish_reason!==null)return;
  text+=d.content??'';
 }
 if(finish&&usage&&text.trim())return {usage,text};
}
export function makeQwenPawOllamaWireFixture({enabled=false,port,budget,saveUsageForFixture,timeoutMs=2000}={}){
 if(enabled!==true||!int(port,1024,65535)||!int(timeoutMs,50,5000)||typeof budget?.reserve!=='function'||
   typeof budget?.observe!=='function'||typeof saveUsageForFixture!=='function')throw TypeError('Ollama wire drill disabled');
 return Object.freeze({async dispatch(binding,client){
  const wire=makeFixtureWire(client);if(!wire)return no('unapproved_wire_request');
  const r=budget.reserve(binding,wire.proof);if(r.phase!=='fixture_model_call_reserved')return r;
  // SQLite has consumed the original slot before the sole POST. No automatic
  // SDK retries, redirect handling, streaming partials, refunds, or fallback.
  const k=stagedSse(await collect(port,wire.body,timeoutMs));
  if(!k)return no('wire_outcome_unknown');
  try{saveUsageForFixture(r.call,{source:'fixture-usage',model,reasoningIncluded:true,terminal:'complete',...k.usage});}
  catch{return no('wire_usage_staging_failed');}
  const result=budget.observe(binding,r.call);
  return result.phase==='usage_for_main_agent_review'?{...result,candidate:k.text}:result;
 }});
}
