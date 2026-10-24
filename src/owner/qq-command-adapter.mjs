// QQ owner-webhook command adapter. Never accepts raw HTTP bodies or public RPC input.
// Install only as the inbox passed to handleQQWebhook AFTER its existing signature
// and configured owner identity checks. Gateway websocket dispatch is a separate path.
const fields = ['source_id','project_id','task_id','run_id','branch_id','thread_id'];
const hash = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(x=>x.toString(16).padStart(2,'0')).join('');
const fail = code => { throw Object.assign(new Error(code),{code}); };
const valid = v => typeof v === 'string' && v.length > 0 && v.length <= 1024;
export class QQCommandAdapter {
  constructor({bridge, inbox, config, authority, revoked, now=Date.now}) {
    Object.assign(this,{bridge,inbox,config,authority,revoked,now});
  }
  async current(){
    const c=this.config(),a=await this.authority();
    if(typeof this.revoked !== 'function' || await this.revoked(c))fail('qq_command_lifecycle_revoked');
    if(c?.enabled!==true||!valid(c.ownerId)||!valid(c.appId)||!valid(c.userOpenId)||!Array.isArray(c.allowedSources)||!Array.isArray(c.allowedProjects))fail('qq_commands_disabled');
    // Evidence must come from the existing server-side enrollment/lifecycle broker,
    // never from callback fields or merely QQ_ENABLED / QQ_DELIVERY_ENABLED.
    if(a?.active!==true||a.ownerId!==c.ownerId||a.appId!==c.appId||a.userOpenId!==c.userOpenId||!valid(a.generation)||!Number.isFinite(a.validUntil)||a.validUntil<=this.now())fail('qq_command_authority_unavailable');
    return {c,stamp:JSON.stringify([c.ownerId,c.appId,c.userOpenId,c.allowedSources,c.allowedProjects,a.generation])};
  }
  context(context,c){
    if(!context||Object.keys(context).some(k=>!fields.includes(k))||!fields.every(k=>valid(context[k])))fail('qq_command_context_invalid');
    if(!c.allowedSources.includes(context.source_id)||!c.allowedProjects.includes(context.project_id))fail('qq_command_scope_denied');
    const source=this.bridge.bindings.sources.find(s=>s.source_id===context.source_id);
    const registered=this.bridge.requireContext(source,context);
    if(!this.bridge.preference(source).commands_enabled)fail('bridge_commands_not_enabled');
    return {source,context:registered,binding:this.bridge.binding(source)};
  }
  async enqueueOnce(event){
    // This method is reachable only from handleQQWebhook's verified normalized path.
    // Keep original inbox dedupe/lifecycle gates; retry duplicates after a crash.
    const status=await this.inbox.enqueueOnce(event);
    if(status==='conflict'||status==='full')return status;
    if(event.type!=='message'||!event.content?.trim().startsWith('/rivule'))return status;
    await this.acceptVerified(event);
    return status;
  }
  async acceptVerified(event){
    const {c,stamp}=await this.current();
    if(event?.channel!=='qq_c2c'||event.type!=='message'||event.appId!==c.appId||event.userOpenId!==c.userOpenId||!valid(event.eventId)||!valid(event.messageId))fail('qq_command_identity_invalid');
    const at=Date.parse(event.timestamp);
    if(!Number.isFinite(at)||at>this.now()+30000||this.now()-at>300000)fail('qq_command_event_stale');
    const match=/^\/rivule ([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}) ([\s\S]{1,1200})$/.exec(event.content.trim());
    if(!match||!match[2].trim())fail('qq_command_syntax_invalid');
    const event_id='qq_'+await hash(JSON.stringify([c.appId,c.userOpenId,event.messageId]));
    const trusted={channel:'qq',owner_id:c.ownerId,requester_id:c.userOpenId,conversation_id:c.userOpenId,event_id};
    const resolved=await this.bridge.resolveQQContext(match[1],trusted);
    const checked=this.context(resolved,c);
    const latest=await this.current();if(latest.stamp!==stamp)fail('qq_command_authority_changed');
    return this.bridge.enqueueCommand(trusted,{...checked.context,text:match[2],ttl_seconds:900},async()=>{
      // MessageBridge invokes this internal-only guard inside its durable insert
      // transaction, closing the local FRIEND_DEL/reject race after async hashing.
      const current=this.config();
      if(JSON.stringify(current)!==JSON.stringify(c)||await this.revoked(current))fail('qq_command_lifecycle_revoked');
    });
  }
}
