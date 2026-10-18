/** Pure generic client request builder. Does not fetch, discover tasks, retry or store secrets. */
import {identifier,validateEvent,Rejected,safeUrl} from './contracts.ts';
import type {Source} from './contracts.ts';
export type SourceClientConfig={origin:string;source:Source;secret:()=>string};
export async function sourceRequest(config:SourceClientConfig,operation:'event'|'receipt',input:unknown,now=Date.now()):Promise<Request>{
 safeUrl(config.origin);const origin=new URL(config.origin);
 if(origin.protocol!=='https:'||origin.origin!==config.origin||origin.username||origin.password)throw new Rejected('origin_not_accepted',403);
 const source=structuredClone(config.source);identifier(source.source_id);
 if(!source.enabled||!(source.auth_methods??['oauth','hmac']).includes('hmac'))throw new Rejected('unauthorized_source',403);
 if(!Number.isSafeInteger(now)||now<0)throw new Rejected('invalid_time');
 let value:unknown,path:string;
 if(operation==='event'){value=validateEvent(input,source,now);path='/v1/events';}
 else if(operation==='receipt'){
  if(typeof input!=='string'||!/^rcpt_[a-f0-9]{32}$/.test(input))throw new Rejected('invalid_receipt');
  value={receipt_id:input};path='/v1/receipt';
 }else throw new Rejected('not_found',404);
 const body=JSON.stringify(value),bytes=new TextEncoder().encode(body);
 if(bytes.length>65536)throw new Rejected('body_too_large',413);
 const secret=config.secret();if(typeof secret!=='string'||new TextEncoder().encode(secret).length<32)throw new Rejected('source_not_configured',503);
 const timestamp=String(Math.floor(now/1000)),key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const signature=Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(timestamp+'.'+body))),b=>b.toString(16).padStart(2,'0')).join('');
 return new Request(config.origin+path,{method:'POST',headers:{'content-type':'application/json','x-pa-source':source.source_id,'x-pa-timestamp':timestamp,'x-pa-signature':signature},body,redirect:'manual'});
}
