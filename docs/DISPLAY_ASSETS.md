# Display assets and local customization

## Default public build

Muse and Gemini Spark use original blue M/S letter badges, alongside the product names. The M SVG and S SVG are in assets/. Zot uses the existing original Z badge. These badges are not official vendor marks. The two source-icons.ts files are build-time inputs, never event data.

scripts/neutralize-display-inputs.mjs is the deterministic, idempotent transformation. It accepts only the two pinned historical asset-value hashes or their pinned original replacements. Removed image bytes are neither embedded in that script nor required to build this package. The shipped baseline has been scanned; the later overlays and patch-operation records are rebuilt using sanitized inputs. No public reverse operation restores removed art.

The final whole owner module is compared to the private readable provenance after replacing exactly its MUSE_ICON_DATA and SPARK_PATHS declarations with fixed audit sentinels. The pinned normalized SHA proves that the rest of the module is byte-identical. This is asset-only equivalence, not an exact production-byte claim. scripts/verify-neutral-assets.mjs checks the normalized hash, neutral payload allowlist and unchanged QQ gateway. PROVENANCE.json verifies the public files.

## User-owned or authorized local icons

A deployment owner may maintain a separate, clearly named custom-artwork fork. The supported extension point is the two local display modules:

- local-candidate/cloudflare/src/source-icons.ts
- production-readable-ui-candidate-20261018/src/source-icons.ts

Replace MUSE_ICON_DATA and/or SPARK_PATHS there with the same locally supplied, appropriately licensed artwork in both files. MUSE_ICON_DATA is a self-contained data URI; SPARK_PATHS is static SVG geometry designed for a 66×66 viewbox. Keep the provider IDs, sourceIcon signature and source-name text unchanged. The deployment owner is responsible for artwork rights, attribution and any trademark conditions.

This is an intentional source-level customization, not a runtime setting. Never accept SVG/image bytes from task events, add remote image fetches, permit scripts or external SVG references, or place credentials in artwork. Prefer simple local paths/geometry. Existing renderer safety checks remain enabled.

The default build deliberately rejects different artwork. In a custom fork, explicitly replace the neutralization step with your reviewed local-asset transformation and change the variant name and approved asset-value hashes in PUBLIC_ASSET_TRANSFORM.json. Do not weaken the URI checks to permit arbitrary data or untrusted hosts. Rebuild stage by stage, re-pin the display and snapshot baseline hashes in their build scripts, update the readability test baseline, then update the final public and normalized hashes and PROVENANCE.json for that fork. Preserve the original upstream provenance as historical references; never claim that a customized module is the neutral release or the exact deployed module.

Run the full snapshot, readability, QQ and active-probe tests and inspect rendered previews before deployment. The normal identity, authentication, source-verification and permission checks must not change merely because artwork changes. This process does not create runtime uploads, remote image loading or new network credentials.
