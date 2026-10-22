# Brand image provenance

Checked 2026-10-22. Brand marks identify products, not verified connections or endorsements. No image URL is fetched at runtime. Official assets are pinned as data in `src/owner/brand-identity.mjs`. Plain-text icons are Unicode fallback symbols, not official brand artwork. User-assigned `zot` maps only to source ID `zot-main`; other display names are preserved. Provider `spark` is not mapped to Grok Bot.

## QQ
- Official page: https://im.qq.com/index/
- Image linked by that page: https://static-res.qq.com/static-res/imqq/qq-logo.png
- Original PNG, 62×62, 1167 bytes, SHA256 `ee3ab39d757df98d57d676779b97fb8e20d70c97900976b4ffe239f3b6a54bfe`.
- Vendored unchanged. Tencent brand guideline: https://isux.tencent.com/wp-content/uploads/2016/05/20160512101222609.pdf . This is a trademark, not an asserted open-source license. Preserve appearance; no affiliation implied.
- Plain text: 🐧 QQ.

## Muse
- Official announcement: https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/
- Official design site: https://introducing.muse.ai/
- Page-linked logo: https://introducing.muse.ai/landing/MuseLogo.svg?dpl=dpl_4pF51QxvTzfsLKLJHBfMLSxP2PNW
- Original 2628-byte SVG SHA256 `73bdf6aed3c3a03b2181c69532672554fca8a1d303644c301abb1caf5300d703`.
- Pinned geometry and sRGB gradient unchanged. Removed only inline display-p3 style declarations for renderer compatibility, retaining each original stop-color. SVG has only svg/path/defs/linearGradient/stop, local paint reference, no script, href, event handler or external resource.
- Publicly served product trademark, no open-source license asserted. Product logo does not claim to be the user's customizable personal avatar.

## Unverified assets
- dot: https://help.openai.com/en/articles/20001530-getting-started-with-your-dot describes personalized names and avatars. Do not substitute OpenAI's corporate mark. Current default is an editable personal initial.
- Grok Bot: https://x.ai/bot . Official assets link from https://x.ai/legal/brand-guidelines returned403 at download; no protected-download retry. No official Bot artwork is bundled.
- User spelling Dovue likely means Claude Duet, announced2026-10-21: https://claude.com/resources/articles/claude-duet . Product page https://claude.com/product/claude-duet links https://claude.com/static/claude-duet/app-icon-flat.svg ; direct download returned403, stopped. Exact providers duet/claude-duet have a named symbolic fallback; dovue is not silently aliased. No generic Claude logo substitution or connection implied.

## Rendering constraints
Images are exact-data allowlisted. Dashboard permits only embedded data images, not remote origins; all existing script/style nonce and authentication rules remain. Unknown brand names never inject images or markup. Selecting a brand in the add-column dialog affects only a nonpersistent, disconnected layout preview.

## dot product mark and Rivule
- Official product page: https://chatgpt.com/features/dots/ . Page-linked mark: https://images.ctfassets.net/8su2tbn87fck/PulStHeDuz5begF06sEwk/c2080ae53243122046ba61074a5f0bd2/dots-o-updated.svg . Downloaded unchanged2026-10-22,501bytes,SHA256 `1e351734a2db757f16f367140714cab4c999c5382ef428f914127efe65841ffc`. One inert path, no external resources. This is the official dot product ring, not the OpenAI corporate mark or user's personal avatar.
- Rivule header restores the existing repository design at `docs/showcase/assets/rivule-mark.svg`, SHA256 `f964ad3c015fcbea9cf3662dfead3f7e0cf1682c86c52fa15f8b69d779458f6b`. Embedded unchanged.
