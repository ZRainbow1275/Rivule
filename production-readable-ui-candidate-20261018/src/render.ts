/** Bounded, deterministic mobile topology. Equal-width bands encode ancestry,
 * never estimated effort, completion percentages, or a live connection claim.
 * Production has no filesystem, network, browser, canvas, or native addon use.
 */
import {displayBranch,displayCounts,expiryElapsed} from './display-model.ts';
import type {DisplayContext,RequestEvidence,DisplayBranch} from './display-model.ts';
export {statusVisual} from './status-style.ts';
import {sourceIcon,MUSE_ICON_DATA} from './source-icons.ts';
import {initWasm,Resvg} from '@resvg/resvg-wasm';
import coverage from '../assets/fonts/coverage.json' with {type:'json'};

export const PAGE_SIZE=3;
export const STATUS_LABELS:Record<string,string>={proposed:'待开始',running:'进行中',needs_input:'等待输入',completed:'已完成',failed:'失败',cancelled:'已取消'};
const COLORS:Record<string,string>={dot:'#D57A42',spark:'#626BC5',muse:'#438DB3'};
const ORDER:Record<string,number>={dot:0,spark:1,muse:2};
const FONT='Noto Sans CJK SC';
export type SourceView={source_id:string;display_name?:string;provider?:string;enabled?:boolean;last_seen?:number|string|null;connection_status?:string;verification_status?:string;visible?:boolean;selectable?:boolean};
export type PhaseView={phase_id?:string|null;node_id?:string;label?:string;event_id?:string;occurred_at?:string;summary?:string};
export type BranchView=Record<string,any> & {source_id:string;project_id:string;task_id:string;run_id:string;branch_id:string;source_status:string};
export type Selection={source_id?:string|null;branch_key?:string|null;selected_node_id?:string|null;page?:number};
export type Snapshot={branches:BranchView[];sources?:SourceView[];selection?:Selection;rendered_at?:string;test_only?:boolean;revision?:number;utc_offset_minutes?:number;requests?:RequestEvidence[]};
export type Graph={svg:string;width:390;height:number;page:number;pages:number;rows:BranchView[];nodes:(PhaseView&{branch_key:string})[];sources:SourceView[];rendered_at:string;revision:number;missingGlyphs:number;total:number;views:DisplayBranch[];counts:ReturnType<typeof displayCounts>;context:DisplayContext};
export type PngRenderer=(graph:Graph,scale?:1|2)=>Promise<Uint8Array>;

export function cleanText(value:unknown,max=2000):string {
 const s=typeof value==='string'?value:'';
 // Cap before transformations; avoid attacker-controlled regex work or allocation.
 return [...s.slice(0,max*2)].slice(0,max).join('').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,' ').replace(/[\ud800-\udfff]/gu,'�');
}
export function xmlEscape(value:unknown):string {return cleanText(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');}
export function fitText(value:unknown,units:number):string {
 const s=cleanText(value),points=[...s];let used=0,out='';
 for(let i=0;i<points.length;i++){const c=points[i],weight=c.codePointAt(0)!<0x2e80?.57:1;if(used+weight>units){return out+'…';}used+=weight;out+=c;}return out;
}
export function routeKey(branch:BranchView):string{return typeof branch.branch_key==='string'?branch.branch_key:JSON.stringify([branch.source_id,branch.task_id,branch.run_id,branch.branch_id]);}
export function displayTime(value:unknown):string {const time=typeof value==='number'?value:typeof value==='string'?Date.parse(value):NaN;return Number.isFinite(time)?new Date(time).toISOString().replace('T',' ').slice(0,19)+' UTC':'时间未提供';}
export function compactTime(value:unknown,offset=0):string {
 const time=typeof value==='number'?value:typeof value==='string'?Date.parse(value):NaN;
 const minutes=Number.isInteger(offset)&&Math.abs(offset)<=840?offset:0;
 if(!Number.isFinite(time))return '时间未提供';
 const sign=minutes<0?'-':'+';const hours=Math.floor(Math.abs(minutes)/60),remainder=Math.abs(minutes)%60;
 const zone=minutes===0?'UTC':`UTC${sign}${hours}${remainder?':'+String(remainder).padStart(2,'0'):''}`;
 return new Date(time+minutes*60000).toISOString().replace('T',' ').slice(5,16)+' '+zone;
}
export function requestExpired(branch:BranchView,asOf?:string):boolean {return expiryElapsed(branch,asOf??'');}
export function stateLabel(branch:BranchView,asOf?:string):string {return displayBranch(branch,{rendered_at:asOf??new Date().toISOString()}).state.label;}
export function progressLabel(branch:BranchView):string {return displayBranch(branch,{rendered_at:''}).progress;}
export function attentionLabel(branch:BranchView,asOf?:string):string {const v=displayBranch(branch,{rendered_at:asOf??''});return v.blocker?'阻塞：'+v.blocker:v.warning||v.summary;}
export function sourceLabel(source:SourceView):string {
 if(source.enabled===false||source.connection_status==='disabled')return '来源已停用';
 if(source.connection_status==='revoked')return '接入已撤销';
 if(source.connection_status==='disconnected')return '来源失联';
 if(source.connection_status==='stale')return '来源久未更新';
 if(source.verification_status&&source.verification_status!=='verified')return '待重新验证';
 return '当前在线状态未知';
}
export function glyphSupported(cp:number):boolean {let low=0,high=coverage.length-1;while(low<=high){const m=(low+high)>>1;const [a,b]=coverage[m];if(cp<a)high=m-1;else if(cp>b)low=m+1;else return true;}return false;}
function phases(branch:BranchView,selected?:string|null):PhaseView[]{
 if(branch.nodes!==undefined&&(!Array.isArray(branch.nodes)||branch.nodes.length>128))throw new Error('render_nodes_limit');
 const all:PhaseView[]=(branch.nodes??[]).filter((n:any)=>n&&typeof n==='object');
 const chosen=selected?all.find(n=>n.node_id===selected||n.phase_id===selected):undefined;
 const last=all.slice(-3);return chosen&&!last.includes(chosen)?[chosen,...all.slice(-2)]:last;
}
/** Page size/order stays identical to the production native selector. */
export function renderOverview(snapshot:Snapshot):Graph {
 if(!snapshot||!Array.isArray(snapshot.branches)||snapshot.branches.length>1000)throw new Error('render_branches_limit');
 if(snapshot.sources!==undefined&&(!Array.isArray(snapshot.sources)||snapshot.sources.length>100))throw new Error('render_sources_limit');
 const selection=snapshot.selection??{},sources=snapshot.sources??[],sourceMap=new Map(sources.map(s=>[s.source_id,s]));
 for(const b of snapshot.branches){if(!b||typeof b!=='object')throw new Error('render_branch_invalid');if(!sourceMap.has(b.source_id))sourceMap.set(b.source_id,{source_id:b.source_id,display_name:b.source_id});}
 const compare=(a:unknown,b:unknown)=>{const x=cleanText(a,120),y=cleanText(b,120);return x<y?-1:x>y?1:0;};
 const filtered=snapshot.branches.filter(b=>!b.archived&&(!selection.source_id||selection.source_id===b.source_id)&&(!selection.branch_key||selection.branch_key===routeKey(b))).sort((a,b)=>(ORDER[sourceMap.get(a.source_id)?.provider??'']??9)-(ORDER[sourceMap.get(b.source_id)?.provider??'']??9)||compare(a.source_id,b.source_id)||compare(a.project_id,b.project_id)||compare(a.task_id,b.task_id)||compare(a.run_id,b.run_id)||compare(a.branch_id,b.branch_id));
 const pages=Math.max(1,Math.ceil(filtered.length/PAGE_SIZE)),page=Math.min(pages-1,Math.max(0,Number.isSafeInteger(selection.page)?selection.page!:0)),rows=filtered.slice(page*PAGE_SIZE,(page+1)*PAGE_SIZE);
 const rendered_at=snapshot.rendered_at&&Number.isFinite(Date.parse(snapshot.rendered_at))?new Date(snapshot.rendered_at).toISOString():new Date().toISOString();
 const context:DisplayContext={rendered_at,sources:[...sourceMap.values()],requests:snapshot.requests};
 const views=rows.map(b=>displayBranch(b,context)),counts=displayCounts(filtered,context);
 const front:string[]=[],edges:string[]=[],nodes:Graph['nodes']=[];let missingGlyphs=0;
 const text=(x:number,y:number,value:unknown,size=14,color='#263740',weight='400',max=100)=>{
  const clipped=fitText(value,max);let safe='';for(const c of clipped){if(glyphSupported(c.codePointAt(0)!))safe+=c;else{safe+='□';missingGlyphs++;}}
  front.push(`<text x="${x}" y="${y}" fill="${color}" font-size="${size}" font-weight="${weight}" font-family="${FONT}">${xmlEscape(safe)}</text>`);
 };
 const lines=(value:string,x:number,y:number,max=21,count=2,color='#465964')=>{let rest=cleanText(value,1200),n=0;while(rest&&n<count){const fitted=fitText(rest,max),line=n===count-1?fitted:fitted.replace(/…$/,'');text(x,y+n*21,line,14,color,'400',max+1);rest=[...rest].slice([...line].length).join('');n++;}return n*21;};
 const edge=(x1:number,y1:number,x2:number,y2:number)=>edges.push(`<path d="M ${x1} ${y1} C ${x1} ${y2} ${x2-14} ${y2} ${x2} ${y2}" fill="none" stroke="#CDD8E0" stroke-width="2"/>`);
 text(16,34,selection.branch_key?'任务分支':'任务脉络',22,'#263740','500',15);
 if(snapshot.test_only)text(312,32,'演示',14,'#71818A','400',5);
 text(16,61,`${counts.tasks} 个任务 · ${counts.branches} 个分支${counts.actionableTasks?' · '+counts.actionableTasks+' 个任务待处理':''}`,14,'#61727C','400',25);
 let y=98,lastSource='',lastProject='',sourceY=0,projectY=0;
 for(const v of views){const b=v.branch,source=sourceMap.get(b.source_id)!,color=COLORS[source.provider??'']??'#7180AE';
  if(lastSource!==b.source_id){if(lastSource)y+=12;front.push(sourceIcon(source.provider??'',16,y-19));text(50,y,source.display_name??source.source_id,16,'#465964','500',20);sourceY=y+8;y+=31;lastSource=b.source_id;lastProject='';}
  const projectKey=JSON.stringify([b.source_id,b.project_id]);if(lastProject!==projectKey){edge(28,sourceY,42,y-5);front.push(`<circle cx="42" cy="${y-5}" r="3" fill="${color}"/>`);text(52,y,v.projectName,14,'#61727C','400',22);projectY=y+6;y+=18;lastProject=projectKey;}
  const start=y;const frontStart=front.length;edge(42,projectY,52,y+25);
  text(66,y+25,v.taskName,16,'#263740','500',18);y+=49;
  const state=v.state;front.push(`<g data-status-shape="${state.shape}"><rect x="66" y="${y-16}" width="${Math.min(96,state.label.length*14+24)}" height="24" rx="6" fill="${state.wash}"/></g>`);
  text(74,y+1,`${state.symbol} ${state.label}`,14,state.color,'500',8);text(174,y+1,v.branchName,14,'#61727C','400',13);y+=27;
  const primary=v.actionable?v.question:v.blocker?'阻塞：'+v.blocker:v.summary||'来源尚未提供摘要';y+=lines(primary,66,y,21,2,v.blocker?state.color:'#465964');
  if(v.progress){y+=3;y+=lines(v.progress,66,y,21,1);}
  if(v.warning){y+=3;y+=lines(v.warning,66,y,21,2,'#875914');}
  y+=3;text(66,y,compactTime(v.updatedAt,snapshot.utc_offset_minutes),14,'#61727C','400',25);y+=16;
  front.splice(frontStart,0,`<rect x="52" y="${start}" width="322" height="${y-start}" rx="12" fill="#FAFBFC" stroke="#E6EBEF"/>`);
  for(const node of phases(b,selection.selected_node_id))nodes.push({...node,branch_key:routeKey(b)});
  y+=14;
 }
 if(!rows.length){text(16,118,'尚无已确认任务',18,'#263740','500',20);text(16,146,selection.branch_key?'所选分支不可用，请重新选择':'收到来源更新后，这里会显示任务',14,'#61727C','400',25);y=184;
  const empty=sources.filter(s=>s.visible!==false&&(!selection.source_id||s.source_id===selection.source_id));for(const s of empty.slice(0,3)){text(16,y,s.display_name??s.source_id,16,'#465964','500',22);text(16,y+24,sourceLabel(s),14,'#61727C','400',25);y+=62;}if(empty.length>3){text(16,y,`另有 ${empty.length-3} 个来源`,14,'#61727C');y+=28;}}
 if(selection.branch_key&&selection.selected_node_id){const node=nodes.find(n=>n.node_id===selection.selected_node_id||n.phase_id===selection.selected_node_id);if(node){text(16,y+18,'历史阶段 · '+(node.label??'未命名阶段'),16,'#263740','500',22);y+=45;y+=lines(node.summary??'该阶段未保存摘要',16,y,25,2);text(16,y+5,compactTime(node.occurred_at,snapshot.utc_offset_minutes),14,'#61727C','400',35);y+=33;}}
 y+=12;text(16,y,`仅显示当前页 · 第 ${page+1}/${pages} 页`,14,'#61727C','400',35);y+=24;
 if(missingGlyphs){text(16,y,'□ 为字体缺字，请查看消息或原任务',14,'#875914','400',28);y+=24;}
 const height=Math.ceil(Math.max(180,y+12)),svg=`<svg xmlns="http://www.w3.org/2000/svg" width="390" height="${height}" viewBox="0 0 390 ${height}" role="img" aria-label="PA、项目、任务与分支的归属关系"><rect width="390" height="${height}" fill="#FFFFFF"/>${edges.join('')}${front.join('')}</svg>`;
 if(height>1100||svg.length>60000)throw new Error('render_output_limit');
 return {svg,width:390,height,page,pages,rows,nodes,sources:[...sourceMap.values()],rendered_at,revision:snapshot.revision??0,missingGlyphs,total:filtered.length,views,counts,context};
}

let wasmReady:Promise<void>|undefined;
/** Import the .wasm as a WebAssembly.Module and .otf as Data in the Worker entry.
 * Initialization is lazy to avoid top-level font/wasm work during startup.
 * The Node test harness passes the same WASM bytes and font asset, never a mock.
 */
export function createPngRenderer(options:{wasmModule:WebAssembly.Module|BufferSource;fontBuffers:(ArrayBuffer|Uint8Array)[]}):PngRenderer {
 if(!options.fontBuffers.length)throw new Error('cjk_font_required');
 const fontBuffers=options.fontBuffers.map(b=>b instanceof Uint8Array?b:new Uint8Array(b));
 if(fontBuffers.some(b=>!b.byteLength||b.byteLength>24*1024*1024))throw new Error('font_size_invalid');
 return async(graph,scale=2)=>{
  if(scale!==1&&scale!==2)throw new Error('render_scale_invalid');
  if(graph.width!==390||graph.height>1100||graph.height<1||graph.svg.length>60000)throw new Error('render_output_limit');
  // Only render output from our safe SVG builder; do not expose a raw SVG API.
  const inspectedSvg=graph.svg.replace(/<image x="\d+" y="\d+" width="24" height="24" href="([^"]+)"\/>/g,(tag,href)=>href===MUSE_ICON_DATA?'':tag);
  if(/<\s*(?:script|foreignObject|image|use|style)\b|\b(?:href|onload|onclick)\s*=|<!DOCTYPE|<!ENTITY|url\s*\(/i.test(inspectedSvg))throw new Error('unsafe_svg');
  wasmReady??=initWasm(options.wasmModule);
  await wasmReady;
  const resvg=new Resvg(graph.svg,{font:{fontBuffers,defaultFontFamily:FONT,sansSerifFamily:FONT},fitTo:{mode:'zoom',value:scale},background:'#ffffff'});
  let rendered:ReturnType<typeof resvg.render>|undefined;
  try{if(resvg.imagesToResolve().length)throw new Error('external_svg_resource');rendered=resvg.render();const bytes=rendered.asPng().slice();if(bytes.byteLength>4*1024*1024)throw new Error('png_size_limit');return bytes;}
  finally{rendered?.free();resvg.free();}
 };
}
