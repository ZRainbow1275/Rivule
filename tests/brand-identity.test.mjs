import test from 'node:test';
import assert from 'node:assert/strict';
import { BRAND_IMAGES, sourceBrand, knownBrandImage } from '../src/owner/brand-identity.mjs';
import { ownerDashboardHtml } from '../src/owner/presentation.mjs';
test('only exact pinned official images are accepted', () => {
 for (const image of Object.values(BRAND_IMAGES)) { assert.ok(knownBrandImage(image)); assert.ok(image.length < 8192); }
 assert.equal(knownBrandImage('https://example.org/logo.svg'), false);
 assert.equal(knownBrandImage('data:image/svg+xml,<svg onload="evil()"/>'), false);
 const svg = Buffer.from(BRAND_IMAGES.muse.split(',')[1], 'base64').toString();
 assert.doesNotMatch(svg, /<script|href=|onload|foreignObject|style=/i);
 assert.match(svg, /linearGradient/);
});
test('source identity is explicit, custom names preserved and unknowns not guessed', () => {
 assert.equal(sourceBrand({source_id:'zot-main',provider:'dot',display_name:'Zot'}).name, 'zot');
 assert.equal(sourceBrand({provider:'dot',display_name:'Ada'}).name, 'Ada');
 assert.equal(sourceBrand({provider:'spark',display_name:'Grok Bot'}).iconData, undefined);
 assert.equal(sourceBrand({provider:'unknown',display_name:'Muse'}).iconData, undefined);
 assert.equal(sourceBrand({provider:'muse'}).iconData, BRAND_IMAGES.muse);
 assert.equal(sourceBrand({provider:'qq'}).emoji, '🐧');
 assert.equal(sourceBrand({provider:'constructor'}).iconData, undefined);
 assert.equal(sourceBrand({provider:'__proto__'}).iconData, undefined);
});
test('frontend offers explicit official local-preview icons without remote image loading', () => {
 const html=ownerDashboardHtml('nonce');
 assert.match(html, /id="zot-name">zot</);
 assert.match(html, /<option value="qq">QQ · 官方企鹅<\/option>/);
 assert.match(html, /<option value="muse">Muse · 官方图标<\/option>/);
 assert.doesNotMatch(html, /<\/option\s+[^>]/);
 assert.match(html, /QQ · 官方企鹅/); assert.match(html, /Muse · 官方图标/);
 assert.match(html, /预览 · 未连接/); assert.doesNotMatch(html, /https?:\/\//);
});
