// Conversation-v2 controls authenticate the original raw Discord request using the
// existing audited verifier. Receipt IDs, never user-supplied target text, route replies.
import { verifyDiscordCommandRequest, DiscordCommandError } from './discord-command-adapter.mjs';
const enc = new TextEncoder();
const verified = new WeakSet();
const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const refPattern = new RegExp('^rvconv:'+uuid+'$');
const modalPattern = new RegExp('^rvconvsubmit:'+uuid+'$');
const reject = (code,status=403) => {throw new DiscordCommandError(code,status);};
const json = (body,status=200) => Response.json(body,{status});
const notice = content => json({type:4,data:{content,flags:64,allowed_mentions:{parse:[]}}});
const validTarget = (target,receiptId) => target?.kind==='conversation' && target.version===2 && target.receipt_id===receiptId && ['context_ref','conversation_id','thread_id','source_id'].every(k=>typeof target[k]==='string'&&target[k].length>0) && !['project_id','task_id','run_id','branch_id'].some(k=>k in target);
export const conversationDiscordSchema=`
CREATE TABLE IF NOT EXISTS conversation_discord_modals(ref TEXT PRIMARY KEY,receipt_id TEXT NOT NULL,message_id TEXT NOT NULL,opening_event TEXT UNIQUE NOT NULL,submission_event TEXT,submission_hash TEXT,expires REAL NOT NULL);
`;
export class ConversationDiscordAdapter {
  constructor({storage,bindings,bridge,publicKey,now=Date.now,random=()=>crypto.randomUUID(),timeoutMs=1800}){
    Object.assign(this,{storage,bindings,bridge,publicKey,now,random,timeoutMs});storage.sql.exec(conversationDiscordSchema);
  }
  rows(q,...args){return this.storage.sql.exec(q,...args).toArray();}
  one(q,...args){return this.rows(q,...args)[0]??null;}
  nextExpiry(){return this.one('SELECT MIN(expires) AS at FROM conversation_discord_modals')?.at??Infinity;}
  expire(){this.rows('DELETE FROM conversation_discord_modals WHERE expires<=?',this.now());}
  async handleVerified(p,admissionGuard){
    if(!verified.has(p))reject('unverified_interaction');
    await admissionGuard();
    if(p.type===1)return json({type:1});
    const custom=p.data?.custom_id;
    if(typeof custom!=='string'||(!custom.startsWith('rvconv:')&&!custom.startsWith('rvconvsubmit:')))return null;
    if(p.type===3){
      if(!refPattern.test(custom)||p.data.component_type!==2||p.data.values!==undefined)reject('invalid_command_button',422);
      const ref=await this.storage.transaction(async()=>{
        await admissionGuard();
        const receiptId=custom.slice('rvconv:'.length);
        if(!validTarget(this.bridge.resolveDiscordReceipt(receiptId,p.message.id),receiptId))reject('invalid_conversation_target',409);
        this.rows('DELETE FROM conversation_discord_modals WHERE expires<=?',this.now());
        const old=this.one('SELECT * FROM conversation_discord_modals WHERE opening_event=?',p.id);
        if(old){if(old.receipt_id!==custom.slice('rvconv:'.length)||old.message_id!==p.message.id||old.expires<=this.now())reject('interaction_conflict',409);return old.ref;}
        if(this.one('SELECT COUNT(*) AS n FROM conversation_discord_modals').n>=2000)reject('bridge_modal_capacity',429);
        const ref='rvconvsubmit:'+this.random();this.rows('INSERT INTO conversation_discord_modals VALUES(?,?,?,?,NULL,NULL,?)',ref,custom.slice('rvconv:'.length),p.message.id,p.id,this.now()+300000);return ref;
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
      await admissionGuard();
      const ticket=this.one('SELECT * FROM conversation_discord_modals WHERE ref=?',custom);
      if(!ticket||ticket.expires<=this.now())reject('bridge_control_expired',409);
      if(ticket.message_id!==p.message.id)reject('bridge_control_expired',409);
      const context=this.bridge.resolveDiscordReceipt(ticket.receipt_id,p.message.id);
      if(!validTarget(context,ticket.receipt_id))reject('invalid_conversation_target',409);
      if(ticket.submission_event&&(ticket.submission_event!==p.id||ticket.submission_hash!==textHash))reject('interaction_conflict',409);
      this.rows('UPDATE conversation_discord_modals SET submission_event=?,submission_hash=? WHERE ref=?',p.id,textHash,custom);return context;
    });
    const receiptGuard=async()=>{
      await admissionGuard();
      const current=this.bridge.resolveDiscordReceipt(context.receipt_id,p.message.id);
      if(!validTarget(current,context.receipt_id)||['context_ref','conversation_id','thread_id','source_id'].some(k=>current[k]!==context[k]))reject('invalid_conversation_target',409);
    };
    const result=await this.bridge.enqueueCommand({channel:'discord',owner_id:this.bindings.ownerId,requester_id:p.user.id,conversation_id:p.channel_id,event_id:p.id},{receipt_id:context.receipt_id,text,ttl_seconds:3600},receiptGuard);
    return notice(result.state==='pending'?'指令已排队，等待原 PA 领取。尚未执行，也不会自动唤醒 PA。':`指令已有记录，状态：${['claimed','completed','rejected','unknown','expired'].includes(result.state)?result.state:'unknown'}。未重复下达。`);
  }
  async handle(request,{admissionGuard:outerGuard}={}){
    let timer, authenticated=false, timedOut=false;
    const deadline=performance.now()+this.timeoutMs;
    const admissionGuard=async()=>{if(timedOut||performance.now()>=deadline)reject('interaction_admission_expired',409);if(outerGuard)await outerGuard();if(timedOut||performance.now()>=deadline)reject('interaction_admission_expired',409);};
    try{
      // Includes body read and signature verification in the response budget. On timeout,
      // already-committed enqueue may be uncertain; the admission guard forbids late writes.
      return await Promise.race([(async()=>{const p=await verifyDiscordCommandRequest(request,this.bindings,this.publicKey,this.now());if(timedOut)return null;authenticated=true;verified.add(p);return this.handleVerified(p,admissionGuard);})(),new Promise(resolve=>{timer=setTimeout(()=>{timedOut=true;resolve(authenticated?notice('处理状态暂时无法确认，请勿重复下达；请向原 PA 查询。'):json({error:'interaction_verification_timeout'},503));},this.timeoutMs);})]);
    }catch(error){return json({error:error.code??'bridge_command_unavailable'},error.status??503);}
    finally{clearTimeout(timer);}
  }
}
