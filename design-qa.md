# Apollo TF Admin Dashboard Design QA

## Evidence

- Source visual truth: `C:\Users\maksi\.codex\generated_images\019ef2c2-95cb-7d01-9951-aa0abfe25d37\exec-37cf8f7e-5782-4788-b291-4e730547aec4.png` (accepted concept 2) and `C:\Users\maksi\AppData\Local\Temp\codex-clipboard-47633318-4a20-45fe-b997-f5de705a7279.png` (connector reference).
- Browser-rendered implementation: `C:\Users\maksi\AppData\Local\Temp\apollo-admin-connectors-desktop-final.png`.
- Scrolled document-flow evidence: `C:\Users\maksi\AppData\Local\Temp\apollo-admin-connectors-scrolled-final.png`.
- Mobile evidence: `C:\Users\maksi\AppData\Local\Temp\apollo-admin-connectors-mobile-final.png`.
- Viewports: `1536x1024` desktop and `390x844` mobile.
- State: dark theme, topology view, deterministic demo snapshot; desktop also checked after navigating to providers.

## Full-View Comparison

- The accepted composition remains intact: a dark neutral application shell, compact sidebar, four summary modules, primary topology workspace, incident rail, and operational tables below.
- The implementation is intentionally denser than the generated concept so the provider table remains fully visible at the desktop reference viewport. This does not change the reading order or hierarchy.
- The incident rail ends at the same vertical boundary as the topology. It remains in document flow when scrolling and does not overlap the provider or deployment modules.

## Focused Connector Comparison

- The supplied reference was compared directly with the rendered topology connectors because the contact geometry is too small to judge reliably in the full dashboard view.
- The implementation preserves straight constant-width rails, a squared female receiving notch, and a stepped male tongue. Only the semantic state colors differ intentionally from the monochrome reference.
- Outer rail endpoints remain attached to their service-edge paths in every status; only the inner contact opens for warning, degraded, and unknown states.
- Browser geometry verification confirmed both outer endpoints of every demo connector lie on a horizontal route segment, including the two bent Core API edges; the target-side endpoint reaches the target module handle.

## Fidelity Surfaces

- Fonts and typography: Outfit and Plus Jakarta Sans preserve the accepted compact operational hierarchy; tabular numeric labels remain readable without negative letter spacing.
- Spacing and layout rhythm: the topology/incident row and full-width details row align on a 12 px grid; panel radii and borders remain consistent; no page-level overlap or hidden provider rows were observed.
- Colors and tokens: near-black neutral surfaces, restrained violet selection, and redundant green/amber/red/gray status colors match the approved direction and maintain operational semantics.
- Image and asset fidelity: the source mock contains no required product imagery. Lucide icons are used for interface actions. The connector is a functional topology visualization derived from the supplied reference, not a decorative replacement asset.
- Copy and content: generated placeholder text is replaced with concise Russian operational labels and deterministic diagnostic evidence. Error codes are rendered only when supplied by the snapshot.

## Primary Interactions Tested

- Node focus and topology reset.
- Connector activation by pointer, Enter, and Space.
- Exact incident expansion with `DLW-E502` and sanitized journal excerpt.
- Incident with no diagnostic code does not invent a code.
- Provider navigation and page scrolling keep the incident rail in normal document flow.
- Reduced-motion mode preserves status evidence while removing warning flicker.

## Console And Responsive Checks

- A fresh Codex in-app browser tab reported no console warnings or errors.
- Desktop `1536x1024`: no overlap; topology and incident bottoms align; all provider rows are visible.
- Mobile `390x844`: summary remains first, topology uses its internal horizontal scroller, and incidents move below without overlap.

## Findings

- No actionable P0, P1, or P2 findings remain.
- P3: connector rails are more compact than the reference because they must remain legible without obscuring dense topology routes. This is an intentional scale adaptation.

## Comparison History

1. Initial callout/synchronization-line treatment did not communicate physical contact loss. It was replaced with a two-part connector and re-captured.
2. The first connector pair was too bulky and tapered. It was replaced with straight female/male rails, squared notch/tongue geometry, and fixed outer attachment points.
3. The incident rail and detail tables exceeded the desktop viewport. Topology height, panel headers, and table spacing were compacted; details moved to a full-width row.
4. The incident rail remained sticky and could move over lower modules. Sticky positioning and incident hover styling were removed; post-fix evidence is in the final desktop and scrolled screenshots above.
5. Independent code review found bent-edge detachment, weak edge-to-incident validation, mask ID collisions, and long-code overflow. Connector length/placement, schema invariants, unique IDs, truncation, custom-adapter defense, and regression tests were added; the post-fix browser geometry check covers every demo edge and the final re-review has no actionable findings.

## Implementation Checklist

- [x] Approved concept 2 structure retained with concept 1 summary modules.
- [x] Reference-driven female/male contact geometry implemented.
- [x] Incident rail is static, topology-aligned, and internally scrollable only when needed.
- [x] Provider table is visible at the desktop reference viewport.
- [x] Pointer, keyboard, reduced-motion, responsive, and console checks completed.

final result: passed
