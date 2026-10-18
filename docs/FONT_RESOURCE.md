# Pinned official font installation

Run `node scripts/install-font.mjs` before rebuilding. The installer fetches only:

https://raw.githubusercontent.com/notofonts/noto-cjk/Sans2.004/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf

Input SHA-256: `2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b`

Output SHA-256: `5d36f5998816d44aeb5dcf5cd2b9a0f01f25bfc31d84b79e4ab5c007a9120ddf`

The official Noto Sans CJK SC 2.004 font is repackaged to reproduce the previously verified full-face resource: DSIG omitted, table order/layout preserved from that resource, 50 explicit header/CFF metadata bytes transformed. The transformation descriptor is scripts/font-repack.json. It does not synthesize or subset glyphs. Both SHA checks are mandatory; wrong versions, corrupt input and offline downloads fail clearly before output installation. No Python or font conversion tool is required. The output is written atomically after verification.

Font remains OFL-1.1 with Adobe copyright and Noto trademark notices retained in third-party-licenses. Project AGPL-3.0 does not replace the font license.
