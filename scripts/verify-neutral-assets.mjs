import {readFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const manifest=JSON.parse(readFileSync(path.join(root,'PUBLIC_ASSET_TRANSFORM.json'),'utf8'));
const sha=x=>createHash('sha256').update(x).digest('hex');
const allowedUri=manifest.original_replacements.find(x=>x.name==='M neutral badge data URI').value_sha256;
const allowedPaths=manifest.original_replacements.find(x=>x.name==='S neutral badge SVG paths').value_sha256;
function stringValue(literal){if(literal[0]==='"')return JSON.parse(literal);return literal.slice(1,-1).replace(/\\([\\'"nrt])/g,(_,c)=>({n:'\n',r:'\r',t:'\t'}[c]??c));}
let files=0, imageUris=0, pathDeclarations=0;
function walk(dir){for(const d of readdirSync(dir,{withFileTypes:true})){
 if(['node_modules','.git','.wrangler'].includes(d.name))continue;
 const file=path.join(dir,d.name);if(d.isSymbolicLink())throw Error('Unexpected distributable symlink: '+path.relative(root,file));
 if(d.isDirectory()){walk(file);continue;}files++;
 const bytes=readFileSync(file),text=bytes.toString('utf8');
 for(const match of text.matchAll(/data:image\/[a-zA-Z+./-]+;base64,[A-Za-z0-9+/=]+/g)){
  if(sha(match[0])!==allowedUri)throw Error('Non-neutral embedded image: '+path.relative(root,file));imageUris++;
 }
 for(const match of text.matchAll(/(?:var|const) SPARK_PATHS\s*=\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g)){
  if(sha(stringValue(match[1]))!==allowedPaths)throw Error('Non-neutral Spark artwork: '+path.relative(root,file));pathDeclarations++;
 }
}}
walk(root);
if(imageUris<2||pathDeclarations<2)throw Error('Missing neutral display inputs');
const worker=readFileSync(path.join(root,'production-readable-ui-candidate-20261018/modules/worker.js'),'utf8');
let normalized=worker;
for(const name of ['MUSE_ICON_DATA','SPARK_PATHS']){
 const re=new RegExp('  var '+name+' = .*?;\\n','g');
 if([...normalized.matchAll(re)].length!==1)throw Error('Unexpected asset declaration count: '+name);
 normalized=normalized.replace(re,'  var '+name+' = "NEUTRAL_ASSET_AUDIT";\n');
}
if(manifest.normalized_owner_sha256&&sha(normalized)!==manifest.normalized_owner_sha256)throw Error('Non-asset bytes drifted from pinned readable private provenance');
if(manifest.public_owner_sha256&&sha(worker)!==manifest.public_owner_sha256)throw Error('Public owner output mismatch');
const gateway=readFileSync(path.join(root,'production-qq-active-probe-candidate-20261018/modules/gateway-candidate.mjs'));
if(manifest.gateway_main_sha256&&sha(gateway)!==manifest.gateway_main_sha256)throw Error('QQ gateway changed');
console.log(JSON.stringify({neutralAssetAudit:true,files,imageUris,pathDeclarations,publicOwnerSha256:sha(worker),normalizedOwnerSha256:sha(normalized),gatewaySha256:sha(gateway)}));
