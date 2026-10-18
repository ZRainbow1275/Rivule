import {spawnSync} from 'node:child_process';
import {mkdirSync,copyFileSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const fontPlan=JSON.parse(readFileSync(root+'scripts/font-repack.json'));
let font;try {font=readFileSync(root+fontPlan.output_path);} catch {throw Error('Pinned font missing. Run node scripts/install-font.mjs first.');}
if(createHash('sha256').update(font).digest('hex')!==fontPlan.output_sha256)throw Error('Pinned font integrity mismatch; build stopped.');
const wasmSource=root+'local-candidate/cloudflare/node_modules/@resvg/resvg-wasm/index_bg.wasm';
let wasm;try {wasm=readFileSync(wasmSource);} catch {throw Error('Pinned resvg WASM missing. Run npm ci in local-candidate/cloudflare; do not substitute a download or rebuild.');}
if(createHash('sha256').update(wasm).digest('hex')!=='22bf6e9f9a100d972da0411a69c5ba504367fc1fa87b3b64e3f35e53926d2d70')throw Error('Pinned resvg WASM integrity mismatch; build stopped.');
copyFileSync(wasmSource,root+'production-readonly-20261018/bbbot-pa-terminal/modules/dd4dd8881e2df4e64203b5c0ae65e1648ab55207-index_bg.wasm');
function run(cwd,args){const r=spawnSync(process.execPath,args,{cwd:root+cwd,stdio:'inherit'});if(r.status!==0)process.exit(r.status??1);}
run('', ['scripts/neutralize-display-inputs.mjs']);
mkdirSync(root+'production-readonly-task-candidate-20261018/validation',{recursive:true});
run('production-ui-candidate-20261018',['build-ui-overlay.mjs']);
run('production-readonly-task-candidate-20261018',['build-candidate.mjs']);
run('production-readonly-task-candidate-20261018',['test/prepare-node.mjs']);
run('production-readonly-task-candidate-20261018',['--test','test/snapshot.test.mjs']);
mkdirSync(root+'production-readable-ui-candidate-20261018/modules',{recursive:true});
mkdirSync(root+'production-readable-ui-candidate-20261018/preview',{recursive:true});
copyFileSync(root+'production-ui-candidate-20261018/display-only.patch.js',root+'production-readable-ui-candidate-20261018/baseline-display.patch.js');
run('production-readable-ui-candidate-20261018',['build-candidate.mjs']);
run('production-readable-ui-candidate-20261018',['test/prepare-node.mjs']);
run('production-readable-ui-candidate-20261018',['--test','test/snapshot.test.mjs','test/readability.test.mjs']);
run('production-readable-ui-candidate-20261018',['test/run-workerd.mjs']);
run('production-qq-error-candidate-20261018',['build-error-patch.mjs']);
run('production-qq-error-candidate-20261018',['--test','verify-error-patch.test.mjs']);

copyFileSync(root+'production-readonly-20261018/bbbot-qq-gateway/modules/SHA256SUMS.txt',root+'production-qq-error-candidate-20261018/modules/SHA256SUMS.txt');

run('production-qq-active-probe-candidate-20261018',['build-candidate.mjs']);
run('production-qq-active-probe-candidate-20261018',['--test','test/active-probe.test.mjs','test/renewal.test.mjs','test/prior-diagnostics-regression.test.mjs']);

run('', ['scripts/verify-neutral-assets.mjs']);
