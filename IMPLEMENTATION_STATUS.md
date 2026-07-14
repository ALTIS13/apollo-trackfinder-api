# Apollo TF implementation status

Last updated: 2026-07-14.

## Что сделано

- Исторический baseline перед cleanup: локальный `HEAD` совпадал с `origin/main` на commit `d6590464ef244e9d15d96e7dbc98377762efb066`.
- Подтверждён remote проекта: `github.com/ALTIS13/apollo-trackfinder-api`.
- Удалены Replit-артефакты из tracked-файлов: `.replit`, `.replitignore`, `replit.md`, `replit.nix`, `.replit-artifact/*`, `attached_assets/*`.
- Удалена ignored локальная папка `.local` с кешами/логами.
- Убраны Replit Vite-плагины, Replit Expo dev-скрипт, Replit-origin, Replit CORS fallback, `REPLIT_*` fallback в Spotify/mobile build.
- Обновлён `pnpm-lock.yaml` и восстановлена установка native optional-пакетов Rollup/Tailwind/LightningCSS/esbuild без platform-exclusion overrides.
- Исправлены typecheck-ошибки, обнаруженные после установки зависимостей: Bandcamp mapper, nullable stdio у `spawnAudioDownload`, отсутствующие mobile icons `expand-less`/`expand-more`.
- Исправлен Windows-запуск `pnpm` внутри mobile static build.
- Добавлен справочник `CODEX_REFERENCE.md` по доступным инструментам, плагинам, навыкам, агентам и формату отчётов.
- Подтверждена доступность multi-agent orchestration, GitHub connector/CLI и Remote SSH plugin; точный набор endpoint зависит от контекста агента и сессии.
- Подтверждено read-only SSH-подключение к HomeNode; приватные детали инвентаризации сохранены только в `.ops-private/`.
- Зафиксированы правила: основной branch `main`, серьёзные изменения в `codex/<logical-name>`, проверка и merge только после validation.
- `.ops-private/` исключён из Git; локально подготовлены памятки по HomeNode и DNS для Apollo TF.
- По решению владельца Expo Go/static deployment выведен из целевого workflow; мобильный артефакт должен собираться в APK и проверяться на физических устройствах через ADB.
- На feature branch `codex/feat/admin-topology-dashboard` завершён standalone Apollo TF Admin Topology Dashboard в `artifacts/admin-dashboard`. Визуальная основа -- вариант 2: центральный left-to-right topology workspace; из варианта 1 сохранены четыре операционные метрики и workflow инцидентов.
- Рёбра topology получили прямые двухчастные контакты по принятому референсу: source-side female с прямоугольной выемкой и target-side male со ступенчатым выступом. Внешние концы контактов остаются закреплены на маршруте между сервисами; warning показывает нестабильный зазор, degraded -- физический разрыв и код только при наличии в диагностике, unknown -- нейтральное разомкнутое состояние.
- `ServiceEdge.incidentId` связывает warning/degraded edge с точным инцидентом; `Incident.diagnostic` хранит ограниченные схемой code/message/timestamp/sanitized log excerpt. Контакт открывается указателем, Enter или Space, фокусирует связанный сервис и разворачивает точную запись журнала. UI не придумывает отсутствующий код ошибки.
- Incident rail больше не sticky, не имеет hover-сдвига и остаётся в document flow. Его нижняя граница совпадает с topology, а deployment/provider tables образуют следующую полноширинную строку; provider table полностью видна при desktop reference viewport `1536x1024`.
- Dashboard использует типизированный `DashboardSnapshot` и явные adapter mode/capabilities. CommandBar показывает `Демо` для demo adapter и `Продакшн` для HTTP adapter. Demo mode стартует live из детерминированного snapshot и допускает локальный acknowledgement; production HTTP mode показывает fallback как непроверенный, сразу запрашивает same-origin `GET /api/admin/dashboard`, становится live только после schema-validated ответа, offline после первого отказа и stale только после отказа, следующего за успешным remote snapshot. Remote incidents доступны только для чтения.
- Каждый HTTP 200 JSON проверяется Zod-схемой до изменения state: проверяются все поля/enums/timestamps, ровно четыре metrics, лимиты коллекций, уникальность IDs для metrics/modules/edges/incidents/providers и ссылки edges/incidents. Запрос имеет 10-секундный abort timeout; ручное и interval-обновление используют single-flight.
- Standalone Vite-to-nginx image сохраняет `/healthz` и SPA fallback. nginx проксирует и добавляет server-side `X-Admin-Dashboard-Token` только для exact `GET /api/admin/dashboard`; non-GET exact path получает `405`, остальные `/api/*` получают `404` без proxy/token. Docker resolver и variable-form upstream откладывают DNS resolution до API-запроса и сохраняют URI/query, поэтому `/healthz` стартует при unresolvable upstream hostname. Root Compose задаёт upstream/token только контейнеру и не содержит obsolete top-level `version`. Backend endpoint ещё не реализован и в будущем обязан проверять forwarded token; deployment в Coolify/HomeNode не выполнялся, HomeNode не менялся.
- Admin topology paths `dagre -> lodash` и `graphlib -> lodash` принудительно переведены на patched `lodash@4.18.1`; admin-scoped production audit paths отсутствуют. Проверенный dashboard и connector diagnostics merged в `main`.

## Validation

- Baseline 2026-06-23: `pnpm install`, full typecheck и build прошли до изменения mobile delivery target.
- Residual search: активных Replit/Cursor артефактов в коде не найдено; оставшиеся `cursor` совпадения относятся к CSS/Redis cursor, не к Cursor IDE.
- `gh auth status`: authenticated as `ALTIS13`; GitHub connector вызван успешно.
- SSH connection test: passed; только read-only команды, изменений инфраструктуры не было.
- Credential-bearing Git remote заменён на credential-free HTTPS URL.
- Исторически один `git fetch` завершался `Recv failure: Connection was reset`; финальные `git fetch origin --prune` и feature-branch push 2026-07-14 прошли по credential-free HTTPS.
- `adb devices -l`: подключены два физических устройства в состоянии `device`.
- Fresh `pnpm run typecheck`: passed.
- Fresh filtered build для API, web player и mockup sandbox: passed.
- Fresh root `pnpm run build`: web, API и mockup прошли, старый mobile static Expo build остановился на зарезервированном Windows-порту `8081`. Этот delivery path после решения владельца считается superseded, а не целевым APK validation.
- `git diff --cached --check`: passed; sensitive-pattern scan по Git index не нашёл ключей, токенов или приватных infrastructure values.
- Admin dashboard final re-review wave: `pnpm --filter @workspace/admin-dashboard test` -- passed, 8 files / 62 tests. Focused RED/GREEN evidence для exact proxy authority, schema cardinality/uniqueness, deferred upstream DNS, base/hover/subtle contrast и adapter-mode label записано в `.superpowers/sdd/final-review-fix-report.md`; dashboard/workspace typecheck, build и container verification перечислены там же.
- Edge connector diagnostics final verification 2026-07-14: `pnpm --filter @workspace/admin-dashboard test -- --reporter=dot` -- passed, 8 files / 82 tests; admin `typecheck`, Vite production `build` (2553 modules) и `git diff --check` завершились с exit code `0`.
- Codex in-app browser connector/layout QA -- passed at `1536x1024` and `390x844`: pointer, Enter и Space activation open `DLW-E502` with the matching sanitized log; both outer endpoints of all seven demo connectors lie on the horizontal route, including bent edges; reduced motion removes warning flicker while preserving status; a fresh tab has no warning/error console entries.
- Final incident/provider check: computed incident position is `static`, incident/topology bottom delta is `0px`, provider bottom is `996.42px` inside a `1024px` viewport, no incident hover selectors are present, and scrolling/navigation to providers produces no module overlap.
- Independent code review found and verified fixes for bent-edge attachment, invalid edge-to-incident relations, SVG mask ID collisions, long visible diagnostic codes, keyboard Space handling, CSS layout contracts, and custom adapters bypassing schema endpoint validation. Final re-review reports no actionable findings.
- Workspace `pnpm run typecheck` -- passed после устранения конфликтующих React type definitions в lockfile/catalog.
- Local Docker/Compose validation -- admin image and runtime template build locally; disposable `/healthz` validation использует intentionally unresolvable upstream hostname, а Compose config проходит без obsolete-version warning. Exact evidence записано в `.superpowers/sdd/final-review-fix-report.md`. Эта проверка подтверждает только локальную readiness конфигурации, не deployment в Coolify/HomeNode.
- Codex in-app browser QA -- passed at `1536x1090` and `390x844`: no page-level horizontal overflow, topology uses an internal portrait scroller, node/incident focus works, acknowledgement survives dashboard refresh, open/all filters work, and reduced-motion removes animated traffic packets while preserving status dots and labels.

## Commit/push

- Cleanup и операционная документация опубликованы в `main` commit `9a7d770fc053fcc64daeb337749920ce85f46506`.
- Smart Git HTTPS завершался `Recv failure: Connection was reset`, поэтому commit опубликован через GitHub Git Database API после проверки parent и полного tree SHA.
- Feature commit `2481f57b674be15e48140e818653a104e9dff3b0` опубликован в `origin/codex/feat/admin-topology-dashboard`, fast-forward merged в `main` и опубликован в `origin/main` после повторной validation на merged result.
- Финальное whole-branch review для admin dashboard завершилось `Final Review: Approved` без открытых branch findings.
- Feature branch сохранена в origin как проверяемая история серьёзного UI-этапа; активный checkout возвращён на `main`.

## Следующий логичный этап реализации

- После merge UI-этапа создать отдельную ветку `codex/feat/admin-telemetry-api` и реализовать backend telemetry/API для `/api/admin/dashboard`, включая обязательную проверку forwarded `X-Admin-Dashboard-Token` и контракт подключения независимых Coolify-контейнеров. HomeNode не изменять до отдельной инфраструктурной проверки.
- Уточнить границу отказа от Expo: сохранить Expo-модули через native prebuild/Gradle либо выполнить отдельную миграцию на bare React Native.

## Notes

- Web build проходит с предупреждением о chunk больше 500 kB.
- Полный root build останется красным, пока старый Expo static build не будет заменён согласованным APK pipeline.
- Admin topology dashboard не меняет HomeNode и не содержит provider credentials или его инвентарных данных.
