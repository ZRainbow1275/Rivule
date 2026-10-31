// Isolated preference-only boundary. Deliberately not imported by production routes.
import {createUnboundUsagePreferenceController, UsagePreferenceError} from './usage-preference-draft.mjs';
const PATH='/dashboard/usage-preference';
const hex=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; frame-ancestors 'none'",'referrer-policy':'no-referrer'}});
// authenticate must resolve/revalidate the real server owner session and management
// capability for THIS request on every invocation. Never derive authority from JSON.
export function createUsagePreferenceHandler({storage,authenticate,origin,now}) {
  const expected=new URL(origin);
  if(expected.protocol!=='https:'||expected.origin!==origin||typeof authenticate!=='function')throw new TypeError('invalid_adapter');
  return async request=>{
    const reject=(error,status)=>response({error,monitoring:'not_connected',notifications_enabled:false},status);
    try {
      const url=new URL(request.url);
      if(url.origin!==origin||url.pathname!==PATH||url.search)return reject('not_found',404);
      if(!['GET','POST'].includes(request.method))return reject('method_not_allowed',405);
      if(request.headers.get('sec-fetch-site')!=='same-origin'||(request.method==='POST'?request.headers.get('origin')!==origin:request.headers.has('origin')&&request.headers.get('origin')!==origin))return reject('origin_not_accepted',403);
      let initial;
      const context=async()=>{
        const c=await authenticate(request);
        if(!c||c.authorized!==true||!hex(c.csrf)||!Number.isSafeInteger(c.authorization_expires_at)||c.authorization_expires_at<=now())throw new UsagePreferenceError('management_authorization_required',403);
        if(initial&&(c.csrf!==initial.csrf||c.session_binding!==initial.session_binding||c.owner_binding!==initial.owner_binding))throw new UsagePreferenceError('management_authorization_changed',403);
        return c;
      };
      initial=structuredClone(await context());
      const controller=createUnboundUsagePreferenceController({storage,getContext:context,now});
      let result;
      if(request.method==='GET')result=await controller.read();
      else {
        if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json')return reject('json_required',415);
        const reader=request.body?.getReader();if(!reader)return reject('invalid_request',422);
        let data='',size=0,body;
        try {const decoder=new TextDecoder('utf-8',{fatal:true});for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>2048){await reader.cancel();return reject('body_too_large',413);}data+=decoder.decode(value,{stream:true});}data+=decoder.decode();body=JSON.parse(data);}catch{return reject('invalid_request',422);}
        if(!exact(body,['csrf','expected_revision','threshold_percent']))return reject('invalid_request',422);
        if(body.csrf!==initial.csrf)return reject('csrf_required',403);
        result=await controller.saveDraft({expected_revision:body.expected_revision,threshold_percent:body.threshold_percent});
      }
      return response({...result,csrf:initial.csrf});
    }catch(error){
      const known=error instanceof UsagePreferenceError&&/^[a-z_]{1,80}$/.test(error.code);
      return reject(known?error.code:'preference_unavailable',known?error.status:503);
    }
  };
}
