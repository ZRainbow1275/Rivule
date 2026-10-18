# Source availability for the preserved resvg WebAssembly module

The bundled WebAssembly module is an unchanged copy of `@resvg/resvg-wasm` 2.6.2 `index_bg.wasm`, SHA-256 `22bf6e9f9a100d972da0411a69c5ba504367fc1fa87b3b64e3f35e53926d2d70`. Its upstream resvg-js source and resvg/usvg rendering components are made available under MPL-2.0. The accompanying MPL license and third-party notices remain applicable irrespective of Rivule's project license.

Obtain the source without an account at these pinned upstream revisions:

- resvg-js 2.6.2: https://github.com/thx/resvg-js/tree/9ca058462ac529120c8cc84ddcd6fef644cc5406
- resvg, usvg, usvg-parser, usvg-text-layout and usvg-tree used by that build: https://github.com/zimond/resvg/tree/3495d8705b302d6d266748516973606ca9657906
- woff2 fork (Apache-2.0), identified from the binary rather than today's branch tip: https://github.com/yisibl/woff2-rs/tree/88cce4cd07da2c3f35839068c6f73672700cfc8b

Direct source-archive URLs and SHA-256 hashes are recorded in `git-source-inventory.json`; verified copies are retained in the audit's `source-archives/` directory. The exact-version crates recoverable from embedded binary evidence have official crates.io source URLs in `wasm-crate-inventory.json` and `additional-wasm-inventory.json`. Rust toolchain source and notices are recorded in `INVENTORY.json`.

Audit limit: upstream resvg-js excludes Cargo.lock. The checked-in resvg fork lock describes a different resolution and must not be represented as the published WASM lock. Embedded strings prove some versions but cannot prove an exhaustive dependency set. These source links and notices address the identified source-availability gaps; they are not a complete transitive SBOM or an independently verified reproduction of the upstream build.
