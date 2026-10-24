import {BridgeError} from './message-bridge.mjs';
export const isBridgeSettingsPath = path => path === '/dashboard/bridge' || path === '/dashboard/bridge/preference' || path === '/dashboard/bridge/access' || path === '/dashboard/bridge/qq-response/access' || path === '/dashboard/bridge/qq-response/preference';
// This handler is reached only after the existing dashboard owner session,
// identity binding and same-origin checks. Mutations additionally require CSRF.
export async function dashboardBridge(request,{session,sessionKey,storage,config,now,manageBridge,headers}) {
  const reply=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:headers()});
  if(typeof manageBridge!=='function')return reply({error:'bridge_unavailable'},503);
  const path=new URL(request.url).pathname,sources=[config.source,...config.sources];
  if(request.method!==(path==='/dashboard/bridge'?'GET':'POST'))return reply({error:'method_not_allowed'},405);
  try {
    if(request.method==='GET')return reply({csrf:session.csrf,sources:await Promise.all(sources.map(source=>manageBridge(source,'capabilities',{})))});
    if(request.headers.get('content-type')?.split(';')[0]!=='application/json')return reply({error:'json_required'},415);
    const reader=request.body?.getReader();if(!reader)return reply({error:'invalid_bridge_preference'},422);
    let chunks=[],size=0;for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>2048){await reader.cancel();return reply({error:'body_too_large'},413);}chunks.push(value);}
    const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
    let data;try{data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{return reply({error:'invalid_bridge_preference'},422);}
    if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).some(k=>!['source_id','csrf','mode','commands_enabled','expected_revision','confirm','access_token','enabled'].includes(k)))return reply({error:'invalid_bridge_preference'},422);
    if(typeof session.csrf!=='string'||data.csrf!==session.csrf)return reply({error:'csrf_required'},403);
    const source=sources.find(s=>s.source_id===data.source_id);if(!source)return reply({error:'source_not_authorized'},403);
    if(path.endsWith('/access')) {
      if(Object.keys(data).sort().join(',')!=='confirm,csrf,source_id'||data.confirm!==true)return reply({error:'explicit_bridge_access_required'},403);
      const qq=path.includes('/qq-response/');
      let target=null;if(qq){try{target=await manageBridge(source,'qq_target',{});}catch{}}
      const cap={qq,target,token:crypto.randomUUID(),source_id:source.source_id,binding:await manageBridge(source,'binding',{}),expires:Math.min(session.expires,now()+300000)};
      await storage.transaction(async tx=>{const live=await tx.get(sessionKey);if(!live||live.binding!==session.binding||live.expires<=now())throw new BridgeError('dashboard_login_required',401);await tx.put(sessionKey,{...live,[qq?'bridgeQQAccess':'bridgeAccess']:cap});});
      return reply({state:'authorized',source_id:source.source_id,access_token:cap.token,expires_at:cap.expires,...qq?{...await manageBridge(source,'qq_status',{}),recipient_label:target?'本人 QQ · 已确认绑定（账号已隐藏）':(await manageBridge(source,'qq_status',{})).recipient_label,can_enable:!!target}:{} });
    }
    const live=await storage.get(sessionKey);
    if(!live||live.binding!==session.binding||live.expires<=now())return reply({error:'dashboard_login_required'},401);
    const qq=path.includes('/qq-response/'),cap=qq?live.bridgeQQAccess:live.bridgeAccess;
    if(!cap||cap.source_id!==source.source_id||cap.expires<=now()||cap.token!==data.access_token||cap.binding!==await manageBridge(source,'binding',{}))return reply({error:'bridge_access_required'},403);
    const admissionGuard=async()=>{
      const current=await storage.get(sessionKey),grant=current?.[qq?'bridgeQQAccess':'bridgeAccess'];
      if(!current||current.binding!==session.binding||current.expires<=now()||!grant||grant.token!==cap.token||grant.source_id!==source.source_id||grant.expires<=now())throw new BridgeError('bridge_access_required',403);
    };
    if(qq)return reply(await manageBridge(source,'qq_preference',{enabled:data.enabled,expected_revision:data.expected_revision,confirm:data.confirm,target:cap.target,binding_token:cap.binding},admissionGuard));
    return reply(await manageBridge(source,'preference',{mode:data.mode,commands_enabled:data.commands_enabled,expected_revision:data.expected_revision,confirm:data.confirm},admissionGuard));
  } catch(error){return reply({error:error instanceof BridgeError?error.code:'bridge_unavailable'},error instanceof BridgeError?error.status:503);}
}
