// Compose around the existing verified QQ webhook inbox. Never expose
// acceptVerified as a public RPC or infer trust from request-body flags.
const hash=async v=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(v)))].map(n=>n.toString(16).padStart(2,'0')).join('');
const fail=code=>{throw Object.assign(new Error(code),{code});};
const valid=v=>typeof v==='string'&&v.length>0&&v.length<=1024;
export class ConversationQQCommandAdapter {
 constructor({bridge,inbox,rawInbox=inbox,config,authority,revoked,now=Date.now}){Object.assign(this,{bridge,inbox,rawInbox,config,authority,revoked,now});}
 async current(){
  const c=this.config();if(c?.enabled!==true||!valid(c.ownerId)||!valid(c.appId)||!valid(c.userOpenId)||!Array.isArray(c.allowedSources))fail('conversation_qq_commands_disabled');
  if(typeof this.revoked!=='function'||await this.revoked(c))fail('conversation_qq_lifecycle_revoked');
  const a=await this.authority();if(a?.active!==true||a.conversationVerifierConfigured!==true||a.ownerId!==c.ownerId||a.appId!==c.appId||a.userOpenId!==c.userOpenId||!valid(a.generation)||!Number.isFinite(a.validUntil)||a.validUntil<=this.now())fail('conversation_qq_authority_unavailable');
  return {c,stamp:JSON.stringify([c.ownerId,c.appId,c.userOpenId,c.allowedSources,a.generation])};
 }
 async enqueueOnce(event){
  // Separate namespace; non-conversation callbacks are delegated unchanged to
  // the existing task/lifecycle wrapper. The raw durable inbox must be supplied
  // for chat callbacks so the legacy /rivule prefix cannot consume them.
  if(event.type!=='message'||!/^\/rivule-chat(?:\s|$)/.test(event.content?.trim()??''))return this.inbox.enqueueOnce(event);
  const inbox=this.rawInbox;
  const status=await inbox.enqueueOnce(event,{retainContent:false});if(status==='conflict'||status==='full')return status;
  await this.acceptVerified(event);return status;
 }
 async acceptVerified(event){
  const {c,stamp}=await this.current(),configuration=JSON.stringify(c);
  if(event?.channel!=='qq_c2c'||event.type!=='message'||event.appId!==c.appId||event.userOpenId!==c.userOpenId||!valid(event.eventId)||!valid(event.messageId))fail('conversation_qq_identity_invalid');
  const at=Date.parse(event.timestamp);if(!Number.isFinite(at)||at>this.now()+30000||this.now()-at>300000)fail('conversation_qq_event_stale');
  const match=/^\/rivule-chat ([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}) ([\s\S]{1,1200})$/.exec(event.content.trim());if(!match||!match[2].trim())fail('conversation_qq_syntax_invalid');
  const a=this.bridge.responseAuthority(match[1],'qq');if(!a?.commands_enabled||!c.allowedSources.includes(a.source_id))fail('conversation_qq_context_unavailable');
  const event_id='qq_'+await hash(JSON.stringify([c.appId,c.userOpenId,event.messageId])),trusted={channel:'qq',owner_id:c.ownerId,requester_id:c.userOpenId,conversation_id:c.userOpenId,event_id};
  const latest=await this.current();if(latest.stamp!==stamp)fail('conversation_qq_authority_changed');
  return this.bridge.enqueueCommand(trusted,{receipt_id:match[1],text:match[2],ttl_seconds:900},async()=>{
   // Internal closure runs inside ConversationBridge's insert transaction.
   if(JSON.stringify(this.config())!==configuration||await this.revoked(this.config()))fail('conversation_qq_lifecycle_revoked');
  });
 }
}
