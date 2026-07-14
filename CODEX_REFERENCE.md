# Codex reference for Apollo TF

Last updated: 2026-07-14.

## Project context

Apollo Track Finder (Apollo TF) is a pnpm workspace for a music search/player system:

- `artifacts/api-server`: Express API for search, streaming, Spotify/Yandex integrations, cache, database access.
- `artifacts/music-player`: React/Vite web player.
- `artifacts/trackfinder-mobile`: current Expo/React Native mobile client. Expo Go/static deployment was retired by owner decision on 2026-07-14; the target delivery artifact is an Android APK validated through ADB.
- `lib/api-spec`: OpenAPI source of truth. Do not edit this directory casually; update generated clients through the established API generation flow.
- `lib/api-client-react`, `lib/api-zod`, `lib/db`: shared clients, validation, and database packages.

GitHub repository: `https://github.com/ALTIS13/apollo-trackfinder-api`.
Local checkout remote `origin` points to that repo. Do not print credential-bearing remote URLs.

## Authorization and safety boundaries

- The owner explicitly authorizes Codex to use the available tools, installed plugins, skills, parallel agents, and to install project dependencies or relevant plugins needed to complete Apollo TF work.
- Full tool access is a capability grant, not permission to exceed the active task. User instructions, repository scope, production safeguards, and tool-specific safety rules still apply.
- This authorization includes controlled HomeNode work when the active request requires it, but every infrastructure task starts with read-only inspection.
- Do not expose credentials, private keys, OAuth secrets, Git remote tokens, or private infrastructure data in logs, commits, screenshots, or public documentation.
- `.ops-private/` is the local-only location for SSH metadata, infrastructure inventory, DNS drafts, and other private operations notes. The entire directory is ignored by Git.
- HomeNode changes require a read-only inspection first, an impact assessment against running services, a rollback path, and targeted validation. Destructive operations, production restarts, firewall changes, migrations, and configuration replacement still require explicit confirmation immediately before execution.
- Installing a dependency does not imply enabling it in production. New dependencies must be justified by the active feature, checked for project compatibility, and recorded in the relevant lockfile.

## Git workflow

- The default local and remote branch is `main`; the previous local `master` branch was renamed on 2026-07-14.
- Small, low-risk maintenance and documentation changes may be committed directly to `main` after validation.
- Serious feature, architecture, deployment, authentication, database, or broad UI changes use a dedicated branch named `codex/<logical-name>`.
- Feature branches must pass their relevant typecheck, build, tests, container checks, and UI verification before review and merge into `main`.
- Keep commits focused and use conventional prefixes such as `feat:`, `fix:`, `docs:`, `chore:`, and `refactor:`.

## Android workflow

- Two physical Android devices are available through ADB and must be used for release-candidate smoke testing.
- Android SDK and ADB are installed locally. Verify Java/Gradle compatibility before pinning the APK build pipeline.
- Do not use Expo Go or the custom `static-build` path as release validation.
- The current code still depends on Expo packages. Before implementation, explicitly choose between retaining Expo modules with native Gradle/prebuild or migrating to bare React Native; do not blur those two scopes.

## Required status output

For substantive work, finish with this shape:

```text
Что сделано
- ...

Validation
- ...

Commit/push
- ...

Следующий логичный этап реализации
- ...
```

Add short sections such as `Risks`, `Notes`, or `Blocked` when useful.

## Tool availability snapshot

Tool endpoints vary between the main agent, sub-agents, installed plugin versions, and future sessions. This document records stable capability groups; cache presence alone never proves that a tool is callable.

- `functions.shell_command`: run PowerShell commands in the workspace.
- `functions.apply_patch`: edit files through patches.
- `functions.update_plan`: keep implementation stages visible.
- Multi-agent tools: spawn, wait, message, resume, and close independent agents. Spawn and parallel execution were verified in this project.
- Remote SSH tools: list/test configured hosts, run read-only commands, inspect files/directories/logs, inspect Git workspaces, and perform narrow writes where host policy allows. Access to the designated HomeNode was verified; connection details remain private.
- GitHub connector: repository, branch, commit, issue, pull request, review, workflow, and artifact operations. Local `gh` authentication and connector availability were verified for account `ALTIS13`; `origin` uses a credential-free HTTPS URL.
- Browser/Playwright tools: navigate, inspect, interact, capture screenshots, and validate responsive UI in the in-app browser.
- `web.run`: browse/search when information may be current, unstable, or explicitly requested.
- `image_gen.imagegen`: generate or edit raster images.
- Figma tools: inspect design files, capture nodes, generate diagrams/designs, and maintain Code Connect mappings when a Figma target is provided.
- `codex_app.load_workspace_dependencies`: locate bundled runtimes/libraries for docs, sheets, slides, PDFs.
- `codex_app.read_thread_terminal`: read current app terminal output.
- `functions.view_image`: inspect local images.
- Document, PDF, presentation, spreadsheet, visualization, automation, and thread-management tools are available through their corresponding plugins/connectors.

## Available plugin groups

- OpenAI bundled: browser, Chrome, computer-use.
- OpenAI primary runtime: documents, spreadsheets, presentations, PDF, template creator.
- GitHub: repository, PR, issue, CI, publish workflows.
- Build Web Apps: frontend app builder, frontend debugging, React/Next best practices, shadcn, Stripe, Supabase/Postgres.
- Build Web Data Visualization: chart, dashboard, diagram, geospatial, Gantt, scrollytelling, Three.js, D3, Canvas2D, accessibility, reports.
- Product Design: context, research, audit, ideation, prototype, image-to-code, URL-to-code, design QA, share.
- Creative Production: positioning, mood boards, scenes, offers, ads, shots, logos, polish.
- Data Analytics: KPI/reporting/diagnostics/dashboard/report/market sizing/data quality/validation.
- Codex Security: scans, diff scans, threat modeling, validation, attack paths, fixing/tracking findings.
- Supabase.
- Superpowers workflow skills.
- Remote SSH.

Additional current plugin families:

- Build iOS Apps: App Intents, simulator debugging/browser, ETTrace, memgraph leaks, Liquid Glass, SwiftUI patterns/performance/refactoring.
- Build macOS Apps: build/debug, AppKit interop, SwiftPM, signing, packaging/notarization, telemetry, tests, windows, SwiftUI patterns/refactoring.
- Figma: design generation, diagrams, library generation, Code Connect, SwiftUI mapping, motion, FigJam, and Slides.
- Template Creator and Visualize.

## Available skills

This is the active catalog advertised to the main agent on 2026-07-14. Plugin routers may load additional internal helper skills. Old duplicate versions can remain in the disk cache and are not treated as active.

- Core: `imagegen`, `openai-docs`, `plugin-creator`, `skill-creator`, `skill-installer`, `ga-reference-ui`, `playwright`.
- Browser and desktop: `browser:control-in-app-browser`, `chrome:control-chrome`, `computer-use:computer-use`, `visualize:visualize`.
- Build Web Apps: `frontend-app-builder`, `frontend-testing-debugging`, `react-best-practices`, `shadcn`, `stripe-best-practices`, `supabase-postgres-best-practices`.
- Web data visualization: `data-visualization`.
- Build iOS Apps: `ios-app-intents`, `ios-debugger-agent`, `ios-ettrace-performance`, `ios-memgraph-leaks`, `ios-simulator-browser`, `swiftui-liquid-glass`, `swiftui-performance-audit`, `swiftui-ui-patterns`, `swiftui-view-refactor`.
- Build macOS Apps: `appkit-interop`, `build-run-debug`, `liquid-glass`, `packaging-notarization`, `signing-entitlements`, `swiftpm-macos`, `swiftui-patterns`, `telemetry`, `test-triage`, `view-refactor`, `window-management`.
- GitHub: `github`, `gh-address-comments`, `gh-fix-ci`, `yeet`.
- Product Design: `index`, `audit`, `ideate`, `image-to-code`, `url-to-code`; the router also loads internal context and QA workflows when required.
- Figma: `figma-code-connect`, `figma-create-new-file`, `figma-generate-design`, `figma-generate-diagram`, `figma-generate-library`, `figma-implement-motion`, `figma-swiftui`, `figma-use`, `figma-use-figjam`, `figma-use-motion`, `figma-use-slides`.
- Creative Production: `explore`, `ads-explorer`, `generative-polish`, `logo-explorer`, `moodboard-explorer`, `offer-explorer`, `positioning-explorer`, `scene-explorer`, `shot-explorer`.
- Data Analytics: `index`, `analyze-data-quality`, `build-dashboard`, `build-report`, `create-data-context`, `design-kpis`, `gather-business-context`, `jupyter-notebooks`, `kpi-reporting`, `market-sizing`, `metric-diagnostics`, `product-business-analysis`, `publish-artifact-to-sites`, `validate-data`, `visualize-data`.
- Codex Security: `attack-path-analysis`, `deep-security-scan`, `finding-discovery`, `fix-finding`, `propose-security-hardening`, `security-diff-scan`, `security-scan`, `threat-model`, `track-findings`, `triage-finding`, `validation`, `vulnerability-writeup`.
- Superpowers: `brainstorming`, `dispatching-parallel-agents`, `executing-plans`, `finishing-a-development-branch`, `receiving-code-review`, `requesting-code-review`, `subagent-driven-development`, `systematic-debugging`, `test-driven-development`, `using-git-worktrees`, `using-superpowers`, `verification-before-completion`, `writing-plans`, `writing-skills`.
- Supabase: `supabase`, `supabase-postgres-best-practices`.
- Artifacts: `documents`, `pdf`, `Presentations`, `Spreadsheets`, `excel-live-control`, `template-creator`.
- Infrastructure: `remote-ssh`.

Skill files live under `$CODEX_HOME/skills` and `$CODEX_HOME/plugins/cache/.../skills`. Before using a skill, read its current `SKILL.md` fully and follow its routing instructions.

## Agent usage

Use agents only when the task benefits from real parallelism and write scopes can be separated.

Good uses:

- `explorer` agents for independent codebase questions, such as API auth flow, mobile playback flow, and web player state flow.
- `worker` agents for independent implementation slices, such as API-only, web-only, mobile-only, or docs-only changes.
- Parallel verification while the main agent continues non-overlapping implementation.

Rules:

- The owner has explicitly allowed agent/delegation/parallel-agent work for Apollo TF tasks.
- Give each worker a concrete owned file/module scope.
- Tell workers not to revert or overwrite changes made by others.
- Do not duplicate the same investigation in main and sub-agent work.
- Use `wait_agent` only when the result blocks the next critical step.
- Review returned patches before integrating.

Recommended split for Apollo TF:

- API worker: `artifacts/api-server`, `lib/db`, API-related generated client updates.
- Web worker: `artifacts/music-player`, shared client consumption.
- Mobile worker: `artifacts/trackfinder-mobile`.
- Contract worker: `lib/api-spec`, codegen outputs, compatibility checks.
- Verification worker: targeted typecheck/build/test/browser QA.

## Repo hygiene

- Keep credential-bearing Git remotes out of logs and docs.
- Do not edit generated outputs without checking the generator/source.
- Prefer `rg`/`rg --files` for search.
- Prefer `pnpm` for package operations.
- Keep Replit/Cursor/session artifacts out of tracked files.

## HomeNode operations

- Access to the designated HomeNode was verified read-only on 2026-07-14. Host aliases, addresses, service inventory, firewall output, DNS values, and SSH material are kept only in `.ops-private/`.
- Infrastructure changes are allowed only when they are part of the active user request and after a read-only impact check, rollback plan, and validation plan.
- Do not publish Apollo TF service ports directly. Use private container networking and route only approved public hosts through the established ingress.
- Prefer SSH identity files outside the repository with owner-only permissions. Never commit or print key material.
