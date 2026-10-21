import {Problem,demand,taskSchema,type NewTask,type Task} from './core';
const columns=['id','title','operation','source_id','dependencies','input','arguments','branch_id'];
export function parseCsv(text:string):string[][] {
  demand(text.length<=262144,413,'csv_too_large','CSV 最大 256 KiB');
  const rows:string[][]=[];let row:string[]=[];let cell='';let quoted=false;let afterQuote=false;
  for(let i=0;i<text.length;i++) {
    const c=text[i]!;
    if(quoted) {if(c==='"') {if(text[i+1]==='"') {cell+='"';i++;}else {quoted=false;afterQuote=true;}}else cell+=c;continue;}
    if(c===',' || c==='\n' || c==='\r') {
      row.push(cell);cell='';afterQuote=false;
      if(c!==',') {rows.push(row);row=[];if(c==='\r' && text[i+1]==='\n')i++;}continue;
    }
    demand(!afterQuote,400,'invalid_csv','CSV 引号结束后出现了额外字符');
    if(c==='"') {demand(cell==='',400,'invalid_csv','CSV 引号必须位于字段起始');quoted=true;}else cell+=c;
  }
  demand(!quoted,400,'invalid_csv','CSV 引号未闭合');if(cell!==''||row.length||afterQuote) {row.push(cell);rows.push(row);}
  if(rows[0]?.[0])rows[0][0]=rows[0][0]!.replace(/^\uFEFF/,'');
  return rows;
}
function safe(value:string):string {return /^[\s]*[=+\-@]/.test(value)||value.startsWith("'")?"'"+value:value;}
function original(value:string):string {return value.startsWith("'")?value.slice(1):value;}
export function exportCsv(tasks:Task[]):string {
  const rows=[columns,...tasks.map(t=>[t.id,t.title,t.operation,t.sourceId,t.dependencies.join(';'),t.input,JSON.stringify(t.arguments),t.branchId])];
  return rows.map((row,i)=>row.map(c=>'"'+(i?safe(c):c).replaceAll('"','""')+'"').join(',')).join('\r\n')+'\r\n';
}
export function importCsv(text:string):{inputs:NewTask[]; ids:string[]} {
  const [header,...rows]=parseCsv(text);demand(header?.join(',')===columns.join(','),400,'csv_columns',`CSV 表头必须为 ${columns.join(',')}`);
  demand(rows.length>0 && rows.length<=100,400,'csv_rows','一次导入 1–100 个任务');
  const ids=rows.map(()=>crypto.randomUUID());const mapping=new Map<string,string>();
  rows.forEach((row,i)=>{demand(row.length===columns.length,400,'csv_columns',`第 ${i+2} 行列数不符`);const id=original(row[0]!);demand(id&&!mapping.has(id),400,'csv_duplicate','CSV 原任务 ID 为空或重复');mapping.set(id,ids[i]!);});
  const inputs=rows.map((row,i)=>{
    const [,title,operation,sourceId,deps,input,args,branchId]=row.map(original);let parsed:unknown;
    try {parsed=JSON.parse(args!);}catch {throw new Problem(400,'invalid_csv',`第 ${i+2} 行 arguments 不是 JSON`);}
    return taskSchema.parse({title,operation,sourceId,input,arguments:parsed,branchId,dependencies:deps?deps.split(';').map(d=>mapping.get(d)||d):[]});
  });return {inputs,ids};
}
