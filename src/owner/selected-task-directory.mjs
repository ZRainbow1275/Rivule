/** Presentation-only query over the selected snapshot supplied by the caller. */
export function selectedTaskDirectory(sources,query='',filter='all'){
  const norm=v=>typeof v==='string'?v.normalize('NFKC').toLowerCase():'';
  const terms=norm(String(query||'').slice(0,120)).trim().split(/\s+/).filter(Boolean);
  const rows=[];let readable=0,partial=false;
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
      const fields=[name,item.task_name,item.project_name,item.branch_name].map(norm);
      if(!terms.every(term=>fields.some(field=>field.includes(term))))continue;
      rows.push({item,name,source_id:source.source_id,peers});
    }
  }
  return {rows,readable,partial};
}
