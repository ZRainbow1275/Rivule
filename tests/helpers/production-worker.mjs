import vm from 'node:vm';import {readFileSync} from 'node:fs';
const root=new URL('../../',import.meta.url).pathname;
export async function loadProductionWorker(){const globals={};
for(const k of ['URL','URLSearchParams','Request','Response','Headers','Blob','FormData','crypto','TextEncoder','TextDecoder','AbortController','AbortSignal','ReadableStream','WritableStream','TransformStream','structuredClone','Buffer','Uint8Array','ArrayBuffer','DataView','Event','MessageEvent','EventTarget','atob','btoa','setTimeout','clearTimeout','setInterval','clearInterval','console'])globals[k]=globalThis[k];
for(const file of ['qq-response-consent','qq-command-adapter','message-bridge','bridge-source-contract','discord-command-adapter','dashboard-catalog','dashboard-activity','dashboard-connection','brand-identity','notification-policy','dashboard-receipt','dashboard','qq-integration'])Object.assign(globals,await import(root+'/src/owner/'+file+'.mjs'));
globals.console={warn(){},log(){},error(){}};
Object.assign(globals,{DurableObject:class{},WorkerEntrypoint:class{},font:new Uint8Array(1),wasmModule:{},fetch(){throw Error('network forbidden');}});
const context=vm.createContext(globals);vm.runInContext(readFileSync(root+'/src/owner/worker.js','utf8').replace(/^import .*;$/gm,'').replace('export { OwnerTerminal, worker_default as default };','globalThis.testApi={OwnerCore,createDiscordSender,prepare,OwnerTerminal};'),context,{timeout:3000});return context.testApi;}
