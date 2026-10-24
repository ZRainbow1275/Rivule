import {signQQAuthority} from './qq-response-consent.mjs';
const enc=new TextEncoder(),hex=v=>Array.from(new Uint8Array(v),b=>b.toString(16).padStart(2,'0')).join('');
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
// Fixed-origin, read-only verification of an independently recorded owner review.
// A producer signature merely authenticates this read, never confirms a review.
export async function qqConversationReviewAuthorityResponse(request,{enabled,secret,ownerId,appId,userOpenId,authorize,now=Date.now}){
 const fail=()=>Response.json({error:'conversation_review_authority_unavailable'},{status:403,headers:{'cache-control':'no-store'}});
 if(!enabled||request.method!=='POST'||request.url!=='https://rivule-owner.internal/internal/qq-conversation-review-authority'||typeof secret!=='string'||secret.length<32||typeof authorize!=='function')return fail();
 try{
  if(request.headers.get('content-type')?.split(';')[0]!=='application/json')return fail();const reader=request.body?.getReader();if(!reader)return fail();let size=0,chunks=[];
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>16384){await reader.cancel();return fail();}chunks.push(value);}
  const bytes=new Uint8Array(size);let at=0;for(const c of chunks){bytes.set(c,at);at+=c.length;}const packet=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  if(!exact(packet,['body','signature'])||typeof packet.body!=='string'||packet.body.length>12000||!/^[a-f0-9]{64}$/.test(packet.signature??''))return fail();
  const key=await crypto.subtle.importKey('raw',enc.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['verify']);if(!await crypto.subtle.verify('HMAC',key,Uint8Array.from(packet.signature.match(/../g),v=>parseInt(v,16)),enc.encode('rivule-qq-conversation-review-authority-request-v1\n'+packet.body)))return fail();
  const e=JSON.parse(packet.body);if(!exact(e,['version','nonce','timestamp','scope','review'])||e.version!==1||!/^[a-f0-9]{64}$/.test(e.nonce??'')||!Number.isSafeInteger(e.timestamp)||Math.abs(now()-e.timestamp)>30000||e.scope?.ownerId!==ownerId||e.scope.appId!==appId||e.scope.userOpenId!==userOpenId)return fail();
  const authorized=await authorize(e.scope,e.review)===true,value={version:1,requestHash:hex(await crypto.subtle.digest('SHA-256',enc.encode(packet.body))),nonce:e.nonce,authorized,validUntil:Math.min(e.timestamp+30000,now()+10000)};
  let signed=await signQQAuthority(secret,'rivule-qq-conversation-review-authority-response-v1',value);
  if(authorized&&await authorize(e.scope,e.review)!==true){value.authorized=false;signed=await signQQAuthority(secret,'rivule-qq-conversation-review-authority-response-v1',value);}
  return Response.json(signed,{headers:{'cache-control':'no-store'}});
 }catch{return fail();}
}
