import { sourceBrand } from './brand-identity.mjs';
import { dashboardText } from './dashboard-activity.mjs';
export const TASK_PICKER_VERSION='local-reported-catalog-v1';
const base='/dashboard/task-picker';
export const isTaskPickerPath=p=>[base,base+'/access',base+'/page',base+'/apply',base+'/cancel'].includes(p);
const random=()=>Array.from(crypto.getRandomValues(new Uint8Array(16)),n=>n.toString(16).padStart(2,'0')).join('');
const exact=(v,keys)=>v && typeof v==='object' && !Array.isArray(v) && Object.keys(v).sort().join(',')===keys.sort().join(',');
const same=(a,b)=>['project_id','task_id','run_id','branch_id'].every(k=>a[k]===b[k]);
const bytes=v=>new TextEncoder().encode(JSON.stringify(v)).length;
const validSession=(s,binding,now)=>s && s.binding===binding && s.expires>now();
export function configuredSelections(config) {
  return [{source:config.source,list:config.watchlist},...config.sources.map(source=>({source,list:config.additional[source.source_id]||[]}))];
}
export function selectionCount(config,session) {
  return configuredSelections(config).reduce((n,s)=>n+s.list.length,config.testReceipt?1:0)+(session.taskSelections||[]).length;
}
// Every dynamic read is revalidated against the current normal-sensitivity branch.
export async function dashboardDynamicSelections({session,config,readSelection,now}) {
  const result={};
  for(const entry of session.taskSelections||[]) {
    const source=[config.source,...config.sources].find(s=>s.source_id===entry.source_id);
    if(!source || entry.expires<=now() || typeof readSelection!=='function') throw Error('task_selection_unavailable');
    await readSelection(source,entry.query);
    (result[source.source_id]??=[]).push(entry.query);
  }
  return result;
}
export async function dashboardTaskPicker(request,{storage,sessionKey,binding,config,now,headers,readCatalog,readSelection,readTestReceipt}) {
  const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:headers()});
  const fail=(error,status=403)=>reply({error},status);
  const path=new URL(request.url).pathname,read=path===base;
  if(request.method!==(read?'GET':'POST'))return fail('method_not_allowed',405);
  let body;
  if(!read) {
    if(request.headers.get('content-type')?.split(';')[0]!=='application/json')return fail('json_required',415);
    let size=0,text='';const reader=request.body?.getReader();if(!reader)return fail('invalid_picker_request',422);
    try {const decoder=new TextDecoder('utf-8',{fatal:true});for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>4096){await reader.cancel();return fail('body_too_large',413);}text+=decoder.decode(value,{stream:true});}text+=decoder.decode();body=JSON.parse(text);}catch{return fail('invalid_picker_request',422);}
  }
  // Serialize session state so close/reopen/page/apply cannot overwrite each other or a revoked session.
  return storage.transaction(async tx=>{
    const session=await tx.get(sessionKey);
    if(!validSession(session,binding,now))return fail('dashboard_login_required',401);
    if(read)return reply({state:'access_required',csrf:session.csrf,scope:'local_reported_catalog',sources:[config.source,...config.sources].map(s=>({source_id:s.source_id,display_name:dashboardText(sourceBrand(s).name,120)})),expires_at:new Date(session.expires).toISOString(),selected_count:selectionCount(config,session),configured_selected_count:selectionCount(config,{}),limit:20});
    if(!body || body.csrf!==session.csrf)return fail('csrf_required');
    if(typeof body.request_id!=='string'||! /^[a-f0-9]{32}$/.test(body.request_id))return fail('invalid_picker_request',422);
    const source=[config.source,...config.sources].find(s=>s.source_id===body.source_id);
    if(!source)return fail('source_not_authorized');
    if(path===base+'/cancel') {
      if(!exact(body,['csrf','source_id','request_id']))return fail('invalid_picker_request',422);
      const cancelled=session.taskPickerCancelled||[];
      if(!cancelled.includes(body.request_id)) {
        if(cancelled.length>=64)return fail('task_picker_capacity',409);
        cancelled.push(body.request_id);
      }
      session.taskPickerCancelled=cancelled;
      if(session.taskPicker?.source_id===source.source_id && session.taskPicker.request_id===body.request_id)delete session.taskPicker;
      await tx.put(sessionKey,session);
      return reply({state:'cancelled'});
    }
    let cap=session.taskPicker;
    if(path===base+'/access') {
      if(!exact(body,['csrf','source_id','request_id','confirm'])||body.confirm!==true)return fail('explicit_access_required');
      if((session.taskPickerCancelled||[]).includes(body.request_id))return fail('task_picker_cancelled',409);
      if((session.taskPickerCancelled||[]).length>=64)return fail('task_picker_capacity',409);
      if(session.taskPicker?.request_id===body.request_id)return fail('task_picker_already_open',409);
      cap={id:random(),request_id:body.request_id,binding,source_id:source.source_id,expires:session.expires,scanned:0,after:'',cursor:null,refs:[]};
    } else if(!cap || cap.binding!==binding || cap.expires<=now() || cap.source_id!==source.source_id || cap.request_id!==body.request_id) return fail('task_picker_access_required');
    if(path===base+'/access') {
      for(const selected of session.taskSelections||[]) if(selected.source_id===source.source_id) {
        let unavailable=false;
        try{await readSelection(source,selected.query);}catch{unavailable=true;}
        // Existing selection authority is retained, not silently evicted; no stale metadata is disclosed.
        cap.refs.push({ref:random(),query:selected.query,...unavailable?{unavailable:true}:{}});
      }
    }
    const configured=configuredSelections(config).find(s=>s.source.source_id===source.source_id).list.slice();
    if(config.testReceipt && source.source_id===config.source.source_id) {
      try{const query=await readTestReceipt(source,config.testReceipt);if(!query)throw Error();configured.push(query);}catch{return fail('dashboard_receipt_unavailable',503);}
    }
    if(path===base+'/apply') {
      if(!exact(body,['csrf','source_id','request_id','refs'])||!Array.isArray(body.refs)||body.refs.length>20||new Set(body.refs).size!==body.refs.length||body.refs.some(r=>typeof r!=='string'||!/^[a-f0-9]{32}$/.test(r)))return fail('invalid_picker_request',422);
      const chosen=[];
      for(const ref of body.refs) {
        const issued=cap.refs.find(r=>r.ref===ref);if(!issued)return fail('selection_not_issued');
        try{await readSelection(source,issued.query);}catch{return fail('task_selection_unavailable',409);}
        if(!configured.some(q=>same(q,issued.query))) chosen.push({source_id:source.source_id,query:issued.query,expires:cap.expires});
      }
      const next={...session,taskSelections:[...(session.taskSelections||[]).filter(s=>s.source_id!==source.source_id),...chosen]};
      if(selectionCount(config,next)>20)return fail('task_selection_limit',409);
      delete next.taskPicker;
      if(bytes(next)>96*1024)return fail('task_picker_capacity',409);
      if(!validSession(session,binding,now))return fail('dashboard_login_required',401);
      await tx.put(sessionKey,next);return reply({state:'applied',selected_count:selectionCount(config,next),limit:20});
    }
    if(path===base+'/page' && (!exact(body,['csrf','source_id','request_id','cursor'])||!cap.cursor||body.cursor!==cap.cursor))return fail('invalid_picker_cursor');
    if(!['/access','/page'].some(s=>path===base+s))return fail('not_found',404);
    if(cap.scanned>=250)return fail('task_picker_scan_limit',409);
    let page;try{page=await readCatalog(source,cap.after);}catch{return fail('task_catalog_unavailable',503);}
    if(!page || !Array.isArray(page.rows) || page.rows.length>25 || typeof page.has_more!=='boolean')return fail('task_catalog_unavailable',503);
    const nextCap=structuredClone(cap),items=[];
    for(const row of page.rows) {
      nextCap.scanned++;nextCap.after=row.key;
      if(!row.value)continue; // Never reveal restricted row counts or metadata.
      const {query,item}=row.value;
      let issued=nextCap.refs.find(r=>same(r.query,query));
      if(!issued){issued={ref:random(),query};nextCap.refs.push(issued);}
      const locked=configured.some(q=>same(q,query));
      items.push({...item,ref:issued.ref,configured:locked,selected:locked||(session.taskSelections||[]).some(s=>s.source_id===source.source_id&&same(s.query,query))});
    }
    nextCap.cursor=page.has_more && nextCap.scanned<250?random():null;
    // Do not evict issued references or selections. A too-large page fails without mutating authorization.
    if(nextCap.refs.length>250 || bytes(nextCap)>64*1024)return fail('task_picker_capacity',409);
    const next={...session,taskPicker:nextCap};if(bytes(next)>96*1024)return fail('task_picker_capacity',409);
    if(!validSession(session,binding,now))return fail('dashboard_login_required',401);
    await tx.put(sessionKey,next);
    return reply({state:'catalog',csrf:session.csrf,source_id:source.source_id,items,unavailable_selected_refs:nextCap.refs.filter(r=>r.unavailable).map(r=>r.ref),selected_refs:nextCap.refs.filter(r=>(session.taskSelections||[]).some(s=>s.source_id===source.source_id&&same(s.query,r.query))).map(r=>r.ref),next_cursor:nextCap.cursor,selected_count:selectionCount(config,session),limit:20,scan_limit_reached:page.has_more&&nextCap.scanned>=250,expires_at:new Date(cap.expires).toISOString()});
  });
}
