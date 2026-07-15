# Admin Topology Alignment and Routing Design

**Date:** 2026-07-15
**Status:** Approved

## Goal

Make draggable topology modules easy to align while keeping every cable, plug, incident label, and aggregate state visually unambiguous. Plugs must sit on straight cable segments away from module edges and bends. Shared routes must use one deterministic opaque gradient instead of overlapping mixed colors.

## Alignment Modes

The topology toolbar gains a compact segmented control:

- `Свободно`: current unrestricted dragging.
- `Выровнять`: snap and guide behavior.

The selected mode is UI-local and does not change runtime topology data. In alignment mode:

- positions snap to the existing 24-unit background grid;
- node centers and corresponding edges magnetically align when within 8 screen pixels at the current zoom;
- temporary horizontal/vertical guides show only during drag;
- keyboard movement uses one grid step, or one pixel-equivalent topology unit with the precision modifier;
- `Сбросить` restores the generated default layout and clears overrides.

Drag completion stores normalized topology coordinates, so zoom level does not alter the saved result. No node moves when the mode is toggled; snapping begins on the next drag/keyboard movement.

## Default Layout

- Horizontal rank separation increases from 84 to 132 topology units.
- Vertical node separation increases from 40 to 56 topology units.
- Existing left-to-right DAG ordering remains stable.
- The fit-view calculation includes plug labels and incident badges, not only node bounds.
- Desktop keeps the full topology visible when practical; narrow screens retain the internal horizontal scroller.

These values create a straight corridor for the plug and label without making the dashboard sparse.

## Route and Plug Geometry

Routes remain orthogonal with rounded bends. Geometry is computed from one canonical polyline used by the neutral conductor, status lane, plug, label, hit target, and tests.

1. Build the route while reserving clearance around source/target terminals.
2. Enumerate horizontal segments and exclude 24 units around each bend plus 28 units around a module terminal.
3. Select the longest eligible segment; ties prefer the segment nearest the geometric route midpoint.
4. Place the female/male pair at the midpoint of that usable interval.
5. Anchor the status/error label directly above the plug center with collision-aware vertical offset.
6. If no interval can fit the plug plus clearances, add or expand an orthogonal corridor. A plug is never placed on a bend or attached directly to a card edge.

The neutral conductor and thin status lane terminate exactly at the outer female/male faces and resume from the opposite faces. Cable and plug share one centerline; no T-junction, overlap, transparent mix, or detached pixel gap is permitted.

## Shared-State Gradient

When multiple branches converge toward one core node:

- the shared trunk has one neutral opaque base;
- one opaque status lane uses a generated linear SVG gradient, never stacked translucent strokes;
- contributors are ordered by their branch attachment position, then stable edge ID;
- each contributor receives a band proportional to its branch count;
- adjacent bands use a short fixed transition zone, clamped so narrow bands remain readable;
- duplicate statuses merge into one wider band;
- the destination terminal and aggregate severity use the worst active status: `degraded`, then `warning`, then `unknown`, then `healthy`;
- adding/removing/reordering unrelated edges cannot change the gradient for an unchanged contributor set.

After a branch split, each route returns to its own solid status lane. All gradient stops are fully opaque and derive from the existing semantic status palette.

## Interaction and Incident Evidence

- Plug hit targets remain larger than the visible body without changing layout.
- Pointer, Enter, and Space select the related service and open the exact incident journal.
- Warning/error labels remain above plugs and use collision lanes so modules cannot cover them.
- Labels show a real diagnostic code only when present; no code is invented.
- Reduced motion removes sparks/traffic animation but preserves geometry, status, and focus.

## Testing

- Pure geometry tests cover grid snapping, magnetic alignment, zoom normalization, route corridor selection, short routes, crossed rows, reverse movement, and reset.
- Invariant tests assert every plug lies on an eligible straight segment, labels do not intersect modules, and conductor endpoints equal plug faces.
- Gradient tests cover one/two/three statuses, duplicate counts, ordering, opacity, worst-severity terminal state, and stability across render cycles.
- Interaction tests cover pointer/keyboard drag, keyboard activation, incident linkage, free/aligned mode switching, and reduced motion.
- Full admin tests, typecheck, production build, and `git diff --check` pass.
- Codex in-app browser QA covers desktop and `390x844`, at fit and zoomed states, with screenshot comparison against the supplied references and zero warning/error console entries.

## Out of Scope

- Changing heartbeat, provider, or incident API contracts.
- Persisting layout to the server or sharing it between operators.
- Modifying HomeNode, Coolify, Caddy, UFW, DNS, TF client, or Android.
