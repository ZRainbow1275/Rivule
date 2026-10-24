import {signQQAuthority} from './qq-response-consent.mjs';
const enc=new TextEncoder(),hex=b=>Array.from(new Uint8Array(b),v=>v.toString(16).padStart(2,'0')).join('');
const digest=async s=>hex(await crypto.subtle.digest('SHA-256',enc.encode(s)));
const stable=v=>v&&typeof v==='object'?Array.isArray(v)?v.map(stable):Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
// Read-only independent authority. Never calls gateway, changes consent, creates
// queues, refreshes proofs or schedules alarms while gateway waits for it.
export async function qqConversationAuthorityResponse(request,{secret,enabled,ownerId,appId,userOpenId,bridge,loadJob,now=Date.now}){
 const fail=()=>Response.json({error:'conversation_authority_unavailable'},{status:403,headers:{'cache-control':'no-store'}});
 if(!enabled||request.method!=='POST'||request.url!=='https://rivule-owner.internal/internal/qq-conversation-authority'||typeof secret!=='string'||secret.length<32)return fail();
 try{
  if(request.headers.get('content-type')?.split(';')[0]!=='application/json')return fail();
  const reader=request.body?.getReader();if(!reader)return fail();let size=0,chunks=[];
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>32768){await reader.cancel();return fail();}chunks.push(value);}
  const bytes=new Uint8Array(size);let at=0;for(const c of chunks){bytes.set(c,at);at+=c.length;}
  const packet=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  if(!exact(packet,['body','signature'])||typeof packet.body!=='string'||packet.body.length>24576||!/^[a-f0-9]{64}$/.test(packet.signature??''))return fail();
  const key=await crypto.subtle.importKey('raw',enc.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['verify']);
  if(!await crypto.subtle.verify('HMAC',key,Uint8Array.from(packet.signature.match(/../g),v=>parseInt(v,16)),enc.encode('rivule-qq-conversation-authority-request-v2\n'+packet.body)))return fail();
  const e=JSON.parse(packet.body);
  if(!exact(e,['version','nonce','timestamp','ownerId','appId','userOpenId','bindingFingerprint','runtimeEpoch','grantId','job'])||e.version!==2||e.ownerId!==ownerId||e.appId!==appId||e.userOpenId!==userOpenId||!/^[a-f0-9]{64}$/.test(e.nonce??'')||!Number.isSafeInteger(e.timestamp)||Math.abs(now()-e.timestamp)>30000)return fail();
  let authorized=false;
  const first=bridge.responseAuthority(e.job?.receiptId,'qq');
  if(first&&e.job?.kind==='conversation'&&e.job.version===2&&e.job.grantId===e.grantId&&e.job.bindingFingerprint===e.bindingFingerprint&&bridge.recipientBinding('qq')===JSON.stringify([ownerId,appId,userOpenId,e.bindingFingerprint])){
   const stored=await loadJob(e.job.receiptId),fresh=bridge.responseAuthority(e.job.receiptId,'qq');
   authorized=!!stored&&!!fresh&&JSON.stringify(stable(first))===JSON.stringify(stable(fresh))&&JSON.stringify(stable(stored.job))===JSON.stringify(stable(e.job))&&bridge.recipientBinding('qq')===JSON.stringify([ownerId,appId,userOpenId,e.bindingFingerprint]);
  }
  const value={version:2,requestHash:await digest(packet.body),nonce:e.nonce,authorized,validUntil:Math.min(e.timestamp+30000,now()+10000)};
  // Signing has no side effects; the gateway re-fetches independently at commit.
  let signed=await signQQAuthority(secret,'rivule-qq-conversation-authority-response-v2',value);
  if(authorized&&(JSON.stringify(stable(first))!==JSON.stringify(stable(bridge.responseAuthority(e.job.receiptId,'qq')))||bridge.recipientBinding('qq')!==JSON.stringify([ownerId,appId,userOpenId,e.bindingFingerprint]))){value.authorized=false;signed=await signQQAuthority(secret,'rivule-qq-conversation-authority-response-v2',value);}
  return Response.json(signed,{headers:{'cache-control':'no-store'}});
 }catch{return fail();}
}
