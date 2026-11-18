/**
 * Read a task's already-projected questions, not raw actions. A stored count
 * describes pending records; passing a reported deadline is not a decision.
 * For equal or absent upcoming deadlines preserve the source's order.
 */
export function selectedDecisionBrief(item) {
  if (item?.state !== 'available' || item.stale !== false || item.archived !== false) return null;
  const total=item.pending_action_count;
  if ((!Number.isSafeInteger(total) || total<1) && item.source_status!=='needs_input') return null;
  const out={state:'unavailable',total:Number.isSafeInteger(total)&&total>=0?total:null,questions:[],partial:true,nextMs:null};
  if (total===0) return {...out,state:'status_only',partial:false};
  const log=item.pending_questions;
  if (out.total===null || log?.state!=='available' || !Array.isArray(log.items) ||
      typeof log.truncated!=='boolean' || !Number.isSafeInteger(log.withheld_count) || log.withheld_count<0 ||
      log.items.length+log.withheld_count>Math.min(20,total)) return out;
  const keys=['question','impact','expires_at','expiry_elapsed'];
  out.partial=log.truncated || log.withheld_count>0 || log.items.length<total;
  for (const entry of log.items) {
    if (!entry || typeof entry!=='object' || Array.isArray(entry) || Object.keys(entry).length!==keys.length ||
        !keys.every(k=>Object.hasOwn(entry,k)) || typeof entry.question!=='string' || !entry.question.trim() ||
        entry.question.length>800 || typeof entry.impact!=='string' || entry.impact.length>600 ||
        typeof entry.expiry_elapsed!=='boolean') {out.partial=true;continue;}
    const raw=entry.expires_at,hasDate=raw!==null;
    if ((hasDate && (typeof raw!=='string' || !/^\d{4}-\d\d-\d\dT.+(?:Z|[+-]\d\d:\d\d)$/.test(raw))) ||
        (raw===null && entry.expiry_elapsed)) {out.partial=true;continue;}
    const ms=hasDate?Date.parse(raw):null;
    if (hasDate && !Number.isFinite(ms)) {out.partial=true;continue;}
    const atRead=typeof item.observed_at==='string'?Date.parse(item.observed_at):NaN;
    if (hasDate && Number.isFinite(atRead) && (ms<=atRead)!==entry.expiry_elapsed) {out.partial=true;continue;}
    out.questions.push({question:entry.question,impact:entry.impact,expiresAt:hasDate?new Date(ms).toISOString():null,elapsed:entry.expiry_elapsed,nextMs:hasDate&&!entry.expiry_elapsed?ms:null});
  }
  out.questions.sort((a,b)=>a.nextMs===null?(b.nextMs===null?0:1):b.nextMs===null?-1:a.nextMs-b.nextMs);
  if (out.questions.length) {out.state='readable';out.nextMs=out.questions[0].nextMs;}
  return out;
}
