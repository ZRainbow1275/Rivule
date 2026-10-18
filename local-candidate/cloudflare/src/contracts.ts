import type {SourceProvider} from './source-registry.ts';
/** Strict event contract port. No tokens, destinations, or approvals in tool data. */
export class Rejected extends Error {
  code: string; status: number;
  constructor(code: string, status=422) {super(code);this.code=code;this.status=status;}
}
export type SourceAuthMethod='oauth'|'hmac'|'api_key';
export type Source = {source_id:string;provider:SourceProvider;display_name:string;enabled:boolean;allowed_hosts:string[];secret_name:string;auth_methods?:SourceAuthMethod[]};
// Existing configurations retain their OAuth/HMAC routes. New API-key sources
// must opt in explicitly; enabling one adapter never enables another transport.
export const sourceAllows=(source:Source,method:SourceAuthMethod)=>(source.auth_methods??['oauth','hmac']).includes(method);
export type Event = Record<string, any> & {event_id:string;source_id:string;project_id:string;task_id:string;run_id:string;branch_id:string;kind:string;source_status:string;occurred_at:string;source_seq:number|null};
const idPattern=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/;
export const terminal=new Set(['completed','failed','cancelled']);
const kindStatus:Record<string,string>={registered:'proposed',started:'running',needs_input:'needs_input',completed:'completed',failed:'failed',cancelled:'cancelled'};
const kinds=new Set([...Object.keys(kindStatus),'progress','heartbeat','correction']);
const statuses=new Set(['proposed','running','needs_input',...terminal]);
function object(v:any):Record<string,any> {if(v===null||typeof v!=='object'||Array.isArray(v))throw new Rejected('invalid_contract');return v;}
function keys(v:Record<string,any>,allowed:string[]) {if(Object.keys(v).some(k=>!allowed.includes(k)))throw new Rejected('unknown_field');}
export function identifier(v:any):string {if(typeof v!=='string'||!idPattern.test(v))throw new Rejected('invalid_id');return v;}
export function text(v:any,max:number,min=0):string {
 if(typeof v!=='string'||[...v].length<min||[...v].length>max)throw new Rejected('invalid_text');
 for(const c of v){const n=c.codePointAt(0)!;if((n<32&&n!==9&&n!==10)||(n>=0xd800&&n<=0xdfff)||/[\u202a-\u202e\u2066-\u2069]/.test(c))throw new Rejected('invalid_text');}
 return v;
}
export function timestamp(v:any):string {
 if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/.test(v)||!Number.isFinite(Date.parse(v)))throw new Rejected('invalid_time');
 // Reject JavaScript's rollover of calendar dates (e.g. February 30).
 const year=+v.slice(0,4),month=+v.slice(5,7),day=+v.slice(8,10);
 const leap=year%4===0&&(year%100!==0||year%400===0);
 const max=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31][month-1];
 if(month<1||month>12||day<1||day>max||+v.slice(11,13)>23||+v.slice(14,16)>59||+v.slice(17,19)>59)throw new Rejected('invalid_time');
 return new Date(v).toISOString();
}
export function safeUrl(v:any):string|null {
 if(v===null||v===undefined)return null;
 if(typeof v!=='string'||v.length>1600||/[\s\\]/.test(v))throw new Rejected('invalid_link');
 let u:URL;try{u=new URL(v);}catch{throw new Rejected('invalid_link');}
 if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||(u.port&&u.port!=='443')||!u.hostname.includes('.')||u.hostname.includes(':')||/^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)||/\.(local|localhost|internal)$/.test(u.hostname))throw new Rejected('invalid_link');
 return v;
}
export function validateEvent(raw:any,source:Source,now:number):Event {
 const v=object(raw);keys(v,['schema_version','event_id','source_id','project_id','task_id','run_id','branch_id','project_name','task_name','branch_name','kind','source_status','source_seq','occurred_at','summary','phase_id','phase_label','progress','blocker','action','source_url','sensitivity','correction_of']);
 if(v.schema_version!==undefined&&v.schema_version!=='1.0')throw new Rejected('invalid_version');
 const e:Event={schema_version:'1.0',event_id:identifier(v.event_id),source_id:identifier(v.source_id),project_id:identifier(v.project_id),task_id:identifier(v.task_id),run_id:identifier(v.run_id),branch_id:identifier(v.branch_id??'main'),
 project_name:text(v.project_name,120,1),task_name:text(v.task_name,120,1),branch_name:text(v.branch_name??'主路线',80,1),kind:v.kind,source_status:v.source_status,source_seq:v.source_seq??null,occurred_at:timestamp(v.occurred_at),summary:text(v.summary??'',1200),phase_id:v.phase_id??null,phase_label:v.phase_label??null,progress:null,blocker:v.blocker??null,action:null,source_url:safeUrl(v.source_url),sensitivity:v.sensitivity??'normal',correction_of:v.correction_of??null};
 if(e.source_id!==source.source_id||!source.enabled)throw new Rejected('source_not_authorized',403);
 if(!kinds.has(e.kind)||!statuses.has(e.source_status)||(kindStatus[e.kind]&&kindStatus[e.kind]!==e.source_status))throw new Rejected('invalid_state');
 if(e.source_seq!==null&&(!Number.isSafeInteger(e.source_seq)||e.source_seq<0))throw new Rejected('invalid_sequence');
 if(Date.parse(e.occurred_at)>now+300000)throw new Rejected('future_timestamp',409);
 if((e.phase_id===null)!==(e.phase_label===null))throw new Rejected('invalid_phase');
 if(e.phase_id!==null){identifier(e.phase_id);text(e.phase_label,100,1);}
 if(e.blocker!==null)text(e.blocker,400);
 if(!['normal','restricted','secret'].includes(e.sensitivity))throw new Rejected('invalid_sensitivity');
 if(e.sensitivity==='secret')throw new Rejected('secret_content_not_authorized',403);
 if(e.source_url&&!source.allowed_hosts.includes(new URL(e.source_url).hostname))throw new Rejected('source_link_not_authorized',403);
 if(e.kind==='progress'&&terminal.has(e.source_status))throw new Rejected('invalid_terminal_kind');
 if(e.kind==='correction'){identifier(e.correction_of);}else if(e.correction_of!==null)throw new Rejected('invalid_correction');
 if(v.progress!==null&&v.progress!==undefined){const p=object(v.progress);keys(p,['done','total','unit']);const total=p.total??null;
  if(typeof p.done!=='number'||!Number.isFinite(p.done)||p.done<0||(total!==null&&(typeof total!=='number'||!Number.isFinite(total)||total<=0||p.done>total)))throw new Rejected('invalid_progress');
  e.progress={done:p.done,total,unit:text(p.unit,40,1)};
 }
 if(v.action!==null&&v.action!==undefined){const a=object(v.action);keys(a,['request_id','question','impact','expires_at','mode']);
  if((a.mode??'return_to_source')!=='return_to_source')throw new Rejected('upstream_approval_not_supported');
  e.action={request_id:identifier(a.request_id),question:text(a.question,400,1),impact:text(a.impact??'未提供',300),expires_at:a.expires_at==null?null:timestamp(a.expires_at),mode:'return_to_source'};
 }
 if((e.source_status==='needs_input')!==(e.action!==null))throw new Rejected('invalid_action_state');
 return e;
}
export function projection(e:Event):Event {
 const p=structuredClone(e);
 if(p.sensitivity==='restricted'){
  Object.assign(p,{project_name:'受限项目',task_name:'受限任务',branch_name:'受限路线',summary:'有更新，请回原平台查看',blocker:null,progress:null});
  if(p.phase_label)p.phase_label='请回原平台查看';
  if(p.action)Object.assign(p.action,{question:'有事项需要你决定，请回原平台查看',impact:'请在原平台查看影响'});
 }return p;
}
export function canonical(v:any):string {
 if(v===null||typeof v!=='object')return JSON.stringify(v);
 if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';
 return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
}
export async function digest(v:string):Promise<string>{return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(v)))].map(x=>x.toString(16).padStart(2,'0')).join('');}
export function branchKey(e:Event):string{return canonical([e.source_id,e.task_id,e.run_id,e.branch_id]);}
