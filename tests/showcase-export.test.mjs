import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
test('static export preserves navigation and pins documentation to the source revision', () => {
  execFileSync(process.execPath, ['scripts/build-showcase.mjs'], { cwd: root });
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const output = resolve(root, 'dist/showcase');
  let documentationLinks = 0;
  for (const name of ['index.html', 'start.html']) {
    const html = readFileSync(resolve(output, name), 'utf8');
    for (const [, value] of html.matchAll(/(?:href|src)="([^"]*)"/g)) {
      assert.ok(!value.startsWith('../'), `${name}: ${value}`);
      if (value.startsWith(`https://github.com/ZRainbow1275/Rivule/blob/`)) {
        assert.ok(value.startsWith(`https://github.com/ZRainbow1275/Rivule/blob/${revision}/`));
        documentationLinks++;
      }
      if (/^[a-z]+:/.test(value)) continue;
      const [path, fragment] = value.split('#');
      const target = resolve(output, path || name);
      assert.ok(existsSync(target), `${name}: missing ${value}`);
      if (fragment && target.endsWith('.html')) assert.ok(readFileSync(target, 'utf8').includes(`id="${fragment}"`), value);
    }
  }
  assert.ok(documentationLinks >= 15);
  assert.match(readFileSync(resolve(output, 'index.html'), 'utf8'), /虚构示例，不连接实时服务/);
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['build:showcase'], 'node scripts/build-showcase.mjs');
  assert.match(readFileSync(resolve(root, 'README.md'), 'utf8'), /npm run build:showcase/);
});
