// Offline contract for QwenPaw v2.3.0.post1. No fetch, account or external URL.
import {createHash} from 'node:crypto';
export const stable='2.3.0.post1';
export const sha=s=>createHash('sha256').update(s).digest('hex');
const ref=s=>typeof s==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(s);
const uuid=s=>typeof s==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(s);
const text=(s,max)=>typeof s==='string'&&!!s.trim()&&Buffer.byteLength(s,'utf8')<=max;
const root='/api/console/chat', hdr='X-Agent-Id';
export function scopeFor(b,task){
 if(b?.enabled!==true||b.mode!=='offline-fixture'||b.provider!=='qwenpaw'||b.version!==stable||
 b.scope!=='public-text'||b.dedicated!==true||b.toolsDisabled!==true||
 ![b.instance,b.agent,b.user,b.lane,task].every(ref)||b.channel!=='console')
 throw new TypeError('unapproved QwenPaw lab scope');
 return [b.instance,b.version,b.agent,b.user,b.lane,b.channel,task];
}
export function prepare(scope,approvedText,inputDigest){
 if(!text(approvedText,3000)||sha(approvedText)!==inputDigest)throw TypeError('unapproved trial text');
 const marker='rvqp-'+sha(JSON.stringify(['rivule/qwenpaw/stable/v1',scope])).slice(0,32);
 const session='rivule-'+marker;
 const envelope='Rivule-Result '+marker+'\n'+approvedText+
   '\nReturn plain text, beginning with this first line verbatim. Do not invoke any tool.';
 return {entry:{scope,session,marker,inputDigest,promptDigest:sha(envelope),phase:'awaiting_binding',chat:null,
  attached:false,artifact:null},request:request(scope,session,{input:[{role:'user',content:[{type:'text',text:envelope}]}]})};
}
function request(scope,session,op){
 const [instance,,agent,user,,channel]=scope;
 const headers={[hdr]:agent,'Content-Type':'application/json'};
 // The offline harness routes an alias, never a hostname or token.
 return {instance,method:'POST',path:root,headers,body:{user_id:user,channel,session_id:session,...op}};
}
export function verifiedBinding(entry,proof,now){
 const [instance,version,agent,user,,channel]=entry.scope;
 // Trusted gateway observation in production would be separate from the HTTP response body;
 // here a test fixture provides it. Never infer scope from an SSE payload.
 return proof?.source==='mock-owned-registry'&&proof.instance===instance&&proof.version===version&&proof.agent===agent&&
 proof.user===user&&proof.channel===channel&&proof.session===entry.session&&uuid(proof.chat)&&
 Number.isSafeInteger(now)&&now>=0&&Number.isSafeInteger(proof.observedAt)&&proof.observedAt>=0&&now>=proof.observedAt&&
 now-proof.observedAt<=30_000&&(!entry.chat||entry.chat===proof.chat);
}
export const attachOnly=entry=>request(entry.scope,entry.session,{reconnect:true});
export function exactHistory(entry){
 const [instance,,agent]=entry.scope;
 return {instance,path:'/api/chats/'+entry.chat+'?include_app_owned=false',method:'GET',headers:{[hdr]:agent}};
}
export function historyArtifact(entry,observation){
 if(!entry.chat||entry.phase!=='bound'||observation?.source!=='mock-pinned-response')return null;
 const {request:actual,status,body}=observation, plan=exactHistory(entry);
 if(actual?.instance!==plan.instance||actual.path!==plan.path||actual.method!==plan.method||
 actual.headers?.[hdr]!==plan.headers[hdr]||status!==200||body?.status!=='idle'||!Array.isArray(body.messages)||
 body.messages.length!==2||Object.hasOwn(body,'next_cursor'))return null;
 const get=(m,role)=>m?.type==='message'&&m.role===role&&m.status==='completed'&&Array.isArray(m.content)&&
 m.content.length===1&&m.content[0]?.type==='text'&&text(m.content[0].text,3500)?m.content[0].text:null;
 const [original,reply]=body.messages, user=get(original,'user'), assistant=get(reply,'assistant');
 if(!user||sha(user)!==entry.promptDigest||!assistant)return null;
 const prefix='Rivule-Result '+entry.marker+'\n';
 if(!assistant.startsWith(prefix))return null;
 const bodyText=assistant.slice(prefix.length).trim();
 if(!text(bodyText,3000)||bodyText.includes('Rivule-Result '))return null;
 // Returns only a candidate artifact, not an acceptance. Tool/reasoning/links
 // are never interpreted or executed. Consumers display this as plain text.
 return {kind:'text/plain',text:bodyText,digest:sha(bodyText)};
}
