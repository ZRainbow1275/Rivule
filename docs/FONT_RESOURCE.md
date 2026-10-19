# Font resource

Run `node scripts/install-font.mjs` before building. It downloads the pinned Noto Sans CJK SC 2.004 font from the official repository:

https://raw.githubusercontent.com/notofonts/noto-cjk/Sans2.004/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf

Official input SHA-256: `2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b`

Transformed output SHA-256: `5d36f5998816d44aeb5dcf5cd2b9a0f01f25bfc31d84b79e4ab5c007a9120ddf`

The installer applies `scripts/font-repack.json`: DSIG is omitted, table layout is specified, and 50 header/CFF metadata bytes are transformed. Glyphs are neither synthesized nor subsetted. Both input and output integrity checks are mandatory; an unexpected file or interrupted download must fail before installation. No separate font-conversion tool is needed.

The font retains OFL-1.1, Adobe copyright and Noto trademark notices. Rivule's AGPL-3.0 license does not replace the font license. The font is downloaded locally rather than included in the source repository.
