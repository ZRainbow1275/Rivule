import {readFileSync,mkdirSync,copyFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const require=createRequire(import.meta.url);
const plan=JSON.parse(readFileSync(new URL('font-repack.json',import.meta.url)));
const font=root+plan.output_path;
function verify(path,expected,label){let bytes;try{bytes=readFileSync(path)}catch{throw Error(label+' missing. Run npm ci --ignore-scripts and npm run resources before building.')}if(createHash('sha256').update(bytes).digest('hex')!==expected)throw Error(label+' integrity mismatch. Restore the pinned resource; build stopped.');}
const wasm=require.resolve('@resvg/resvg-wasm/index_bg.wasm');
verify(font,plan.output_sha256,'Noto font');
verify(wasm,'22bf6e9f9a100d972da0411a69c5ba504367fc1fa87b3b64e3f35e53926d2d70','resvg WASM');
for(const worker of ['owner','gateway'])mkdirSync(root+'dist/'+worker,{recursive:true});
for(const file of ['owner/worker.js','owner/qq-integration.mjs','owner/dashboard.mjs','owner/dashboard-settings.mjs','owner/dashboard-connection.mjs','owner/presentation.mjs','owner/brand-identity.mjs','owner/notification-policy.mjs','owner/dashboard-receipt.mjs','owner/dashboard-read-model.mjs','gateway/worker.mjs'])copyFileSync(root+'src/'+file,root+'dist/'+file);
copyFileSync(font,root+'dist/owner/font.otf');copyFileSync(wasm,root+'dist/owner/renderer.wasm');
console.log('Built owner and gateway modules in dist/.');
