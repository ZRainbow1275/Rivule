import A from 'node:assert/strict';
import {writeFileSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const source=fileURLToPath(new URL('../tests/qwenpaw-board-fixture.test.mjs',import.meta.url));
const t=spawnSync(process.execPath,['--no-warnings','--test','--test-name-pattern=QwenPaw loses response',source],
 {encoding:'utf8',env:{...process.env,RIVULE_BOARD_REPLAY:'1'},timeout:10000});
A.equal(t.status,0,t.stderr);
const lines=t.stdout.split('\n').filter(x=>x.includes('RIVULE_BOARD_REPLAY:'));
A.equal(lines.length,1);
const frames=JSON.parse(lines[0].split('RIVULE_BOARD_REPLAY:')[1]);
A.equal(frames.length,6);
const target=new URL('./verified-qwenpaw-replay.json',import.meta.url),json=JSON.stringify(frames,null,2)+'\n';
if(process.argv.includes('--check'))A.equal(readFileSync(target,'utf8'),json);
else writeFileSync(target,json);
process.stdout.write('verified '+frames.length+' board frames\n');
