/** Discord signed HTTP interactions. Only this owner in this bot's one DM. */
import {Rejected} from './contracts.ts';import {jsonResponse,safeError} from './auth.ts';import type {Bindings} from './auth.ts';
import type {DiagnosticTrace} from './diagnostics.ts';
export type DiscordInteraction={id:string;data:any;message?:any;type:number};
export async function verifyDiscordInteraction(request:Request,b:Bindings,publicKey:string,guildId:string,now=Date.now()):Promise<DiscordInteraction>{
 if(request.method!=='POST'||new URL(request.url).origin!==b.publicOrigin||new URL(request.url).search||request.headers.has('authorization'))throw new Rejected('invalid_interaction',403);
 if(!/^[a-fA-F0-9]{64}$/.test(publicKey))throw new Rejected('interaction_key_not_configured',503);
 const stamp=request.headers.get('x-signature-timestamp')??'',sig=request.headers.get('x-signature-ed25519')??'';
 if(!/^\d{1,14}$/.test(stamp)||Math.abs(now/1000-Number(stamp))>300||!/^[a-fA-F0-9]{128}$/.test(sig))throw new Rejected('invalid_interaction_signature',401);
 const reader=request.body?.getReader();const chunks:Uint8Array[]=[];let size=0;
 if(!reader)throw new Rejected('invalid_interaction',400);
 while(true){const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>65536){await reader.cancel();throw new Rejected('body_too_large',413);}chunks.push(r.value);}
 const prefix=new TextEncoder().encode(stamp),bytes=new Uint8Array(size+prefix.length);bytes.set(prefix);let offset=prefix.length;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
 const hex=(s:string)=>new Uint8Array(s.match(/.{2}/g)!.map(x=>parseInt(x,16)));
 const key=await crypto.subtle.importKey('raw',hex(publicKey),{name:'Ed25519'},false,['verify']);
 if(!await crypto.subtle.verify('Ed25519',key,hex(sig),bytes))throw new Rejected('invalid_interaction_signature',401);
 let p:any;try{p=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(bytes.subarray(prefix.length)));}catch{throw new Rejected('invalid_interaction',400);}
 if(p.application_id!==b.appId||!/^\d{1,25}$/.test(p.id??''))throw new Rejected('invalid_interaction_identity',403);
 if(p.type===1)return p; // Discord's signed endpoint verification ping has no user.
 const actor=p.user??p.member?.user;
 if(!actor||actor.id!==b.userId||actor.bot===true||p.context!==1||p.channel_id!==b.dmId||p.guild_id)throw new Rejected('owner_dm_required',403);
 if(p.user&&p.member?.user&&p.user.id!==p.member.user.id)throw new Rejected('actor_mismatch',403);
 const install=p.authorizing_integration_owners;
 // Discord uses the string "0" for Guild Install interactions in the bot DM.
 // The signed actor, BOT_DM context and exact DM were independently bound above.
 if(!install||!(install['0']==='0'||install['1']===b.userId)||Object.keys(install).some(k=>!['0','1'].includes(k)))throw new Rejected('installation_not_bound',403);
 if(p.type!==3||p.message?.channel_id&&p.message.channel_id!==b.dmId||p.message?.author?.id!==b.appId)throw new Rejected('unsupported_interaction',403);
 return p;
}
export async function interactionResponse(request:Request,b:Bindings,publicKey:string,guildId:string,select:(p:DiscordInteraction)=>Promise<any>,trace?:DiagnosticTrace){
 const mark=(stage:string,code:string,status=200)=>{try{trace?.mark(stage,code,status);}catch{}};
 try{const p=await verifyDiscordInteraction(request,b,publicKey,guildId);mark('discord_verify','ok');if(p.type===1){mark('discord_select','interaction_ping');return jsonResponse({type:1});}
  // Store-only handler is budgeted. If acknowledgement is lost, it is not replayed.
  let timer:any;const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Rejected('selection_status_unknown',503)),1500);});
  try{const result:any=await Promise.race([select(p),timeout]);
   if(result?.expired===true&&/^refresh:[a-f0-9-]{36}$/.test(result.refresh_custom_id??'')){mark('discord_refresh','refresh_ticket_issued');return jsonResponse({type:4,data:{content:'这个面板的操作控件已过期或已被更新，未执行此次选择。点击下方按钮刷新现有总览，再重新选择。',flags:64,allowed_mentions:{parse:[]},components:[{type:1,components:[{type:2,style:1,label:'刷新总览',custom_id:result.refresh_custom_id}]}]}});}
   if(result?.refreshed===true){mark('discord_refresh','refresh_queued');return jsonResponse({type:7,data:{content:'已请求刷新现有总览，请回到总览重新选择。',allowed_mentions:{parse:[]},components:[]}});}
   mark('discord_select',result?.duplicate===true?'interaction_duplicate':'selection_accepted');
  }catch(error){
   // Only a verified owner interaction can reach this branch. Do not revive
   // expired controls, change selection, enqueue delivery or retry the action.
   if(error instanceof Rejected&&error.code==='view_expired'){mark(p.data?.custom_id?.startsWith('refresh:')?'discord_refresh':'discord_select',p.data?.custom_id?.startsWith('refresh:')?'refresh_ticket_rejected':'view_expired');return jsonResponse({type:4,data:{content:'这个操作入口已过期、失效或无法确认来源，未执行此次选择。请回到现有总览再点一次控件，获取新的刷新入口；若仍无法刷新，请告知我。',flags:64,allowed_mentions:{parse:[]}}});}
   throw error;
  }finally{clearTimeout(timer);}
  return jsonResponse({type:6});
 }catch(error){const response=safeError(error);mark('discord_interaction',error instanceof Rejected?error.code:'unclassified_error',response.status);return response;}
}
