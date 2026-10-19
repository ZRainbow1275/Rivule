# Source availability for resvg WebAssembly

The application uses the unchanged `@resvg/resvg-wasm` 2.6.2 `index_bg.wasm` from the locked npm package. SHA-256: `22bf6e9f9a100d972da0411a69c5ba504367fc1fa87b3b64e3f35e53926d2d70`. It is downloaded during local dependency installation rather than included in this repository. Its MPL-2.0 terms and component notices remain applicable independently of Rivule's project license.

Pinned upstream source:

- resvg-js: https://github.com/thx/resvg-js/tree/9ca058462ac529120c8cc84ddcd6fef644cc5406
- resvg, usvg and rendering components: https://github.com/zimond/resvg/tree/3495d8705b302d6d266748516973606ca9657906
- woff2 fork (Apache-2.0): https://github.com/yisibl/woff2-rs/tree/88cce4cd07da2c3f35839068c6f73672700cfc8b

`COMPILED_INVENTORY.json` contains official source archive URLs, integrity hashes, identified crate versions, Rust toolchain source and local notice paths. Corresponding license and copyright texts are retained under `compiled-components/`.

Completeness limitation: upstream resvg-js does not publish the Cargo.lock used for this binary. The resvg fork's checked-in lock describes a different dependency resolution. Known component versions and source URLs do not establish an exhaustive dependency set or a reproducible upstream build. This inventory is therefore not a complete transitive software bill of materials.
