import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
for(const file of ['src/owner/worker.js','src/owner/qq-integration.mjs','src/owner/dashboard.mjs','src/owner/presentation.mjs','src/owner/brand-identity.mjs','src/owner/notification-policy.mjs','src/owner/dashboard-receipt.mjs','src/owner/dashboard-read-model.mjs','src/gateway/worker.mjs','scripts/build.mjs','scripts/install-font.mjs']){const r=spawnSync(process.execPath,['--check',root+file],{stdio:'inherit'});if(r.status!==0)process.exit(r.status??1);}
for(const file of ['config/wrangler.owner.example.json','config/wrangler.qq.example.json'])JSON.parse(readFileSync(root+file));
console.log('Source syntax and configuration templates are valid.');
