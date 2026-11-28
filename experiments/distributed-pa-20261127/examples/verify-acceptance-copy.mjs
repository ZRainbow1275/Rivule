// Offline operator check. No network or claims about the copy's issuer.
import {readFileSync} from 'node:fs';
import {compareArtifactBytes} from '../src/sdk/portable-acceptance.mjs';
const [record,file,...extra]=process.argv.slice(2);
if(!record||!file||extra.length)throw new TypeError('usage: node examples/verify-acceptance-copy.mjs record.json artifact');
const result=compareArtifactBytes(JSON.parse(readFileSync(record,'utf8')),readFileSync(file));
console.log(JSON.stringify({result,issuerVerified:false}));
if(result==='artifact_mismatch')process.exitCode=2;
