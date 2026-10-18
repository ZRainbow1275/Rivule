import {readFileSync,writeFileSync,renameSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {dirname} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
export const plan=JSON.parse(readFileSync(new URL('font-repack.json',import.meta.url)));
const sha=b=>createHash('sha256').update(b).digest('hex');
export function repackFont(input){
 const b=Buffer.from(input);if(sha(b)!==plan.source_sha256)throw Error('Official font integrity mismatch; no output written.');
 const tables=new Map();for(let i=0;i<b.readUInt16BE(4);i++){const k=12+i*16;tables.set(b.toString('ascii',k,k+4),{offset:b.readUInt32BE(k+8),length:b.readUInt32BE(k+12)});}
 const out=Buffer.alloc(plan.output_size);Buffer.from(plan.header_base64,'base64').copy(out);
 for(const t of plan.tables){const s=tables.get(t.tag);if(!s||s.length!==t.length||s.offset+s.length>b.length)throw Error('Font table mismatch; no output written.');b.copy(out,t.offset,s.offset,s.offset+s.length);for(const [i,value] of t.patches)out[t.offset+i]=value;}
 if(sha(out)!==plan.output_sha256)throw Error('Repacked font integrity mismatch; no output written.');return out;
}
export async function installFont(fetcher=globalThis.fetch){
 let input;try{const response=await fetcher(plan.source_url,{redirect:'error',signal:AbortSignal.timeout(60000)});if(!response.ok)throw Error('HTTP '+response.status);input=await response.arrayBuffer();}catch(e){throw Error('Unable to download pinned official Noto font. Check network access and rerun node scripts/install-font.mjs. No substitute or partial font was installed. '+String(e.message));}
 const out=repackFont(input),dest=root+plan.output_path;mkdirSync(dirname(dest),{recursive:true});writeFileSync(dest+'.tmp',out);renameSync(dest+'.tmp',dest);console.log('Verified Noto font '+plan.output_sha256);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await installFont();
