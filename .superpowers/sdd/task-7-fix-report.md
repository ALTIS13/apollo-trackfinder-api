# Task 7 Collision-safe Horizontal Fan Report

## Scope

- Replaced the compound horizontal/vertical aggregate fan with one horizontal shared trunk.
- Assigned every crowded branch a distinct horizontal attachment, channel, and target approach track.
- Compressed the shared trunk in narrow corridors so it cannot enter a target card or overlap a terminal status segment.
- Enforced 24-unit module clearance for drag and keyboard moves, including sequential validation of batched moves.
- Made SVG gradient IDs stable per mounted topology instance and injective for edge IDs.
- Rejected duplicate directed `source -> target` relations in the shared dashboard contract.

## Root Causes

- The prior aggregate owner painted a compound path whose linear gradient could not represent both horizontal and vertical contributor bands.
- Fan length was forced to a minimum even when the first target left less physical space.
- Approach tracks were partitioned only inside a target row and could collide with attachments or another row.
- Batched React Flow changes were checked against the positions from before the batch.
- The shared contract allowed two edge IDs to describe the same directed relation, which has no unambiguous physical route.

## TDD Evidence

### RED

- Boundary fixtures reproduced edge-touching cards, narrow corridors, cross-row approach collisions, attachment/approach collisions, batched coincident moves, duplicate directed relations, and positive Q/L segment overlap.
- Review-fix RED: 9 admin failures across five focused files and 1 shared-contract failure.

### GREEN

- Focused admin routing/alignment/rendering: 5 files / 124 passed.
- Full admin dashboard: 15 files / 216 passed.
- Shared admin contract: 1 file / 5 passed.
- API server: 6 files / 109 passed, 1 opt-in Redis test skipped.
- Workspace TypeScript: passed across libraries, all artifacts, and scripts.
- Admin Vite production build: passed, 2560 modules transformed.
- API production build: passed.
- `git diff --check`: passed.

## Browser Validation

- Codex in-app browser preview: `http://127.0.0.1:4186/#topology`.
- Live DOM: 8 modules, 7 female/male contact pairs, 1 shared horizontal trunk, and 3 diagnostic evidence labels.
- Evidence-to-module overlap count is zero; `ERROR DLW-E502` and `WARNING SC-429` remain readable.
- Paired comparison against the reported screenshot confirms the old Download Worker/Search Media loop is absent.
- Screenshot: `C:\Users\maksi\AppData\Local\Temp\apollo-topology-global-routing-final.png`.

## Infrastructure

- HomeNode, Coolify, Caddy, UFW, DNS, Apollo GA, provider credentials, Android, database, and remote runtimes were not changed.

## Review And Commit

- Final independent spec and quality re-reviews: PASS, no findings.
- Feature commit/push and fast-forward merge to `main`: pending.
