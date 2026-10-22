import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = resolve(root, 'docs/showcase');
const output = resolve(root, 'dist/showcase');
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('A checked-out Git revision is required.');
const repository = `https://github.com/ZRainbow1275/Rivule/blob/${revision}/`;
mkdirSync(output, { recursive: true });
for (const name of ['index.html', 'start.html']) {
  const html = readFileSync(resolve(source, name), 'utf8').replace(/href="(\.\.\/[^"?#]+)(#[^"]*)?"/g, (_, path, fragment = '') => {
    const target = resolve(source, path);
    if (!target.startsWith(root) || !existsSync(target)) throw new Error(`Invalid documentation link: ${path}`);
    return `href="${repository}${target.slice(root.length).split(sep).join('/')}${fragment}"`;
  });
  writeFileSync(resolve(output, name), html);
}
for (const name of ['style.css', 'start.css', 'script.js', 'start.js', 'assets/rivule-mark.svg', 'assets/rivule-banner.svg']) {
  const target = resolve(output, name);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(resolve(source, name), target);
}
console.log('Built static demo in dist/showcase/. No service connection, deployment, or notifications.');
