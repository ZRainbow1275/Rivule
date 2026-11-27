import fs from 'node:fs';
const get=p=>fs.readFileSync(new URL(p,import.meta.url),'utf8');
const cut=s=>s.replace(/^import .*;\n/gm,'').replace(/^export /gm,'');
const code=cut(get('../src/sdk/coordination-board.mjs'))+'\n'+cut(get('./coordination-board-demo.mjs'));
if(/<\/script/i.test(code))throw new Error('unsafe inline literal');
process.stdout.write(get('./board-shell.html').replace('{{CODE}}',()=>code));
