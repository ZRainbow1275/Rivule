import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const source = resolve(root, 'docs/showcase');
const output = resolve(root, 'dist/showcase');
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let top, revision;
try { top = realpathSync(git(['rev-parse', '--show-toplevel'])); } catch {
  throw new Error('Showcase export needs a Rivule Git checkout. Source archives without Git metadata cannot supply a documentation revision.');
}
if (top !== root) throw new Error('Showcase source is inside another Git checkout. Refusing to link Rivule documentation to the outer repository revision.');
try { revision = git(['rev-parse', '--verify', 'HEAD^{commit}']); } catch {
  throw new Error('A checked-out Git commit is required. No showcase files were written.');
}
if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('A checked-out Git revision is required.');
const repository = `https://github.com/ZRainbow1275/Rivule/blob/${revision}/`;
const docs = new Set(), pages = new Map();
const assetNames = ['style.css', 'start.css', 'script.js', 'start.js', 'assets/rivule-mark.svg', 'assets/rivule-banner.svg'];
function requireFile(path) {
  if (!path.startsWith(root + sep) || !existsSync(path) || !statSync(path).isFile() || realpathSync(path) !== path) throw new Error(`Invalid showcase input: ${relative(root,path)}`);
}
for (const name of ['index.html', 'start.html']) {
  const page = resolve(source, name); requireFile(page);
  const html = readFileSync(page, 'utf8').replace(/href="(\.\.\/[^"?#]+)(#[^"]*)?"/g, (_, path, fragment = '') => {
    const target = resolve(source, path);
    requireFile(target);
    const relativePath = relative(root, target).split(sep).join('/');
    docs.add(relativePath);
    return `href="${repository}${relativePath}${fragment}"`;
  });
  pages.set(name, html);
}
for (const name of assetNames) requireFile(resolve(source, name));
for (const path of docs) {
  let kind;
  try { kind = git(['cat-file', '-t', revision + ':' + path]); } catch {}
  if (kind !== 'blob') throw new Error(`Documentation is absent from the selected revision: ${path}`);
}
if (docs.size) {
  const check = spawnSync('git', ['--literal-pathspecs', 'diff', '--quiet', '--no-ext-diff', '--no-textconv', revision, '--', ...docs], {cwd: root});
  if (check.status !== 0) throw new Error(check.status === 1 ? 'Linked documentation differs from the selected commit. Export the matching checkout; no showcase files were written.' : 'Could not verify linked documentation against the selected commit.');
}
// Only write output after both pages, every bundled asset, and linked documents pass preflight.
mkdirSync(output, { recursive: true });
for (const [name, html] of pages) writeFileSync(resolve(output, name), html);
for (const name of assetNames) {
  const target = resolve(output, name);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(resolve(source, name), target);
}
console.log('Built static demo in dist/showcase/. No service connection, deployment, or notifications.');
