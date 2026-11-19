import {selectedRelationPeers} from './selected-relation-peers.mjs';
/** Group only the visible direct-task command statuses projected to the workbench. */
export function selectedCommandFollowup(sources,query='',stage='all',channel='all'){
  const normalize=v=>typeof v==='string'?v.normalize('NFKC').toLowerCase():'';
  const terms=normalize(String(query||'').slice(0,120)).trim().split(/\s+/).filter(Boolean);
  const states=new Set(['pending','claimed','completed','rejected','unknown','expired']);
  const matchStage=s=>stage==='all'||(stage==='reported'?s==='completed'||s==='rejected':stage==='review'?s==='rejected'||s==='unknown'||s==='expired':s===stage);
  const rows=[];let records=0,partial=false,truncated=false;
  for(const source of Array.isArray(sources)?sources:[]){
    if(!source||!Array.isArray(source.items)){partial=true;continue;}
    if(['error','unconfigured'].includes(source.state)||(!source.items.length&&!['connected','ready'].includes(source.state)))partial=true;
    const peers=selectedRelationPeers(source),name=source.display_name||source.source_id||'来源';
    for(const item of source.items){
      if(item?.state!=='available'){partial=true;continue;}
      const log=item.commands;
      if(log?.state!=='available'||!Array.isArray(log.items)){partial=true;continue;}
      if(log.truncated||log.items.length>30)truncated=true;
      const fields=[name,source.source_id,item.task_name,item.project_name,item.branch_name].map(normalize);
      if(!terms.every(t=>fields.some(f=>f.includes(t))))continue;
      const matches=[];
      for(const c of log.items.slice(0,30)){
        if(!c||!states.has(c.state)||typeof c.created_at!=='string'||!/^\d{4}-\d{2}-\d{2}T/.test(c.created_at)){partial=true;continue;}
        const ms=Date.parse(c.created_at);if(!Number.isFinite(ms)){partial=true;continue;}
        const ch=['discord','qq','dashboard'].includes(c.channel)?c.channel:'unknown';
        if((channel==='all'||ch===channel)&&matchStage(c.state))matches.push({state:c.state,channel:ch,created_at:c.created_at,ms});
      }
      if(matches.length){matches.sort((a,b)=>b.ms-a.ms);records+=matches.length;rows.push({name,source_id:source.source_id,item,peers,records:matches});}
    }
  }
  rows.sort((a,b)=>b.records[0].ms-a.records[0].ms);
  return {rows,records,partial,truncated};
}
