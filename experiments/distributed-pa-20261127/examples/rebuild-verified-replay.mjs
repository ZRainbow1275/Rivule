import A from 'node:assert/strict';
import {writeFileSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

for(const [file,pattern,marker,target,count] of [
 ['qwenpaw-board-fixture','QwenPaw loses response','RIVULE_BOARD_REPLAY','qwenpaw',6],
 ['viktor-board-fixture','A question survives cold restart','RIVULE_VIKTOR_REPLAY','viktor',4],
 ['coordinator-catchup','R06 offline board','RIVULE_COORDINATOR_REPLAY','coordinator',5],
]){
 const source=fileURLToPath(new URL('../tests/'+file+'.test.mjs',import.meta.url));
 const t=spawnSync(process.execPath,['--no-warnings','--test','--test-name-pattern='+pattern,source],
  {encoding:'utf8',env:{...process.env,[marker]:'1'},timeout:10000});
 A.equal(t.status,0,t.stderr);
 const prefix=marker+':',lines=t.stdout.split('\n').filter(x=>x.includes(prefix));
 A.equal(lines.length,1);
 const frames=JSON.parse(lines[0].split(prefix)[1]);
 A.equal(frames.length,count);
 const path=new URL('./verified-'+target+'-replay.json',import.meta.url),json=JSON.stringify(frames,null,2)+'\n';
 if(process.argv.includes('--check'))A.equal(readFileSync(path,'utf8'),json);
 else writeFileSync(path,json);
 process.stdout.write('verified '+frames.length+' '+target+' board frames\n');
}
