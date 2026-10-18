/** Bounded, deterministic mobile topology. Equal-width bands encode ancestry,
 * never estimated effort, completion percentages, or a live connection claim.
 * Production has no filesystem, network, browser, canvas, or native addon use.
 */
import {statusVisual} from './status-style.ts';
export {statusVisual} from './status-style.ts';
import {sourceIcon,MUSE_ICON_DATA} from './source-icons.ts';
import {initWasm,Resvg} from '@resvg/resvg-wasm';
import coverage from '../assets/fonts/coverage.json' with {type:'json'};

export const PAGE_SIZE=3;
export const STATUS_LABELS:Record<string,string>={proposed:'待开始',running:'进行中',needs_input:'待你决定',completed:'已完成',failed:'失败',cancelled:'已取消'};
const COLORS:Record<string,string>={dot:'#D57A42',spark:'#626BC5',muse:'#438DB3'};
const ORDER:Record<string,number>={dot:0,spark:1,muse:2};
const FONT='Noto Sans CJK SC';
export type SourceView={source_id:string;display_name?:string;provider?:string;enabled?:boolean;last_seen?:number|string|null;connection_status?:string;verification_status?:string;visible?:boolean;selectable?:boolean};
export type PhaseView={phase_id?:string|null;node_id?:string;label?:string;event_id?:string;occurred_at?:string;summary?:string};
export type BranchView=Record<string,any> & {source_id:string;project_id:string;task_id:string;run_id:string;branch_id:string;source_status:string};
export type Selection={source_id?:string|null;branch_key?:string|null;selected_node_id?:string|null;page?:number};
export type Snapshot={branches:BranchView[];sources?:SourceView[];selection?:Selection;rendered_at?:string;test_only?:boolean;revision?:number;utc_offset_minutes?:number};
export type Graph={svg:string;width:390;height:number;page:number;pages:number;rows:BranchView[];nodes:(PhaseView&{branch_key:string})[];sources:SourceView[];rendered_at:string;revision:number;missingGlyphs:number;total:number};
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
export function requestExpired(branch:BranchView,asOf?:string):boolean {const expiry=Date.parse(branch.action?.expires_at??''),now=Date.parse(asOf??'');return branch.source_status==='needs_input'&&Number.isFinite(expiry)&&Number.isFinite(now)&&expiry<=now;}
export function stateLabel(branch:BranchView,asOf?:string):string {const base=requestExpired(branch,asOf)?'请求期限已过 · 原平台待核对':STATUS_LABELS[branch.source_status]??'状态未知';return base+(branch.blocker?' · 阻塞':'')+(branch.stale?' · 信息过期':'');}
/** Only display source-provided quantities. Never derive a completion percentage. */
export function progressLabel(branch:BranchView):string {const p=branch.progress;if(!p||typeof p.done!=='number'||!Number.isFinite(p.done)||p.done<0||typeof p.unit!=='string'||!p.unit.trim())return '进展：未提供可核对数量';if(p.total===null||p.total===undefined)return `已报告 ${p.done} ${cleanText(p.unit,40)} · 总量未知`;if(typeof p.total!=='number'||!Number.isFinite(p.total)||p.total<=0||p.done>p.total)return '进展：数量待核对';return `已报告 ${p.done} / ${p.total} ${cleanText(p.unit,40)}`;}
export function attentionLabel(branch:BranchView,asOf?:string):string {if(branch.blocker)return '阻塞：'+cleanText(branch.blocker,400);if(requestExpired(branch,asOf))return '请回原平台核对过期请求';if(branch.source_status==='needs_input')return '待处理：'+cleanText(branch.action?.question??'请回原平台查看',400);return '摘要：'+cleanText(branch.summary??'来源未提供更多详情',1200);}
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
 let last=all.slice(-3);
 const chosen=selected?all.find(n=>n.node_id===selected||n.phase_id===selected):undefined;
 if(chosen&&!last.includes(chosen))last=[chosen,...all.slice(-2)];
 if(!last.length)last=[{phase_id:branch.phase_id??null,label:branch.phase_label??'阶段未提供',event_id:branch.event_id,occurred_at:branch.last_confirmed_at??branch.occurred_at,summary:branch.summary}];
 return last;
}

/** Native components use rows/nodes metadata; SVG pixels are deliberately inert. */
export function renderOverview(snapshot:Snapshot):Graph {
 if(!snapshot||!Array.isArray(snapshot.branches)||snapshot.branches.length>1000)throw new Error('render_branches_limit');
 if(snapshot.sources!==undefined&&(!Array.isArray(snapshot.sources)||snapshot.sources.length>100))throw new Error('render_sources_limit');
 const selection=snapshot.selection??{},sources=snapshot.sources??[];
 const sourceMap=new Map(sources.map(s=>[s.source_id,s]));
 for(const b of snapshot.branches){if(!b||typeof b!=='object')throw new Error('render_branch_invalid');if(!sourceMap.has(b.source_id))sourceMap.set(b.source_id,{source_id:b.source_id,display_name:b.source_id});}
 const compare=(a:unknown,b:unknown)=>{const x=cleanText(a,120),y=cleanText(b,120);return x<y?-1:x>y?1:0;};
 const filtered=snapshot.branches.filter(b=>!b.archived&&(!selection.source_id||selection.source_id===b.source_id)&&(!selection.branch_key||selection.branch_key===routeKey(b))).sort((a,b)=>(ORDER[sourceMap.get(a.source_id)?.provider??'']??9)-(ORDER[sourceMap.get(b.source_id)?.provider??'']??9)||compare(a.source_id,b.source_id)||compare(a.project_id,b.project_id)||compare(a.task_id,b.task_id)||compare(a.run_id,b.run_id)||compare(a.branch_id,b.branch_id));
 const pages=Math.max(1,Math.ceil(filtered.length/PAGE_SIZE));
 const page=Math.min(pages-1,Math.max(0,Number.isSafeInteger(selection.page)?selection.page!:0));
 const rows=filtered.slice(page*PAGE_SIZE,(page+1)*PAGE_SIZE);
 const rendered_at=snapshot.rendered_at&&Number.isFinite(Date.parse(snapshot.rendered_at))?new Date(snapshot.rendered_at).toISOString():new Date().toISOString();
 const front:string[]=[],bands:string[]=[],nodes:Graph['nodes']=[];let missingGlyphs=0;
 const text=(x:number,y:number,value:unknown,size=13,color='#263740',weight='400',max=100)=>{
  const clipped=fitText(value,max);let safe='';for(const c of clipped){if(glyphSupported(c.codePointAt(0)!))safe+=c;else {safe+='□';missingGlyphs++;}}
  front.push(`<text x="${x}" y="${y}" fill="${color}" font-size="${size}" font-weight="${weight}" font-family="${FONT}">${xmlEscape(safe)}</text>`);
 };
 const band=(x1:number,y1:number,x2:number,y2:number,color:string)=>{const mid=(x1+x2)/2;bands.push(`<path d="M ${x1} ${y1} C ${mid} ${y1} ${mid} ${y2} ${x2} ${y2}" fill="none" stroke="${color}" stroke-opacity="0.19" stroke-width="8"/>`);};
 const bar=(x:number,y:number,color:string)=>front.push(`<rect x="${x-4}" y="${y-12}" width="8" height="24" rx="1" fill="${color}"/>`);
 text(16,33,selection.branch_key?'任务详情':'Rivule · 进展',23,'#263740','500',15);
 if(snapshot.test_only)text(330,32,'演示',12,'#71818A','400',5);
 
 let y=77;
 const groups=new Map<string,{source:SourceView;routes:{branch:BranchView;y:number}[]}>();
 for(const branch of rows){let group=groups.get(branch.source_id);if(!group){group={source:sourceMap.get(branch.source_id)!,routes:[]};groups.set(branch.source_id,group);}group.routes.push({branch,y:0});}
 for(const {source,routes} of groups.values()){
  const color=COLORS[source.provider??'']??'#7180AE';
  front.push(sourceIcon(source.provider??'',16,y-19));
  text(48,y,source.display_name??source.source_id,17,color,'500',22);
  if(source.verification_status&&source.verification_status!=='verified')text(180,y,sourceLabel(source),12,'#875914','400',14);
  y+=44;
  const sourceYs:number[]=[];const projects=new Map<string,number[]>();
  for(const row of routes){
   const b=row.branch;row.y=y;sourceYs.push(y+8);const projectYs=projects.get(b.project_id)??[];projectYs.push(y+8);projects.set(b.project_id,projectYs);
   const status=statusVisual(b);
   front.push(`<rect x="68" y="${y-35}" width="308" height="212" rx="12" fill="#FAFBFC" stroke="#E8EDF0"/>`);
   front.push(`<rect x="85" y="${y+30}" width="272" height="23" rx="6" fill="${status.wash}"/>`);
   const cx=97,cy=y+41;
   const mark=status.shape==='diamond'?`<path d="M ${cx} ${cy-6} l 6 6 -6 6 -6 -6 Z"/>`:status.shape==='pause'?`<path d="M ${cx-4} ${cy-5} v 10 M ${cx+3} ${cy-5} v 10" fill="none" stroke-width="3"/>`:status.shape==='check'?`<path d="M ${cx-5} ${cy} l 3 4 7 -8" fill="none" stroke-width="2"/>`:status.shape==='play'?`<path d="M ${cx-4} ${cy-6} l 10 6 -10 6 Z"/>`:`<circle cx="${cx}" cy="${cy}" r="4"/>`;
   front.push(`<g data-status-shape="${status.shape}" fill="${status.color}" stroke="${status.color}">${mark}</g>`);
   const projectName=cleanText(b.project_name??b.project_id),taskName=cleanText(b.task_name??b.task_id);
   const merged=projectName.includes(taskName)||taskName.includes(projectName);
   if(!merged)text(86,y-18,projectName,12,'#71818A','400',24);
   text(86,y+3,merged?(projectName.length>=taskName.length?projectName:taskName):taskName,14,'#263740','500',20);
   text(86,y+24,'路线：'+(b.branch_name??b.branch_id),13,'#263740','500',21);
   text(111,y+46,b.blocker?'受阻':stateLabel({...b,stale:false},rendered_at),12,status.color,'500',21);
   text(86,y+64,progressLabel(b),12,'#465964','400',23);
   const attention=attentionLabel(b,rendered_at),line=fitText(attention,22).replace(/…$/,'');
   text(86,y+84,line,12,b.blocker?'#9A6334':'#465964','400',23);
   if([...line].length<[...attention].length)text(86,y+101,[...attention].slice([...line].length).join(''),12,b.blocker?'#9A6334':'#465964','400',23);
   text(86,y+120,compactTime(b.last_confirmed_at??b.occurred_at,snapshot.utc_offset_minutes)+(b.stale?' · 已过期':''),12,'#7C8D95','400',35);
   bar(76,y+8,color);band(76,y+20,76,y+146,color);band(76,y+146,367,y+146,color);
   const pn=phases(b,selection.selected_node_id);
   if(pn.length>1)front.push(`<path d="M 105 ${y+146} H 341" stroke="${color}" stroke-opacity="0.35" stroke-width="2" fill="none"/>`);
   pn.forEach((node,i)=>{
    const x=pn.length===1?105:105+i*(236/(pn.length-1));
    const chosen=!!selection.selected_node_id&&(node.node_id===selection.selected_node_id||node.phase_id===selection.selected_node_id);
    const current=node.phase_id===b.phase_id;const fill=current?color:'#FFFFFF';const border=2;
    if(chosen||current)front.push(`<circle cx="${x}" cy="${y+146}" r="9" fill="none" stroke="${color}" stroke-opacity="0.65" stroke-width="2"/>`);
    if(current&&b.source_status==='needs_input')front.push(`<rect x="${x-5}" y="${y+141}" width="10" height="10" fill="${fill}" stroke="${color}" stroke-width="${border}"/>`);
    else front.push(`<circle cx="${x}" cy="${y+146}" r="5" fill="${fill}" stroke="${color}" stroke-width="${border}"/>`);
    const label=fitText(node.label??'阶段未提供',6);const labelWidth=[...label].reduce((n,c)=>n+(c.codePointAt(0)!<0x2e80?6.84:12),0);
    text(Math.max(77,Math.min(374-labelWidth,x-labelWidth/2)),y+171,label,12,'#263740','400',7);
    nodes.push({...node,branch_key:routeKey(b)});
   });
   y+=218;
  }
  const center=sourceYs.reduce((n,v)=>n+v,0)/sourceYs.length;
  bar(23,center,color);for(const projectYs of projects.values()){const projectCenter=projectYs.reduce((a,b)=>a+b,0)/projectYs.length;bar(49,projectCenter,color);band(28,center,44,projectCenter,color);projectYs.forEach((ry,i)=>band(54,projectCenter+(i-(projectYs.length-1)/2)*8,71,ry,color));}
  y+=5;
 }
 if(!rows.length){
  text(16,112,filtered.length?'此页没有路线':'尚无已确认任务',18,'#263740','500',19);
  text(16,143,selection.branch_key?'所选路线不可用，请重新选择':'来源送达事件后，这里才会显示任务',12,'#71818A','400',29);
  let sy=186;
  const emptySources=sources.filter(s=>s.visible!==false&&(!selection.source_id||s.source_id===selection.source_id));
  for(const source of emptySources.slice(0,3)){
   text(16,sy,source.display_name??source.source_id,15,COLORS[source.provider??'']??'#7180AE','500',20);
   text(16,sy+21,sourceLabel(source),12,'#71818A','400',28);sy+=59;
  }
  if(emptySources.length>3){text(16,sy,`另有 ${emptySources.length-3} 个来源，可用选择器查看`,12,'#71818A','400',30);sy+=30;}
  y=sy;
 }
 const detail=rows.length===1&&selection.branch_key?rows[0]:null;
 if(detail){
  const chosen=selection.selected_node_id?phases(detail,selection.selected_node_id).find(n=>n.node_id===selection.selected_node_id||n.phase_id===selection.selected_node_id):undefined;
  const detailText=cleanText(chosen?(chosen.summary??'该阶段未保存摘要；当前路线内容见消息详情'):(detail.summary??'来源未提供更多详情'),1200);
  front.push(`<rect x="16" y="${y-2}" width="358" height="109" rx="10" fill="#F5F7FB"/>`);
  text(29,y+21,chosen?'选中节点 · '+(chosen.label??'阶段'):'当前路线详情',14,'#263740','500',22);
  // Two deterministic lines, then native embed carries the full text.
  const first=fitText(detailText,25),cut=[...first.replace(/…$/,'')].length;
  text(29,y+47,first.replace(/…$/,''),12,'#465964','400',26);
  if(cut<[...detailText].length)text(29,y+67,[...detailText].slice(cut).join(''),12,'#465964','400',26);
  text(29,y+91,'来源确认 '+displayTime(chosen?.occurred_at??detail.last_confirmed_at??detail.occurred_at),12,'#7C8D95','400',46);y+=126;
 }
 y=Math.max(180,y-18);
 // Keep operational semantics in native details, not the overview artwork.
 text(16,y+12,`第 ${page+1}/${pages} 页 · ${filtered.length} 条路线`,12,'#71818A','400',38);
 text(16,y+33,'更新 '+compactTime(rendered_at,snapshot.utc_offset_minutes),12,'#71818A','400',42);
 if(missingGlyphs){text(16,y+112,'□ 为字体缺字，请查看消息或原任务',12,'#94643A','400',37);y+=18;}
 const height=Math.ceil(y+50);
 const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="390" height="${height}" viewBox="0 0 390 ${height}" role="img" aria-label="PA项目与并行路线的已知阶段，静态快照"><rect width="390" height="${height}" fill="#FFFFFF"/>${bands.join('')}${front.join('')}</svg>`;
 if(height>1100||svg.length>60000)throw new Error('render_output_limit');
 return {svg,width:390,height,page,pages,rows,nodes,sources:[...sourceMap.values()],rendered_at,revision:snapshot.revision??0,missingGlyphs,total:filtered.length};
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
