import type {BranchView} from './render.ts';
/** State is redundant in color, shape and text; never inferred from elapsed time. */
export function statusVisual(branch:BranchView):{color:string;wash:string;shape:string} {
 if(branch.blocker||branch.source_status==='failed')return {color:'#A33E36',wash:'#FFF1EE',shape:'diamond'};
 if(branch.source_status==='needs_input')return {color:'#875914',wash:'#FFF5DC',shape:'pause'};
 if(branch.source_status==='completed')return {color:'#246B51',wash:'#EAF5EF',shape:'check'};
 if(branch.source_status==='running')return {color:'#285F9C',wash:'#EBF2FC',shape:'play'};
 return {color:'#657079',wash:'#F0F2F3',shape:'circle'};
}
export function nativeStatus(branch:BranchView):{label:string;symbol:string;color:number} {
 const visual=statusVisual(branch);
 const labels:Record<string,string>={proposed:'待开始',running:'进行中',needs_input:'待你决定',completed:'已完成',failed:'失败',cancelled:'已取消'};
 const symbols:Record<string,string>={diamond:'◆',pause:'Ⅱ',check:'✓',play:'▶',circle:'○'};
 return {label:branch.blocker?'受阻':labels[branch.source_status]??'状态未知',symbol:symbols[visual.shape],color:Number.parseInt(visual.color.slice(1),16)};
}
