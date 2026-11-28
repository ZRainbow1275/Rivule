import fs from 'node:fs';
const get=p=>fs.readFileSync(new URL(p,import.meta.url),'utf8');
const cut=s=>s.replace(/^import .*;\n/gm,'').replace(/^export /gm,'');
const replayCode=(name,file,scope,count)=>{
 const replay=JSON.parse(get('./verified-'+file+'-replay.json'));
 if(replay.length!==count||replay.some(f=>f.scope!==scope||(file==='access'&&f.access.a.version===null?f.cards.length!==0:f.cards.length!==3)))throw Error('verified replay absent');
 return 'const '+name+'='+JSON.stringify(replay).replaceAll('<','\\u003c')+';\n';
};
const code=replayCode('verifiedQwenReplay','qwenpaw','lab-room',6)+
 replayCode('verifiedViktorReplay','viktor','rivule-lab-us',4)+
 replayCode('verifiedCoordinatorReplay','coordinator','authority',5)+
 replayCode('verifiedReviewedReplay','reviewed','review-sandbox',5)+
 replayCode('verifiedEgressReplay','egress','boundary-fixture',4)+
 replayCode('verifiedDispatchReplay','dispatch','seat-preview',4)+
 replayCode('verifiedSettledReplay','settled','delivery-order',4)+
 replayCode('verifiedAccessReplay','access','authority',5)+
 replayCode('verifiedSkillReplay','skill','skill-rehearsal',5)+
 cut(get('../src/sdk/coordination-board.mjs'))+'\n'+cut(get('./coordination-board-demo.mjs'));
if(/<\/script/i.test(code))throw new Error('unsafe inline literal');
process.stdout.write(get('./board-shell.html').replace('{{CODE}}',()=>code));
