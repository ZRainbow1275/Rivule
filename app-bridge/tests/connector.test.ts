import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';import {createContext,runInContext} from 'node:vm';
import {URL} from 'node:url';
// Browser policy is shared with the actual extension background, not a replacement transport.
// @ts-ignore plain browser module
import {validOrigin,conversationUrl,sameBinding,modeAllowed,safeSendLabel} from '../connector/policy.js';
test('browser connector only accepts approved control plane and exact task URLs',()=>{
  assert.equal(validOrigin('https://evil.example'),false);assert.equal(validOrigin('https://rivule-bridge.hybridrevis.workers.dev'),true);
  assert.equal(conversationUrl('https://chatgpt.com/c/123','chatgpt'),true);assert.equal(conversationUrl('https://chatgpt.com/','chatgpt'),false);
  assert.equal(conversationUrl('https://chatgpt.com/c/123?token=secret','chatgpt'),false);assert.equal(conversationUrl('https://gemini.google.com/app/abc','gemini'),true);
  assert.equal(sameBinding({url:'https://chatgpt.com/c/123',platform:'chatgpt',armed:true},{url:'https://chatgpt.com/c/456'}),false);
});
test('model guard and send guard never accept ordinary Gemini or approval controls',()=>{
  assert.equal(modeAllowed('chatgpt','GPT Pro'),true);assert.equal(modeAllowed('chatgpt','Fast'),false);assert.equal(modeAllowed('gemini','Gemini Pro'),false);assert.equal(modeAllowed('gemini','任务'),true);
  for(const label of ['Allow','Approve','Continue','确认付款','允许工具','Stop'])assert.equal(safeSendLabel(label),false);assert.equal(safeSendLabel('Send message'),true);
});
async function harness(transport:(url:string,init:any)=>Promise<Response>,pageReply?:(message:any)=>any){
  const config={origin:'https://rivule-bridge.hybridrevis.workers.dev',url:'https://chatgpt.com/c/bound',platform:'chatgpt',token:'fixture',workspaceId:'workspace',sourceId:'source',armed:false,expires_at:new Date(Date.now()+3600000).toISOString()};
  const data:any={config};let listener:any;const page:string[]=[];
  const chrome={runtime:{id:'probe',onMessage:{addListener:(f:any)=>listener=f}},storage:{local:{setAccessLevel:async()=>{},get:async()=>structuredClone(data),set:async(v:any)=>Object.assign(data,structuredClone(v)),remove:async(v:any)=>{for(const k of [].concat(v))delete data[k];},clear:async()=>{for(const k of Object.keys(data))delete data[k];}}},alarms:{create(){},onAlarm:{addListener(){}}},tabs:{query:async()=>[{id:1,url:config.url}],sendMessage:async(_id:number,m:any)=>{page.push(m.type);return pageReply?pageReply(m):{ok:true};}}};
  // Only Chrome APIs/transport are fixtures; the code under test is the shipped service worker.
  const c=createContext({validOrigin,conversationUrl,sameBinding,chrome,AbortSignal,URL,Date,Error,fetch:transport});
  runInContext(readFileSync(new URL('../connector/background.js',import.meta.url),'utf8').replace(/^import[^\n]*\n/,''),c);await new Promise(setImmediate);
  return {c,data,page,config,send:(m:any,sender:any={id:'probe'})=>new Promise<any>(resolve=>listener(m,sender,resolve))};
}
test('in-flight claim cannot orphan a spool through clear/configure; disarm prevents send',async()=>{
  let start!:()=>void,release!:(r:Response)=>void;const entered=new Promise<void>(r=>start=r);const held=new Promise<Response>(r=>release=r);const reports:any[]=[];
  const h=await harness(async(url,init)=>{if(url.endsWith('/claim')){start();return held;}reports.push(JSON.parse(init.body));return Response.json({accepted:true});});
  h.data.config.armed=true;const tick=h.c.tick();await entered;
  assert.equal((await h.send({type:'CLEAR'})).ok,false);assert.equal((await h.send({type:'CONFIGURE',config:h.config})).ok,false);assert.equal((await h.send({type:'ARM',armed:true})).ok,false);assert.equal((await h.send({type:'ARM',armed:false})).ok,true);
  release(Response.json({job:{job_id:'job',lease_token:'fixture',task_id:'task',arguments:{input:'probe'},lease_expires_at:new Date(Date.now()+90000).toISOString()}}));await tick;
  assert.ok(!h.page.includes('RIVULE_RUN'));assert.equal(reports[0].status,'blocked');assert.equal(h.data.spool,undefined);assert.equal((await h.send({type:'CLEAR'})).ok,true);
});
test('unknown HTTP acknowledgement retains the original immutable result',async()=>{
  let fail=true;const received:any[]=[];const h=await harness(async(_url,init)=>{received.push(JSON.parse(init.body));if(fail)throw Error('network reply lost');return Response.json({accepted:true});});
  const report={job_id:'job',lease_token:'fixture',status:'succeeded',result:{text:'真实夹具结果'}};
  await assert.rejects(h.c.deliver(h.config,report),/network reply lost/);assert.deepEqual(h.data.pendingReport,report);
  await assert.rejects(h.c.deliver(h.config,{...report,status:'unknown'}),/不覆盖/);assert.deepEqual(h.data.pendingReport,report);
  fail=false;await h.c.deliver(h.config,report);assert.equal(h.data.pendingReport,undefined);assert.deepEqual(received,[report,report]);
});
test('service-worker recovery renews an existing observer and never sends RUN again',async()=>{
  const calls:string[]=[];const h=await harness(async(url)=>{calls.push(url);return Response.json({lease_expires_at:new Date(Date.now()+90000).toISOString()});},m=>m.type==='RIVULE_STATUS'?{job_id:'job',phase:'observing'}:{ok:true});
  h.data.config.armed=true;h.data.spool={tabId:1,phase:'observing',job:{job_id:'job',lease_token:'fixture'}};await h.c.tick();assert.ok(h.data.spool);assert.ok(h.page.includes('RIVULE_LEASE'));assert.ok(!h.page.includes('RIVULE_RUN'));assert.ok(calls[0]!.endsWith('/heartbeat'));
});
test('observed Pro/Task composer guards allow empty input before a send button exists',()=>{
  let work=false,pro=true,task=true,stopping=false;const rect=()=>[{}];
  const node=(text:string,aria=''):any=>({textContent:text,getAttribute:(key:string)=>key==='aria-label'?aria:null,getClientRects:rect,dataset:{}});
  const proLeaf=node('Pro'),model=node('Wysiłek myślowyPro');model.querySelectorAll=()=>pro?[proLeaf]:[];
  let send:any[]= [];const form:any={querySelectorAll:()=>send};const box:any={innerText:'',getClientRects:rect,closest:()=>form};
  const document={addEventListener(){},querySelectorAll:(selector:string)=>{
    if(selector.startsWith('header button'))return work?[node('Work')]:[];
    if(selector.includes('model-switcher'))return [model];
    if(selector.startsWith('gem-segmented'))return [node(task?'Task':'Chat')];
    if(selector==='button')return stopping?[node('','Zatrzymaj generowanie')]:[];
    if(selector.includes('contenteditable'))return [box];return [];
  }};
  const context=createContext({document,location:{href:'https://chatgpt.com/c/bound'},chrome:{runtime:{onMessage:{addListener(){}}}}});
  const source=readFileSync(new URL('../connector/content.js',import.meta.url),'utf8').replace('  chrome.runtime.onMessage.addListener','  globalThis.guards={snapshot,sendButton};\n  chrome.runtime.onMessage.addListener');runInContext(source,context);const guards=context.guards as any;
  const config={url:'https://chatgpt.com/c/bound',platform:'chatgpt'};assert.doesNotThrow(()=>guards.snapshot(config));assert.throws(()=>guards.sendButton(form,true),/唯一发送按钮/);
  send=[node('','Wyślij')];assert.equal(guards.sendButton(form,true).getAttribute('aria-label'),'Wyślij');send=[node('','Approve')];assert.throws(()=>guards.sendButton(form,true),/唯一发送按钮/);
  work=true;assert.throws(()=>guards.snapshot(config),/Work/);work=false;pro=false;assert.throws(()=>guards.snapshot(config),/Pro/);pro=true;
  stopping=true;assert.throws(()=>guards.snapshot(config),/正在生成/);stopping=false;box.innerText='用户已有草稿';assert.throws(()=>guards.snapshot(config),/不会覆盖/);assert.equal(box.innerText,'用户已有草稿');box.innerText='';
  const gemini={url:'https://chatgpt.com/c/bound',platform:'gemini'};assert.doesNotThrow(()=>guards.snapshot(gemini));task=false;assert.throws(()=>guards.snapshot(gemini),/普通 Chat/);
});
test('completed page results fit the serialized HTTP envelope before becoming immutable',async()=>{
  for(const text of ['中文结果'.repeat(1000),'"'.repeat(120000),'"'.repeat(140000)]){
    const reports:any[]=[];
    const h=await harness(async(url,init)=>{
      if(url.endsWith('/heartbeat'))return Response.json({lease_expires_at:new Date(Date.now()+90000).toISOString()});
      const report=JSON.parse(init.body);reports.push(report);
      return new TextEncoder().encode(init.body).length>262144?Response.json({error:{message:'请求超过 256 KiB'}},{status:413}):Response.json({accepted:true});
    });
    const job={job_id:'fixture-job',lease_token:'fixture-lease',arguments:{input:'fixture prompt'},lease_expires_at:new Date(Date.now()+90000).toISOString()};
    h.data.config.armed=true;h.data.spool={job,tabId:1,phase:'claimed'};let sent=false;
    const rect=()=>[{}];const node=(label:string,aria=''):any=>({textContent:label,dataset:{},getClientRects:rect,getAttribute:(key:string)=>key==='aria-label'?aria:null,querySelectorAll:()=>[]});
    const send={...node('','Send message'),click:()=>{sent=true;}};const form={querySelectorAll:()=>[send]};
    const box={innerText:'',isContentEditable:true,getClientRects:rect,focus(){},closest:()=>form};
    const response={...node(''),innerText:text,dataset:{messageId:'fixture-response'},querySelector:()=>node('Copy')};
    const document={addEventListener(){},execCommand:(_command:string,_ui:boolean,value:string)=>{box.innerText=value;return true;},querySelectorAll:(selector:string)=>selector.includes('model-switcher')?[node('Pro')]:selector.includes('contenteditable')?[box]:selector==='[data-message-author-role="assistant"]'?(sent?[response]:[]):selector==='[data-message-author-role="user"]'?(sent?[node('user')]:[]):[]};
    const context=createContext({document,location:{href:h.config.url},Date,TextEncoder,setTimeout:(callback:()=>void)=>setImmediate(callback),chrome:{runtime:{onMessage:{addListener(){}},sendMessage:(message:any)=>h.send(message,{id:'probe',url:h.config.url,tab:{id:1}})}}});
    const source=readFileSync(new URL('../connector/content.js',import.meta.url),'utf8').replace('  chrome.runtime.onMessage.addListener','  globalThis.executeForTest=execute;\n  chrome.runtime.onMessage.addListener');runInContext(source,context);
    await context.executeForTest(job,{url:h.config.url,platform:'chatgpt'});
    assert.equal(reports.length,1);assert.ok(new TextEncoder().encode(JSON.stringify(reports[0])).length<=262144);
    assert.equal(h.data.pendingReport,undefined);assert.equal(h.data.spool,undefined);
    if(text.length===140000){assert.equal(reports[0].status,'unknown');assert.equal(reports[0].error.code,'observation_interrupted');assert.match(reports[0].error.message,/超过回执限额/);assert.equal(reports[0].result,undefined);}
    else {assert.equal(reports[0].status,'succeeded');assert.equal(reports[0].result.text,text);}
  }
});
