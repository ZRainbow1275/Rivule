import {readFileSync,writeFileSync} from 'node:fs';
const root=new URL('../',import.meta.url);
let code=readFileSync(new URL('modules/worker.js',root),'utf8');
code=code.replace('from "./qq-integration.mjs"','from "../modules/qq-integration.mjs"')
.replace('import { DurableObject } from "cloudflare:workers";', 'class DurableObject { constructor(ctx,env){this.ctx=ctx;this.env=env;} }')
.replace('import { WorkerEntrypoint } from "cloudflare:workers";', 'class WorkerEntrypoint { constructor(ctx,env){this.ctx=ctx;this.env=env;} }')
.replace(/^import wasmModule from .*;$/m,'const wasmModule = null;')
.replace(/^import font from .*;$/m,'const font = new Uint8Array([1]);');
code+='\nexport {readTaskSnapshot,validateTaskSnapshotQuery,mcpResponse,loadBindings,loadOAuthConfig,canonical,branchKey,OwnerCore,suppressTaskSnapshotTrace,encryptProps,wrapKeyWithToken,generateTokenId,safeUrl,__rivuleDisplay};\n';
writeFileSync(new URL('test/worker.node.mjs',root),code);
