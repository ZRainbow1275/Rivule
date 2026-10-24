import { dashboardText } from './dashboard-activity.mjs';
// This adapter is called only after an explicit, source-specific owner-session opt-in.
// Never initialize the owner core, queues, alarms or any upstream connection here.
const fields = ['project_id','task_id','run_id','branch_id'];
const id = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(v);
const statuses = new Set(['proposed','running','needs_input','completed','failed','cancelled']);
const fail = () => { throw Error('task_catalog_unavailable'); };
function reader(storage, bindings, source) {
  const current=bindings.sources.find(s=>s.source_id===source?.source_id);
  if(!current?.enabled || JSON.stringify(current)!==JSON.stringify(source) || !id(source.source_id) ||
    !Array.isArray(bindings.allowedProjectIds) || !bindings.allowedProjectIds.length || bindings.allowedProjectIds.length>3 || new Set(bindings.allowedProjectIds).size!==bindings.allowedProjectIds.length || bindings.allowedProjectIds.some(p=>!id(p)) ||
    [bindings.ownerId,bindings.appId,bindings.userId,bindings.dmId].some(v=>typeof v!=='string'||!v)) fail();
  const rows=(sql,...args)=>storage.sql.exec(sql,...args).toArray();
  const tables=new Set(rows("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('meta','branches')").map(r=>r.name));
  const identity=tables.has('meta') && rows("SELECT value FROM meta WHERE key='identity'")[0];
  if(!identity || identity.value!==JSON.stringify([bindings.ownerId,bindings.appId,bindings.userId,bindings.dmId]) || !tables.has('branches')) fail();
  return rows;
}
function validate(row,bindings,source,now) {
  let p;try{p=JSON.parse(row.payload);}catch{fail();}
  if(!p || row.source_id!==source.source_id || p.source_id!==source.source_id || fields.some(k=>!id(p[k])) ||
    row.project_id!==p.project_id || !bindings.allowedProjectIds.includes(row.project_id) ||
    row.branch_key!==JSON.stringify([source.source_id,p.task_id,p.run_id,p.branch_id]) ||
    !statuses.has(p.source_status) || !['normal','restricted','secret'].includes(p.sensitivity) ||
    !Number.isSafeInteger(row.revision) || row.revision<1 || !Number.isSafeInteger(row.state_version) || row.state_version<1 ||
    !Number.isFinite(row.last_confirmed) || row.last_confirmed<0 || row.last_confirmed>now+300000 ||
    ![0,1].includes(row.archived) || !Number.isFinite(Date.parse(p.occurred_at)) ||
    row.seq!==p.source_seq || row.seq!==null && (!Number.isSafeInteger(row.seq)||row.seq<0)) fail();
  if(p.sensitivity!=='normal') return null;
  return {query:Object.fromEntries(fields.map(k=>[k,p[k]])),item:{project_name:dashboardText(p.project_name,120),task_name:dashboardText(p.task_name,120),branch_name:dashboardText(p.branch_name,80),source_status:p.source_status,last_confirmed_at:new Date(row.last_confirmed).toISOString(),stale:now-row.last_confirmed>1800000,archived:row.archived===1}};
}
const columns='branch_key,source_id,project_id,payload,seq,state_version,revision,last_confirmed,archived';
export function readDashboardCatalog(storage,bindings,source,after='',now=Date.now()) {
  if(typeof after!=='string' || after.length>420) fail();
  const rows=reader(storage,bindings,source);
  // SQL applies the existing project allowlist, not browser-supplied selectors. Each read is 25 + sentinel.
  const selected=rows(`SELECT ${columns} FROM branches WHERE source_id=? AND project_id IN (${bindings.allowedProjectIds.map(()=>'?').join(',')}) AND branch_key>? ORDER BY branch_key ASC LIMIT 26`,source.source_id,...bindings.allowedProjectIds,after);
  if(selected.length>26) fail();
  let previous=after;const items=[];
  for(const row of selected) {
    if(typeof row.branch_key!=='string' || row.branch_key<=previous) fail();
    previous=row.branch_key;
    const checked=validate(row,bindings,source,now);
    if(items.length<25) items.push({key:row.branch_key,value:checked});
  }
  return {rows:items,has_more:selected.length>25};
}
export function readDashboardCatalogSelection(storage,bindings,source,query,now=Date.now()) {
  if(!query || Object.keys(query).length!==4 || fields.some(k=>!id(query[k])) || !bindings.allowedProjectIds.includes(query.project_id)) fail();
  const rows=reader(storage,bindings,source),key=JSON.stringify([source.source_id,query.task_id,query.run_id,query.branch_id]);
  const found=rows(`SELECT ${columns} FROM branches WHERE branch_key=? AND source_id=? AND project_id=?`,key,source.source_id,query.project_id);
  if(found.length!==1) fail();
  const checked=validate(found[0],bindings,source,now);
  if(!checked || fields.some(k=>checked.query[k]!==query[k])) fail();
  return checked;
}
