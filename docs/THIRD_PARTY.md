# Third-party materials

- Noto Sans CJK SC: the font is a full-face TTC extraction/repackaging, version 2.004; corrected Adobe 2014–2021 copyright and OFL-1.1 are retained under third-party-licenses/compiled-components/noto-sans-cjk. The older Debian packaging notice is historical and is not the sole font attribution.
- resvg WebAssembly: bundled upstream @resvg/resvg-wasm license is in third-party-licenses. Other retained runtime licenses include Cloudflare Workers OAuth Provider, MCP SDK, jose and zod. This is an initial inventory, not a completed transitive bundle license audit.
- Muse / Gemini Spark: this public variant includes original blue M/S badges and product-name text only. Official product artwork has been removed from all public display inputs, compiled modules, generated test workers and reverse operations. See PUBLIC_ASSET_TRANSFORM.json and local-candidate/cloudflare/SOURCE_ICONS.md. No endorsement is implied.
- Zot: a custom letter badge, not an OpenAI or ChatGPT logo.

No new license grant is inferred from a vendor's public download or product page. Third-party brand assets are not covered by any future Rivule code license.

## Verified WebAssembly provenance

The preserved WebAssembly module is byte-identical to the installed @resvg/resvg-wasm 2.6.2 index_bg.wasm: SHA-256 22bf6e9f9a100d972da0411a69c5ba504367fc1fa87b3b64e3f35e53926d2d70. The public repository does not vendor that binary; rebuild.mjs obtains it from the locked npm package after installation and checks the exact hash. Its package declares MPL-2.0, not MIT. The upstream v2.6.2 license was retrieved from https://raw.githubusercontent.com/thx/resvg-js/v2.6.2/LICENSE and retained. Corresponding upstream source: https://github.com/thx/resvg-js/tree/v2.6.2 .

The marker inventory identifies 11 bundled JavaScript packages and retains their top-level notices. This inventory does not yet enumerate every Rust dependency compiled into the upstream WASM. Complete that inventory and source-availability review before claiming public-release license completeness. The Rivule AGPL-3.0 license does not relicense these third-party files.

Pinned compiled-component source references and 91 collected notices are under third-party-licenses/compiled-components and COMPILED_SOURCE_AVAILABILITY.md. The public package does not contain the WASM binary; the dependency completeness limits are documented rather than represented as legal clearance.
