/** Presentation-only query over the selected snapshot supplied by the caller. */
export function selectedTaskDirectory(sources,query='',filter='all',order='recent'){
  const norm=v=>typeof v==='string'?v.normalize('NFKC').toLowerCase():'';
  const terms=norm(String(query||'').slice(0,120)).trim().split(/\s+/).filter(Boolean);
  const rows=[];let readable=0,partial=false;
  const kinds=new Set(['registered','started','progress','needs_input','completed','failed','cancelled','correction']);
  const time=value=>typeof value==='string' && /^\d{4}-\d{2}-\d{2}T/.test(value)?Date.parse(value):NaN;
  function latest(item,sourceId){
    let best=null;
    const offer=(type,kind,text,at)=>{
      const ms=time(at);if(Number.isFinite(ms)&&(!best||ms>best.ms))best={type,kind,text,at,ms};
    };
    // The two logs represent distinct evidence. Receipt time is comparable
    // across sources; page reads, source heartbeats and delivery are not work.
    if(item.activity?.state==='available'&&Array.isArray(item.activity.items)){
      for(const e of item.activity.items.slice(0,30))if(e&&e.projection_applied===true&&kinds.has(e.kind)){
        offer('event',e.kind,typeof e.summary==='string'?e.summary:'',e.received_at);
      }
    }
    if(item.replies?.state==='available'&&Array.isArray(item.replies.items)){
      for(const r of item.replies.items.slice(0,30))if(r&&r.source_id===sourceId&&typeof r.text==='string'&&r.text.trim()){
        offer('reply',null,r.text,r.accepted_at);
      }
    }
    return best||{type:'snapshot',kind:null,text:typeof item.summary==='string'?item.summary:'',at:null,ms:null};
  }
  for(const source of Array.isArray(sources)?sources:[]){
    if(!source||!Array.isArray(source.items)){partial=true;continue;}
    const name=source.display_name||source.source_id||'来源';
    if(['error','unconfigured'].includes(source.state)||(!source.items.length && !['connected','ready'].includes(source.state)))partial=true;
    const peers=source.items.filter(item=>item && item.state==='available');
    for(const item of source.items){
      if(!item || item.state!=='available'){partial=true;continue;}
      readable++;
      const fresh=item.stale!==true && item.archived!==true;
      if(filter==='waiting' && !(fresh && (item.source_status==='needs_input'||(Number.isSafeInteger(item.pending_action_count)&&item.pending_action_count>0))))continue;
      if(['running','completed'].includes(filter) && item.source_status!==filter)continue;
      const update=latest(item,source.source_id);
      const fields=[name,source.source_id,item.task_name,item.project_name,item.branch_name,update.text].map(norm);
      if(!terms.every(term=>fields.some(field=>field.includes(term))))continue;
      rows.push({item,name,source_id:source.source_id,peers,update});
    }
  }
  if(order!=='source')rows.sort((a,b)=>{
    const x=a.update.ms,y=b.update.ms;
    return x===y?0:x===null?1:y===null?-1:y-x;
  });
  return {rows,readable,partial};
}
