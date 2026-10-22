# Workbench and notification update — 2026-10-22

## Delivered behavior

- PA columns center a single source and expand symmetrically as appearance previews are added.
- Desktop layout reserves space for the bottom settings dock and scrolls task details inside the card.
- Provider identity and display alias are separate: the configured source is dot; its default alias is zot.
- Bounded names and custom icons persist in this browser. Credentials and task snapshots are excluded from appearance storage.
- The existing Rivule mark and verified official dot, QQ, and Muse images are bundled locally. Asset provenance is in `../brand-assets.md`.
- Current, source-bound verification evidence controls the configured PA's color. Missing evidence stays neutral; stale or blocked states use a reduced-motion-aware warning treatment.
- QQ producer state is displayed separately from PA identity and message receipts.
- Notifications use distinct progress, blocked, and completed treatments. Routine queued progress coalesces within its branch; actionable and terminal updates retain priority.
- QQ text is capped at 4,000 UTF-16 units. Identity, action, blocker and the original legacy source link are retained before shortening a summary.

## Verification

- Combined source, authentication, state, storage, brand and notification suite: 59 passing tests after the accessibility/copy follow-up.
- Source/configuration checks and owner/gateway build pass.
- Desktop browser at 1180 × 757: document height 757; single-card center 590; two- and three-card layouts fit symmetrically; dock clearance 26 pixels.
- Official icons, local preview controls, reduced motion, Escape/focus return, and alias persistence were exercised in the deployed browser.
- The follow-up fixes the restored alias's accessible icon label and removes redundant status annotations.

## Acceptance still needed

- Owner's authenticated task display.
- Mobile viewport and device testing.
- Actual new Discord/QQ notification appearance in the receiving clients.

No test notification or old-event replay was issued for this visual update. Existing deployment bindings, authentication grants, storage namespaces and runtime settings were preserved.

Package version remains 0.4.4; these source updates do not introduce a new release tag. Deployment uses the existing Wrangler route.
