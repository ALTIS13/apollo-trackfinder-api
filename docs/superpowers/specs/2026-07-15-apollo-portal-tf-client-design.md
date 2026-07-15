# Apollo Portal and TF Client Zone Design

**Date:** 2026-07-15
**Status:** Approved

## Goal

Replace the outdated marketing-oriented web experience with an operational Apollo brand portal and a usable closed-beta Apollo TF client. The visual language extends the accepted admin dashboard: near-black neutral workspace, compact information hierarchy, restrained transparency, 6-8 px radii, semantic status colors, and clear typography. It does not use decorative gradients, floating section cards, oversized marketing copy, or a news feed.

## Information Architecture

### `apollot.ru`

- Public project overview: Apollo TF and Apollo GA, current release, beta state, and latest changelog entries.
- Registration state: closed, invitation-only, or open with approval.
- Sign in, register/redeem invite, pending/suspended status, and recovery flows.
- Authenticated dashboard: available projects, module access, account state, recent releases, and changelog.
- Account: profile, security/sessions, project access, integrations summary, preferences, data/privacy, and sign out.

### `tf.apollot.ru`

- Search: the first operational screen, with provider-aware results and playback actions.
- Collection: likes, playlists, and history.
- Queue: one canonical queue, not duplicated in the sidebar.
- Player: persistent compact bottom player with stable dimensions.
- Integrations: moved out of Favorites into account/settings context.
- Access: contextual locked states for unavailable capabilities.

No public news feed is created. Changelog is release-linked and filterable by project/version.

## Portal Layout

The Apollo name is the first-viewport signal. A compact top bar contains brand, project switcher, environment/beta state, and account actions. The content is an unframed dashboard band, not a marketing hero.

Authenticated users see four compact summary modules: available projects, active capabilities, newest accessible release, and account status. Below them, a project/version table and changelog occupy the main column; registration/access status occupies a restrained side rail on wide screens and becomes a full-width section on mobile.

Project cards are used only for repeated Apollo projects. Each shows a real brand mark/cover asset, current version, access state, health freshness, and one primary action. Locked projects explain the required access without exposing internal container names.

## TF Layout

The existing dark palette, typography, bottom player, and component primitives are retained where they meet the accepted design. The oversized `Find any track` hero is removed. Search input, source filters, recent queries, and results begin in the first viewport.

Desktop uses a restrained navigation rail and a content workspace. Mobile uses a drawer or compact bottom navigation without duplicating the player queue. All fixed controls have stable responsive dimensions; result rows, provider status, long track titles, and button text wrap or truncate without overlap.

User-facing capability names are:

- `Поиск и воспроизведение`
- `Подключение музыкальных сервисов`
- `Загрузки`
- `Коллекция`

Internal keys remain in diagnostics/admin only.

## States and Data Flow

- `loading`: skeletons preserve final layout dimensions.
- `empty`: actionable state specific to search, collection, queue, integrations, or changelog.
- `locked`: shows the unavailable capability and account-access destination; no fake upgrade/payment CTA.
- `pending`: explains that operator approval is required and refreshes status without polling aggressively.
- `offline/stale`: distinguishes unavailable API from old last-known module data.
- `provider disconnected/degraded`: does not mark the entire account unavailable.

The web client fetches `/me` and entitlement state through its backend session. Navigation may hide irrelevant actions, but direct routes still render a truthful locked state and the API remains authoritative. Search and download progress use authenticated WebSocket tickets rather than query-string session IDs.

## Accessibility and Motion

- Keyboard-visible focus, semantic headings, labels, tables, dialogs, and status text accompany color.
- Icon-only commands use the installed icon library and tooltips.
- Contrast meets WCAG AA for body text and controls.
- Motion is limited to state transitions, topology traffic, and focused feedback; `prefers-reduced-motion` removes nonessential movement.
- Transparency is used only where content remains legible; no blurred text/background dependence.

## Visual Validation

Before implementation is accepted, the existing screenshots and the new routes are captured at matching desktop/mobile viewports and compared together. QA checks hierarchy, spacing, radii, typography, overflow, player stability, locked/pending states, keyboard navigation, and console output. The in-app browser is the approved review surface.

## Testing

- Route tests cover unauthenticated, pending, active, suspended, and locked-entitlement navigation.
- Component tests cover summaries, project/release/changelog data, search states, player/queue stability, integration relocation, and access messages.
- Browser tests cover invite registration through TF entry, account settings, search/playback, entitlement revocation, mobile navigation, and reduced motion.
- Accessibility checks include automated scans plus keyboard-only primary flows.
- Production build and bundle analysis must identify, and where practical split, the current oversized web chunk.

## Out of Scope

- Android layouts or APK packaging.
- Public news, social timelines, billing, advertising, or an open plugin marketplace.
- Replacing the accepted admin topology visual language with an unrelated brand system.
