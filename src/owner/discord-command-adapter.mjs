// Owner-only Discord button -> modal -> durable PA command queue. No network sends.
const enc = new TextEncoder();
const snowflake = v => typeof v === 'string' && /^\d{1,25}$/.test(v);
const refPattern = /^rvcommand:[a-f0-9-]{36}$/;
const modalPattern = /^rvsubmit:[a-f0-9-]{36}$/;
const fields = ['source_id','project_id','task_id','run_id','branch_id','thread_id'];
const verified = new WeakSet();
export class DiscordCommandError extends Error {
  constructor(code,status=403){super(code);this.code=code;this.status=status;}
}
const reject = (code,status) => { throw new DiscordCommandError(code,status); };
const hex = s => new Uint8Array(s.match(/../g).map(x=>parseInt(x,16)));
const json = (body,status=200) => Response.json(body,{status});
const notice = content => json({type:4,data:{content,flags:64,allowed_mentions:{parse:[]}}});
export async function verifyDiscordCommandRequest(request,b,publicKey,now=Date.now()) {
  const url = new URL(request.url);
  if(request.method!=='POST'||url.origin!==b.publicOrigin||url.pathname!=='/discord/interactions'||url.search||request.headers.has('authorization'))reject('invalid_interaction');
  if(!/^[a-fA-F0-9]{64}$/.test(publicKey??''))reject('interaction_key_not_configured',503);
  const stamp=request.headers.get('x-signature-timestamp')??'',signature=request.headers.get('x-signature-ed25519')??'';
  if(!/^\d{1,14}$/.test(stamp)||Math.abs(now/1000-Number(stamp))>300||!/^[a-fA-F0-9]{128}$/.test(signature))reject('invalid_interaction_signature',401);
  const reader=request.body?.getReader();if(!reader)reject('invalid_interaction',400);
  let size=0;const chunks=[];
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>65536){await reader.cancel();reject('body_too_large',413);}chunks.push(value);}
  const prefix=enc.encode(stamp),bytes=new Uint8Array(prefix.length+size);bytes.set(prefix);let offset=prefix.length;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  const key=await crypto.subtle.importKey('raw',hex(publicKey),'Ed25519',false,['verify']);
  if(!await crypto.subtle.verify('Ed25519',key,hex(signature),bytes))reject('invalid_interaction_signature',401);
  let p;try{p=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(prefix.length)));}catch{reject('invalid_interaction',400);}
  if(!p||p.application_id!==b.appId||!snowflake(p.id))reject('invalid_interaction_identity');
  if(p.type===1){verified.add(p);return p;}
  if(p.user?.id!==b.userId||p.user.bot===true||p.member||p.guild_id||p.guild||p.context!==1||p.channel_id!==b.dmId||(p.channel?.id&&p.channel.id!==b.dmId))reject('owner_dm_required');
  const install=p.authorizing_integration_owners;
  if(!install||Array.isArray(install)||!(install['0']==='0'||install['1']===b.userId)||Object.keys(install).some(k=>!['0','1'].includes(k))||('1' in install&&install['1']!==b.userId)||('0' in install&&install['0']!=='0'))reject('installation_not_bound');
  if(![3,5].includes(p.type)||!snowflake(p.message?.id)||p.message?.author?.id!==b.appId||(p.message.channel_id&&p.message.channel_id!==b.dmId))reject('unsupported_interaction');
  verified.add(p);return p;
}
export const discordCommandSchema=`
CREATE TABLE IF NOT EXISTS bridge_discord_modals(ref TEXT PRIMARY KEY,context_ref TEXT NOT NULL,message_id TEXT NOT NULL,opening_event TEXT UNIQUE NOT NULL,submission_event TEXT,submission_hash TEXT,expires REAL NOT NULL);
`;
export class DiscordCommandAdapter {
  constructor({storage,bindings,bridge,publicKey,now=Date.now,random=()=>crypto.randomUUID(),timeoutMs=1800}){
    Object.assign(this,{storage,bindings,bridge,publicKey,now,random,timeoutMs});storage.sql.exec(discordCommandSchema);
  }
  rows(q,...args){return this.storage.sql.exec(q,...args).toArray();}
  one(q,...args){return this.rows(q,...args)[0]??null;}
  nextExpiry(){return this.one('SELECT MIN(expires) AS at FROM bridge_discord_modals')?.at??Infinity;}
  expire(){this.rows('DELETE FROM bridge_discord_modals WHERE expires<=?',this.now());}
  async handleVerified(p){
    if(!verified.has(p))reject('unverified_interaction');
    if(p.type===1)return json({type:1});
    const custom=p.data?.custom_id;
    if(typeof custom!=='string'||(!custom.startsWith('rvcommand:')&&!custom.startsWith('rvsubmit:')))return null;
    if(p.type===3){
      if(!refPattern.test(custom)||p.data.component_type!==2||p.data.values!==undefined)reject('invalid_command_button',422);
      const ref=await this.storage.transaction(async()=>{
        this.bridge.resolveDiscordContext(custom.slice('rvcommand:'.length),p.message.id);
        this.rows('DELETE FROM bridge_discord_modals WHERE expires<=?',this.now());
        const old=this.one('SELECT * FROM bridge_discord_modals WHERE opening_event=?',p.id);
        if(old){if(old.context_ref!==custom.slice('rvcommand:'.length)||old.message_id!==p.message.id||old.expires<=this.now())reject('interaction_conflict',409);return old.ref;}
        if(this.one('SELECT COUNT(*) AS n FROM bridge_discord_modals').n>=2000)reject('bridge_modal_capacity',429);
        const ref='rvsubmit:'+this.random();this.rows('INSERT INTO bridge_discord_modals VALUES(?,?,?,?,NULL,NULL,?)',ref,custom.slice('rvcommand:'.length),p.message.id,p.id,this.now()+300000);return ref;
      });
      return json({type:9,data:{custom_id:ref,title:'向此 PA 下达指令',components:[{type:1,components:[{type:4,custom_id:'instruction',label:'指令（由原 PA 判断并执行）',style:2,required:true,min_length:1,max_length:1200}]}]}});
    }
    if(p.type!==5||!modalPattern.test(custom))reject('invalid_command_modal',422);
    const rows=p.data.components;
    if(!Array.isArray(rows)||rows.length!==1||rows[0].type!==1||!Array.isArray(rows[0].components)||rows[0].components.length!==1)reject('invalid_command_text',422);
    const input=rows[0].components[0],text=input.value;
    if(input.type!==4||input.custom_id!=='instruction'||typeof text!=='string'||!text.trim()||text.length>1200||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text))reject('invalid_command_text',422);
    // Persist one submission identity before enqueue. Retrying that same identity is safe;
    // a different interaction can never reuse this modal to issue another command.
    const textHash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(text))),x=>x.toString(16).padStart(2,'0')).join('');
    const context=await this.storage.transaction(async()=>{
      const ticket=this.one('SELECT * FROM bridge_discord_modals WHERE ref=?',custom);
      if(!ticket||ticket.expires<=this.now())reject('bridge_control_expired',409);
      if(ticket.message_id!==p.message.id)reject('bridge_control_expired',409);
      const context=this.bridge.resolveDiscordContext(ticket.context_ref,p.message.id);
      if(ticket.submission_event&&(ticket.submission_event!==p.id||ticket.submission_hash!==textHash))reject('interaction_conflict',409);
      this.rows('UPDATE bridge_discord_modals SET submission_event=?,submission_hash=? WHERE ref=?',p.id,textHash,custom);return context;
    });
    const result=await this.bridge.enqueueCommand({channel:'discord',owner_id:this.bindings.ownerId,requester_id:p.user.id,conversation_id:p.channel_id,event_id:p.id},{...Object.fromEntries(fields.map(k=>[k,context[k]])),text,ttl_seconds:3600});
    return notice(result.state==='pending'?'指令已排队，等待原 PA 领取。尚未执行，也不会自动唤醒 PA。':`指令已有记录，状态：${['claimed','completed','rejected','unknown','expired'].includes(result.state)?result.state:'unknown'}。未重复下达。`);
  }
  async handle(request){
    let timer, authenticated=false, timedOut=false;
    try{
      // Includes body read and signature verification in the response budget. On timeout,
      // enqueue may finish; never report failure or auto-retry an uncertain command.
      return await Promise.race([(async()=>{const p=await verifyDiscordCommandRequest(request,this.bindings,this.publicKey,this.now());if(timedOut)return null;authenticated=true;return this.handleVerified(p);})(),new Promise(resolve=>{timer=setTimeout(()=>{timedOut=true;resolve(authenticated?notice('处理状态暂时无法确认，请勿重复下达；请向原 PA 查询。'):json({error:'interaction_verification_timeout'},503));},this.timeoutMs);})]);
    }catch(error){return json({error:error.code??'bridge_command_unavailable'},error.status??503);}
    finally{clearTimeout(timer);}
  }
}
