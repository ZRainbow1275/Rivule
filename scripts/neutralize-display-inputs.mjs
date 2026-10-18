// Deterministic, idempotent artwork transformation. No removed artwork is stored here.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const root=new URL('../',import.meta.url),sha=x=>createHash('sha256').update(x).digest('hex');
const manifest=JSON.parse(readFileSync(new URL('PUBLIC_ASSET_TRANSFORM.json',root),'utf8'));
if(manifest.variant!=='public-neutral-original-letter-badges')throw Error('This transform is only for the original neutral-badge variant');
const m=readFileSync(new URL('assets/muse-neutral.svg',root),'utf8').trim();
const s=readFileSync(new URL('assets/spark-neutral.svg',root),'utf8').trim().replace(/^<svg[^>]*>/,'').replace(/<\/svg>$/,'');
const replacements={MUSE_ICON_DATA:'data:image/svg+xml;base64,'+Buffer.from(m).toString('base64'),SPARK_PATHS:s};
for(const [i,name] of ['MUSE_ICON_DATA','SPARK_PATHS'].entries())if(sha(replacements[name])!==manifest.original_replacements[i].value_sha256)throw Error('Neutral artwork checksum mismatch: '+name);
for(const rel of ['local-candidate/cloudflare/src/source-icons.ts','production-readable-ui-candidate-20261018/src/source-icons.ts']){
 const file=new URL(rel,root);let text=readFileSync(file,'utf8');const before=text;
 for(const [i,name] of ['MUSE_ICON_DATA','SPARK_PATHS'].entries()){
  const re=new RegExp('('+name+'\\s*=\\s*)("(?:\\\\.|[^"\\\\])*")(;)','g');
  const matches=[...text.matchAll(re)];if(matches.length!==1)throw Error('Ambiguous source constant: '+rel+':'+name);
  const current=JSON.parse(matches[0][2]);
  if(![manifest.removed_assets[i].value_sha256,manifest.original_replacements[i].value_sha256].includes(sha(current)))throw Error('Unreviewed artwork input: '+rel+':'+name);
  text=text.replace(re,(_,prefix,literal,suffix)=>prefix+JSON.stringify(replacements[name])+suffix);
 }
 text=text.replace(/\/\*\* Pinned official assets;[\s\S]*?\*\//,'/** Original neutral letter badges for this public variant.\n * M and S identify Muse and Gemini Spark in text; these are not product logos.\n * The Zot badge is original project artwork. Never accept source-event image data.\n */');
 if(text!==before)writeFileSync(file,text);
 console.log(rel+': '+sha(text));
}
