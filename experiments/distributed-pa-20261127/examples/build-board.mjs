import fs from 'node:fs';
const get=p=>fs.readFileSync(new URL(p,import.meta.url),'utf8');
const cut=s=>s.replace(/^import .*;\n/gm,'').replace(/^export /gm,'');
const replay=JSON.parse(get('./verified-qwenpaw-replay.json'));
if(replay.length!==6||replay.some(f=>f.scope!=='lab-room'||f.cards.length!==3))throw Error('verified replay absent');
const replayCode='const verifiedQwenReplay='+JSON.stringify(replay).replaceAll('<','\\u003c')+';\n';
const code=replayCode+cut(get('../src/sdk/coordination-board.mjs'))+'\n'+cut(get('./coordination-board-demo.mjs'));
if(/<\/script/i.test(code))throw new Error('unsafe inline literal');
process.stdout.write(get('./board-shell.html').replace('{{CODE}}',()=>code));
