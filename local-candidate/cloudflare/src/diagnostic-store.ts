/** Private owner-DO ring. Caller owns its transaction and shared alarm schedule. */
import {sanitizeDiagnosticRecord} from './diagnostics.ts';
import {Rejected} from './contracts.ts';
import type {SQL} from './owner.ts';
export const DIAGNOSTIC_TTL_MS=72*60*60*1000;
export const DIAGNOSTIC_MAX_RECORDS=1000;
export const DIAGNOSTIC_PER_MINUTE=60;
export const DIAGNOSTIC_PER_DAY=2000;
export type DiagnosticQuery={source_id?:string;request_id?:string;before?:number;limit?:number};
export function validateDiagnosticQuery(value:unknown,sources:ReadonlySet<string>):Required<Pick<DiagnosticQuery,'limit'>>&DiagnosticQuery{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['source_id','request_id','before','limit'].includes(k)))throw new Rejected('invalid_diagnostic_query',400);
 const q=value as any;
 if(q.source_id!==undefined&&(typeof q.source_id!=='string'||!sources.has(q.source_id))||q.request_id!==undefined&&(typeof q.request_id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(q.request_id))||q.before!==undefined&&(!Number.isSafeInteger(q.before)||q.before<1)||q.limit!==undefined&&(!Number.isInteger(q.limit)||q.limit<1||q.limit>50))throw new Rejected('invalid_diagnostic_query',400);
 return {...q,limit:q.limit??20};
}
export class DiagnosticStore{
 sql:SQL;sources:ReadonlySet<string>;
 constructor(sql:SQL,sources:ReadonlySet<string>){this.sql=sql;this.sources=sources;sql.exec('CREATE TABLE IF NOT EXISTS diagnostics(id INTEGER PRIMARY KEY AUTOINCREMENT,request_id TEXT UNIQUE NOT NULL,observed_at REAL NOT NULL,source_id TEXT NOT NULL,record TEXT NOT NULL); CREATE INDEX IF NOT EXISTS diagnostics_at ON diagnostics(observed_at); CREATE TABLE IF NOT EXISTS diagnostic_budget(day INTEGER PRIMARY KEY,count INTEGER NOT NULL);');}
 rows(q:string,...args:any[]){return this.sql.exec(q,...args).toArray();}
 prune(now:number){this.rows('DELETE FROM diagnostics WHERE observed_at<=?',now-DIAGNOSTIC_TTL_MS);this.rows('DELETE FROM diagnostics WHERE id<=COALESCE((SELECT MAX(id)-? FROM diagnostics),0)',DIAGNOSTIC_MAX_RECORDS);this.rows('DELETE FROM diagnostic_budget WHERE day<?',Math.floor(now/86400000));}
 nextExpiry(){const at=this.rows('SELECT MIN(observed_at) AS at FROM diagnostics')[0]?.at;return typeof at==='number'?at+DIAGNOSTIC_TTL_MS:Infinity;}
 insert(input:unknown,now:number){
  const record=sanitizeDiagnosticRecord(input,this.sources);if(!record)return {stored:false,reason:'invalid_record'};
  if(!Number.isFinite(now))return {stored:false,reason:'clock_invalid'};
  this.prune(now);
  if(this.rows('SELECT id FROM diagnostics WHERE request_id=?',record.request_id).length)return {stored:false,reason:'duplicate'};
  if(this.rows('SELECT COUNT(*) AS n FROM diagnostics WHERE observed_at>?',now-60000)[0].n>=DIAGNOSTIC_PER_MINUTE)return {stored:false,reason:'rate_limited'};
  const day=Math.floor(now/86400000),count=this.rows('SELECT count FROM diagnostic_budget WHERE day=?',day)[0]?.count??0;
  if(count>=DIAGNOSTIC_PER_DAY)return {stored:false,reason:'daily_limited'};
  this.rows('INSERT INTO diagnostic_budget(day,count) VALUES(?,1) ON CONFLICT(day) DO UPDATE SET count=count+1',day);this.rows('DELETE FROM diagnostic_budget WHERE day<>?',day);
  this.rows('INSERT INTO diagnostics(request_id,observed_at,source_id,record) VALUES(?,?,?,?)',record.request_id,now,record.source,JSON.stringify(record));this.prune(now);
  return {stored:true,storage:'durable_sqlite'};
 }
 query(input:unknown,now:number){
  const q=validateDiagnosticQuery(input,this.sources);this.prune(now);
  const where=['observed_at>?'],args:any[]=[now-DIAGNOSTIC_TTL_MS];
  if(q.source_id!==undefined){where.push('source_id=?');args.push(q.source_id);}
  if(q.request_id!==undefined){where.push('request_id=?');args.push(q.request_id);}
  if(q.before!==undefined){where.push('id<?');args.push(q.before);}
  args.push(q.limit+1);const selected=this.rows('SELECT id,observed_at,record FROM diagnostics WHERE '+where.join(' AND ')+' ORDER BY id DESC LIMIT ?',...args);
  const rows=selected.slice(0,q.limit),records=rows.flatMap(r=>{let parsed;try{parsed=JSON.parse(r.record);}catch{return [];}const safe=sanitizeDiagnosticRecord(parsed,this.sources);return safe?[{sequence:r.id,observed_at:new Date(r.observed_at).toISOString(),...safe}]:[];});
  return {storage:'durable_sqlite',history_lost_on_restart:false,retention_scope:'normal_queries_and_active_ring',provider_recovery_history:'Cloudflare SQLite PITR may restore database history up to 30 days',records,next_before:selected.length>q.limit?rows[rows.length-1]?.id:null,retention_hours:72,max_records:DIAGNOSTIC_MAX_RECORDS,collection_limits:{per_minute:DIAGNOSTIC_PER_MINUTE,per_utc_day:DIAGNOSTIC_PER_DAY},absence_is_not_proof_of_no_request:true,read_excluded_from_diagnostics:true,scope:'this_owner_connection_diagnostics_only',historical_requests_before_enable:'not_available'};
 }
}
