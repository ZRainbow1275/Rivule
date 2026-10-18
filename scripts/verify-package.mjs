import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const root=new URL('../',import.meta.url), manifest=JSON.parse(readFileSync(new URL('PROVENANCE.json',root),'utf8'));
let count=0;for(const [file,expected] of Object.entries(manifest.files)){const actual=createHash('sha256').update(readFileSync(new URL(file,root))).digest('hex');if(actual!==expected)throw Error('Package hash mismatch: '+file);count++;}
console.log(`Verified ${count} pinned input and module files`);
