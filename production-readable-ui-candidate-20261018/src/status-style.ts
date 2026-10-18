import type {BranchView} from './render.ts';
import {displayBranch} from './display-model.ts';
import type {DisplayContext} from './display-model.ts';
/** Missing request evidence deliberately stays 等待输入. */
export function statusVisual(branch:BranchView,context:DisplayContext={rendered_at:new Date().toISOString()}) {return displayBranch(branch,context).state;}
export function nativeStatus(branch:BranchView,context?:DisplayContext):{label:string;symbol:string;color:number} {const s=statusVisual(branch,context);return {label:s.label,symbol:s.symbol,color:Number.parseInt(s.color.slice(1),16)};}
