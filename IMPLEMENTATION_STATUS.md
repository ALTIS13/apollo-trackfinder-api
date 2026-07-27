# Apollo TF implementation status

Last updated: 2026-07-27.

## TF immutable migrations release candidate

Status: `LOCAL_VALIDATED_WITH_RESIDUAL`. The active branch is
`codex/feat/tf-immutable-migrations`; no remote mutation or push is part of
Task 5.

- Apollo TF uses immutable, checksummed migrations `0001` and `0002`, exact
  prefix/full-history validation, a bounded advisory lock, separate
  `apollo_tf_migrator`/`apollo_tf_runtime` pools, and DDL-free API startup.
- Root, nested API and Platform bridge Compose enforce
  `PostgreSQL -> tf-migrate -> API`. Manual `tf-role-bootstrap` and
  `tf-baseline` services exist only in the disabled `baseline` profile.
- The PostgreSQL cluster must be dedicated to Apollo TF. Role bootstrap
  normalizes cluster-wide managed-role access and must never run against a
  shared PostgreSQL instance.
- Active setup uses six file-backed database secrets:
  `tf_postgres_admin_password`, `tf_admin_database_url`,
  `tf_migrator_password`, `tf_runtime_password`,
  `tf_migrator_database_url`, and `tf_runtime_database_url`. Password sources
  are `999:999` mode `0400`, runtime/migrator URL sources are `10001:10001`
  mode `0400`, and the shared admin URL is `root:10002` mode `0440`.
  Supplemental group `10002` is granted only to the two profiled manual
  services.
- A fresh PostgreSQL 16 integration proof passed `34/34`: ten live migration
  cases, one factual live target-mutation case, and twenty-three pure
  guard/cleanup
  contracts. It covers clean/repeat migration, exact readiness/history, runtime
  CRUD and full canary privilege denials, drift/unmanaged rejection, exact
  manual baseline, ownership transfer, partial `0002` rollback/recovery without
  renaming a cluster role, malformed-catalog rejection, and absence of
  provider-token tables/grants. Without the integration environment the DB
  file passes twenty-three pure contracts and skips eleven live tests; the full
  ordinary DB package passes forty-six tests and skips the same eleven.
- The disposable runner creates `apollo_tf_test_<run_id>`, an alternate
  database, and an external sentinel outside the managed/reset object list. It
  sets the target marker and exact sentinel content derived from the run ID;
  the tracked test does not create the sentinel.
- Exactly one admin, migrator, and runtime backend is checked out. Read-only
  probes on those pinned clients verify database, marker, same-server identity,
  PostgreSQL 16, superuser, migrator, and runtime roles before any DDL/reset.
  All later integration SQL remains pinned; no pool reconnect can switch the
  validated backend. Wrong run ID, expected marker, database, cross-target
  session, and role all fail before the destructive callback while preserving
  the external sentinel.
- A logical `release(error)` poisons its pinned resource, preserves the first
  error object, blocks later use, and forwards that exact error once during
  physical release. Every physical release and pool end remains single-attempt
  even after synchronous close failures. Operation, validation, and final reset
  errors remain primary; cleanup-only failures are generic. Target-validation
  error output excludes URLs, passwords, raw run IDs, markers, hosts, and
  database names.
- The proof used exact per-run image/container/network/volume names and labels,
  bounded readiness, failure cleanup, and a zero-resource audit. No production
  migration or role implementation change was required by the real database
  proof.
- The full local matrix passed: DB, API, search, integrations, download-worker,
  and Platform test suites; root typecheck; API and Platform production builds;
  all three Compose config renders; formatting and diff checks. The separate
  role-bootstrap Docker proof passed 4/4 and its exact cleanup audit was zero.
- Ordinary package suites retain documented opt-in skips. The factual database
  suite was run separately against PostgreSQL 16; the opt-in live Platform/TF
  bridge startup is not claimed by this validation and remains a separate
  runtime-contract stage before release.
- No remote TF data volume is currently known to this project. Legacy adoption
  is manual-only after verified backup and restore evidence, with exact order
  `tf-role-bootstrap -> tf-baseline -> tf-migrate`; production execution also
  requires owner approval. Old volumes are neither deleted nor silently
  adopted.
- API liveness may pass while readiness remains unavailable until exact full
  migration history exists. Container modules remain portable across Coolify
  nodes through private same-node DNS or separately approved cross-node TLS.
- Task 5 did not mutate HomeNode, Coolify, Caddy, UFW, DNS, domains, GitHub, or
  Android.

## HomeNode/Coolify read-only release preflight

Status: `READ_ONLY_COMPLETE`. The active branch is
`codex/ops/homenode-coolify-preflight`; no remote mutation was performed.

- GitHub repository rename is canonical and healthy:
  `origin=https://github.com/ALTIS13/Apollo.TF.git`, GitHub reports
  `ALTIS13/Apollo.TF`, default/remote HEAD is `main`, and local `main` matched
  `origin/main` at `2a1dbad96f295f351282b6834c3a4042d0c24be3`.
- The completed `tf-download-worker` worktree and its local merged branch were
  removed. Its remote feature ref remains as an audit trail. The unrelated
  `tf-integrations-container` worktree was not changed.
- Read-only SSH and Coolify access passed using ignored private connection
  metadata. No key material or connection inventory was read into tracked
  project files.
- HomeNode service health, capacity, time synchronization, ingress ownership,
  listeners, firewall posture, Docker security mode, backup path, and current
  resources were inspected read-only. Exact versions, counts, capacity,
  addresses, routes, and candidate ports remain only in ignored
  `.ops-private/`.
- Development port defaults conflict with the current host. Production
  manifests must require explicit loopback publications, and every candidate
  must be rechecked immediately before container creation.
- No new firewall rule is required because every Apollo host publication must
  bind to loopback behind the existing ingress.
- Native-Linux secret readability for runtime/database UIDs remains a release
  blocker. A dedicated encrypted Apollo backup destination and restore proof
  are also not yet available.
- Remote Docker has reclaimable resources, but nothing was pruned because exact
  ownership proof and explicit mutation approval are required.
- Independent Compose audit found production blockers: conflicting optional
  port defaults, TF migrations coupled to API startup, missing Platform
  portal/operator UI, environment-delivered admin credentials, mutable
  build/`:local` images, missing resource limits, and no versioned Caddy
  cutover/rollback artifact.
- Public release constraints and the two-stack rollout order are documented in
  `docs/operations/homenode-coolify-preflight.md`. Exact private inventory and
  candidate upstream notes remain only in ignored `.ops-private/`.
- `admin.apollot.ru` cutover is blocked until its owning UI (Platform operator
  UI or TF topology UI) and complete operator-authentication policy are
  explicitly selected.
- Next implementation stage is local Coolify release hardening: immutable TF
  migrations, production-only Platform/TF Compose manifests, file-secret/native
  ownership proof, immutable images, resource limits, Caddy rollout artifact,
  and disposable restore/dry-run evidence. Remote creation, deployment,
  migration, Caddy reload, UFW/DNS change, restart, volume mutation, or cleanup
  still requires explicit owner approval immediately before execution.

## TF download worker release candidate

Status: `MERGED_VALIDATED`. The reviewed runtime tip is
`955200aec6a12776fe9ea52b26c1f3bfa16201a9`; the validated feature/release
record tip is `b0727979062885e1c32f679ab9e44cb5c0b67668`, based on
`a6c7bca84e3334ef28022947b147d16ea3d283da`. Local `main` was fast-forwarded
without a merge commit and passed the merged-result gate. It has not yet been
deployed to HomeNode or Coolify. This following publication record is
documentation-only and does not claim that the runtime matrix was rerun on
itself.

- The public API remains the only browser authorization, CSRF, entitlement,
  queue-admission, cancellation, and file-authorization boundary. Downloads run
  in the dedicated non-root `tf-download-worker`; queue Redis, worker storage,
  command authentication, heartbeat, control, and egress are isolated by
  Compose networks, file-backed secrets, and private service origins.
- The web client uses the queued workflow and compensates cancellation and late
  queue acknowledgements without issuing duplicate POST or DELETE requests.
  Unexpected terminal smoke states now fail immediately instead of being
  hidden behind a polling deadline.
- Queue admission is capped by 200 deterministic lifecycle-deduplication slots.
  Slot-backed current-protocol leases recover safely, stale producers cannot
  create job 201, unknown legacy un-slotted intent fails closed pending operator
  reconciliation, and public waiting/delayed positions never exceed 200.
- The streamed downloader always transcodes through FFmpeg. The disposable
  smoke fixture emits valid WAV input from one directly signallable process;
  HTTP bytes, exact Range, reported file size, size/quota/deadline failures, and
  cancellation cleanup are verified. An independent `ffprobe` oracle requires
  both MP3 container and MP3 audio codec, preventing a raw-input false positive.
- Focused API queue suites passed `67/67`; the exact Redis 7/BullMQ integration
  passed `4/4` in five consecutive runs; worker passed `184 passed / 2 gated
skipped`; music-player passed `118/118`; the full API suite passed
  `538 passed / 4 environment-gated skipped`. Worker typecheck/build, API
  typecheck/build, workspace typecheck, frozen install, root and nested Compose
  renders, Prettier, and diff checks passed.
- Final disposable real-Docker validation passed `33/33` in `219.67s`,
  including MP3/FFprobe, security negative paths, signed file access, replay and
  owner isolation, cancellation, bounded failures, secret/canary scans, and
  zero owned container/network/volume/temp-directory residue. One preceding
  attempt stopped during a transient `apt-get` exit `100`; an exact Dockerfile
  rebuild and the unchanged full rerun passed.
- Independent admission review, migration-edge re-review, Redis-time evidence
  review, and final media-fixture re-review report no remaining P0-P3 findings.
  Residual release risk is native rootful-Linux secret ownership and
  FFmpeg/libmp3lame threshold calibration after future image upgrades.
- GitHub connectivity resolves canonically to `ALTIS13/Apollo.TF`; `origin`
  uses `https://github.com/ALTIS13/Apollo.TF.git`, remote HEAD/default branch is
  `main`, and fetch/`ls-remote` succeed. The feature ref was published at the
  validated release-record tip; remote `main` publication is represented by the
  Git commit history containing this documentation-only record.
- Next rollout stage is a read-only HomeNode/Coolify/Caddy preflight, native
  Linux secret-ownership proof, and an owner-approved Coolify deployment. No
  HomeNode, Coolify, Caddy, UFW, DNS, or other remote infrastructure mutation
  was performed in this stage.

## TF integrations admission/deadline hardening candidate

Status: `MERGED_VALIDATED`. The immutable reviewed implementation tip is
`be3abd1ca17153187b0c978f114cbf14d22f6c9c`; merged-result validation passed
at evidence tip `26d00869888c8962f3016207752a39e40e59121b`, which was pushed
to `origin/main`. This following release-record change is documentation-only
and does not claim that the runtime matrix was rerun on itself. Independent
task reviews and the final whole-wave review found no remaining Critical or
Important breakage.

- Replay state retains up to `256` live nonces per canonical account across at
  most `256` account partitions. There is no shared global nonce pool and no
  live-nonce eviction; exhausted account or partition capacity is an explicit
  `503`. Readiness and module-concurrency rejection happen before nonce claim,
  while duplicate admitted commands cannot execute concurrently.
- Every command uses one absolute `8s` context. The isolated integration
  database is PostgreSQL 17+, and session `transaction_timeout` remains active
  through `COMMIT`; PG16 or a missing capability fails readiness
  closed. The HTTP path performs a final deadline check after serializing the
  validated response and before sending it.
- Exact package validation passed contract `10/10`; integrations DB
  `25 passed / 5 PostgreSQL-gated`, followed by the gated PostgreSQL 17 suite
  `5/5`; integrations `105 passed / 10 real-Docker-gated`, followed by the
  complete smoke file `17/17` with all ten gates enabled; API
  `384 passed / 2 skipped`; tf-search `140 passed / 1 skipped`; and
  music-player `85/85`. This is `764` unique passes, `3` documented external
  skips, and `0` failures across `65` files. An earlier parallel Windows worker
  exit had no assertion failure; every affected package then passed in an
  isolated single-worker rerun.
- Workspace typecheck, both exact Compose renders, `git diff --check`, and all
  three production builds passed. Fresh primary outputs are integrations
  `index.mjs` 111,790 bytes and `migrate.mjs` 9,101 bytes; API `index.mjs`
  4,278,639 bytes; music-player JS 517,554 bytes and CSS 121,197 bytes. The
  existing music-player sourcemap and greater-than-500-kB chunk advisories
  remain nonblocking.
- Public read-only DNS checks through `1.1.1.1` and `8.8.8.8` passed `16/16`
  for the eight owner-created records. The Docker smoke and the independent
  audit left zero project containers, networks, volumes, or temporary
  validation resources.
- Owner-requested Docker image cleanup removed all six unused local images and
  reclaimed 937.3 MB. Two detached, exactly named Task 6 residues from
  2026-07-25 were also removed after proving that no container used them.
  Merged-result API validation briefly restored `redis:7-alpine`; its
  setup-timeout residue was removed by exact name, the rerun passed, and the
  image was pruned again with another 57.83 MB reclaimed.
  Unrelated anonymous volumes and build cache were not mass-pruned.
- The next server/web feature at this historical checkpoint was
  `tf-download-worker`; its current release-candidate record is above.
  Coolify/HomeNode rollout remains gated on a read-only preflight and explicit
  owner approval. No HomeNode, Coolify, Caddy, UFW, DNS, or other remote
  infrastructure mutation was performed in this integrations wave.

## TF integrations Task 7 historical release validation

Status: `DONE_WITH_CONCERNS`. The final whole-branch implementation and
validation tip is
`16f6fc88e85fe919ddcb86a85333a38f3218e715`, with exact fix range
`230077513023231c800b51509b6e98e5e9f455bd..16f6fc88e85fe919ddcb86a85333a38f3218e715`.
The following evidence commit is documentation-only and does not claim that
the runtime matrix was rerun on itself.

- Final-review fixes add immutable migration
  `0005_provider_account_generation.sql` while leaving `0001`--`0004`
  byte-unchanged. Repository upsert rotates an unguessable UUIDv4 generation;
  refresh is update-only CAS, so disconnect cannot be restored and reconnect
  cannot be overwritten. Service and repository interleavings are covered,
  including `2/2` against disposable real PostgreSQL and a real-smoke CAS
  assertion.
- Internal command authentication now verifies exact raw-byte HMAC and time,
  strictly parses the command, then claims replay state in the canonical
  account partition. Live nonces are retained through signed validity without
  eviction, bounded at `32/account` and `256/global`. Query, fragment,
  trailing-slash, and extra command targets are rejected without HMAC path
  canonicalization.
- Every command has an `8s` deadline and disconnect/shutdown cancellation.
  Module concurrency is `32`; provider I/O is `8 active + 24 queued`, with
  `1 MiB` bounded streaming JSON and cancellation of non-OK, malformed,
  oversized, stalled, and non-terminating bodies. Provider readiness remains
  database-only.
- API startup requires heartbeat keys for both `search-media` and
  `account-integrations` and fails with a generic configuration error.
  External modules start `unknown`, remain non-healthy until a valid heartbeat,
  expire after `90s`, and recover on a new valid heartbeat. Shutdown cannot
  send a heartbeat after awaited readiness.
- The deferred plaintext-canary, late-heartbeat, and role-init timeout findings
  are closed. Password files are bounded to `1..512` bytes and PostgreSQL role
  bootstrap uses `10s` connection, `30s` statement, and `5s` lock limits.
  Task 1 policy/CSRF remains closed; Task 5 cold-import coverage remains
  nonblocking.
- Final exact successful suites: contract `10/10`; integrations DB
  `19 passed / 2 PostgreSQL-gated`; integrations
  `95 passed / 10 real-Docker-gated`; API `383 passed / 2 skipped`; tf-search
  `140 passed / 1 real-Docker-gated`; music-player `85/85`. Total:
  `732 passed / 15 skipped or gated / 0 failed` across 65 files. The first API
  attempt had no assertion failure but one Windows Vitest worker exited after
  `379 passed / 2 skipped`; the identical exact rerun passed
  `383 passed / 2 skipped`.
- Workspace typecheck and all three builds passed. Fresh primary outputs:
  integrations `index.mjs` 104,179 bytes and `migrate.mjs` 9,101 bytes; API
  `index.mjs` 4,278,465 bytes; music-player JS 517,554 bytes (164.43 kB gzip)
  and CSS 121,197 bytes (18.62 kB gzip). Existing music-player sourcemap and
  greater-than-500-kB chunk warnings remain nonblocking.
- Both exact no-env Compose checks pass silently; explicit root and nested
  overrides each resolve `16/16` secret files. LF-normalized root/nested YAML
  sizes are 15,890/14,520 bytes and JSON sizes are 20,921/19,078 bytes.
  Parsed renders have `32/32` default secret paths and zero host-port,
  foreign-secret, or integration-network violations.
- Fresh authoritative Docker smoke passed `17/17` in `121.40s` under project
  `apollo-tf-integrations-smoke-45916-d33a8afb`. It re-proved migration/ACLs,
  stale-generation CAS in PostgreSQL, signed-command rejection, authenticated
  ciphertext, bounded topology, provider-independent readiness, heartbeat
  reset/recovery, exact inspect boundaries, zero host ports, and Node 24 LTS.
- Smoke-injected 37 raw/digest markers were absent from rendered config, logs,
  responses, ciphertext projection, inspect, and tracked bytes. A separate
  8-raw plus 8-digest pass found zero matches in 591 tracked files, 23 built
  files, four renders, and the implementation diff. API/module source and dist
  forbidden-dependency scans returned zero.
- Independent exact cleanup returned `containers=0`, `images=0`,
  `networks=0`, `volumes=0`, `temporaryDirectories=0`,
  `diagnosticContainers=0`, and `diagnosticNetworks=0`. The supplemental
  PostgreSQL containers also left zero names/resources. No unrelated Docker
  resource was pruned.
- Public read-only DNS checks through `1.1.1.1` and `8.8.8.8` passed `16/16`
  for the eight owner-created names. No DNS address or private inventory is
  recorded.
- Docker Desktop proves the owner-scoped read-only mount alternative only; it
  does not prove native-Linux UID/GID/mode. Exact native evidence for
  `999:999` or `10001:10001` with mode `0400` remains rollout-blocking and
  merge-nonblocking.
- No HomeNode, Coolify, Caddy, UFW, DNS, or other remote infrastructure
  mutation was performed. The next stage is `tf-download-worker`, followed by
  a read-only HomeNode/Coolify/Caddy preflight and explicit user approval
  before any rollout mutation.

## Что сделано

- На `codex/feat/tf-search-container` завершена локальная реализация независимого `tf-search`: строгие signed HMAC-команды, provider fan-out, нормализация/ranking, bounded process-local cache `2048` записей с TTL `1h`, signed heartbeat `search-media` и одно-репличное ограничение первой версии.
- `tf-api` сохранён как единственная публичная cookie/CSRF/Platform `tf.search` policy boundary и переведён на внутренний HTTP gateway для search, batch search, suggestions, recommendations и Deezer fallback. Browser/account/session/installation/entitlement данные в `tf-search` не передаются; внутренние `sourceUrl` и provider status не попадают в публичный ответ.
- Root и nested Compose содержат изолированный `tf-search` без host port, data/edge networks, DB/Redis/Platform/provider-account/control-plane credentials или host mounts. Command/heartbeat keys разделены и загружаются из file-backed secrets; same-node HTTP разрешён только явным local flag, cross-node режим требует exact HTTPS origin.
- Task 1-5 прошли отдельные implementation/review циклы с итогом `SPEC COMPLIANT / QUALITY APPROVED`. Findings первого whole-branch review и последующих filesystem/cache follow-up закрыты в `53deb1f`, `a04debd`, `8c35ca8` и `10124a3`; финальный независимый whole-branch re-review на `bdd6073` завершился без findings: `SPEC PASS / QUALITY APPROVED / READY TO MERGE YES`.
- Reviewed feature tip `6b43cdb84e142a9aed73b4ae3ee23ee7b48cc2ff` опубликован в `origin/codex/feat/tf-search-container`, затем fast-forward перенесён в локальный `main`. Полная merged-result validation выполнена на том же exact head; validated docs tip `28aa25b340b6182c8da7259405b1239876121ffd` опубликован в `origin/main`.
- Исторический baseline перед cleanup: локально checked-out commit совпадал с `origin/main` на `d6590464ef244e9d15d96e7dbc98377762efb066`.
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
- Владелец утвердил `apollot.ru` как базовый домен зонтичного бренда Apollo: портал на apex, Apollo TF на `tf.apollot.ru`, Identity/Policy на `api.apollot.ru`, TF API на `api.tf.apollot.ru`, операторская панель на `admin.apollot.ru`, Apollo GA на изолированном `ga.apollot.ru`. Приватная DNS-памятка обновлена без IP-адресов и секретов; удалённые записи не менялись.
- Утверждена гибридная архитектура закрытой web beta: отдельные Apollo Platform и Apollo TF data/runtime boundaries, три режима регистрации (`closed`, `invite_only`, `open_approval`), приглашения, серверные module entitlements, Authorization Code + PKCE, отдельные operator sessions и отсутствие runtime-зависимости Apollo GA от Platform/TF.
- Дизайн декомпозирован на пять проверяемых спецификаций: общая платформа, Identity/Policy, topology alignment/routing, Apollo portal/TF client zone и безопасный Coolify release. Android остаётся отложенным до работоспособной web/server инфраструктуры.
- По решению владельца Expo Go/static deployment выведен из целевого workflow; мобильный артефакт должен собираться в APK и проверяться на физических устройствах через ADB.
- На feature branch `codex/feat/admin-topology-dashboard` завершён standalone Apollo TF Admin Topology Dashboard в `artifacts/admin-dashboard`. Визуальная основа -- вариант 2: центральный left-to-right topology workspace; из варианта 1 сохранены четыре операционные метрики и workflow инцидентов.
- Рёбра topology получили прямые двухчастные контакты по принятому референсу: source-side female с прямоугольной выемкой и target-side male со ступенчатым выступом. Внешние концы контактов остаются закреплены на маршруте между сервисами; warning показывает нестабильный зазор, degraded -- физический разрыв и код только при наличии в диагностике, unknown -- нейтральное разомкнутое состояние.
- Для стыка edge с модулем выбран status-terminal вариант 3: `ArrowClosed` и видимые круглые React Flow handles удалены, male/female contact отнесён от target module на прямой stub длиной 12 topology units, а обе границы module card получили тонкие `6 x 16` терминалы цвета статуса самого модуля. Handle остаётся прозрачным в DOM только для route geometry; terminal не перехватывает pointer events и не дублируется для shared edges.
- Устранён ложный визуальный разрыв всех исправных соединений: обе половины `healthy`-штекера теперь залиты цветом линии и читаются как единая сцепленная пара, а боковые border/shadow терминалов удалены, поэтому маршрут входит в модуль без тёмного шва. `warning`, `degraded` и `unknown` сохраняют полую заливку и физический зазор, чтобы нестабильность и обрыв не маскировались.
- Устранена отдельная причина отсутствующих кабелей: SVG mask в Chromium скрывала весь React Flow `BaseEdge`, хотя его DOM geometry доходила до target terminal. Mask и связанные `defs` удалены; edge теперь всегда растеризуется целиком, а локальный route-cover цвета topology canvas перекрывает только 32-unit участок строго под корпусом штекера. Cover вынесен в отдельную непрозрачную sibling-group, поэтому линия не просвечивает через intentional gap состояний `warning`, `degraded` и `unknown` даже при dimmed edge opacity. Кабель виден от source terminal до female half и от male half до target terminal; его stroke увеличен с `2` до `4.5` topology units и совпадает с высотой прямого корпуса контакта.
- Исправлена геометрия углового входа в штекер: horizontal routing использует 12-unit endpoint offset и вычисляемый center, поэтому последняя дуга заканчивается ровно у внешней кромки female-half и больше не образует Т-образный выступ. Совпадающий ствол нескольких исходящих состояний теперь перекрывается одним цельным `4.5`-unit кабелем с детерминированным градиентом `healthy -> warning -> degraded`; после точки разведения каждая ветка сохраняет собственный status/contact.
- Плашки `WARNING/ERROR` вынесены из границ target modules в свободные межрядные каналы с направлением по геометрии ветки. Vertical node separation увеличен с `34` до `40`, поэтому evidence labels не скрываются карточками ни на fit-view, ни после увеличения топологии.
- `ServiceEdge.incidentId` связывает warning/degraded edge с точным инцидентом; `Incident.diagnostic` хранит ограниченные схемой code/message/timestamp/sanitized log excerpt. Контакт открывается указателем, Enter или Space, фокусирует связанный сервис и разворачивает точную запись журнала. UI не придумывает отсутствующий код ошибки.
- Incident rail больше не sticky, не имеет hover-сдвига и остаётся в document flow. Его нижняя граница совпадает с topology, а deployment/provider tables образуют следующую полноширинную строку; provider table полностью видна при desktop reference viewport `1536x1024`.
- Dashboard использует типизированный `DashboardSnapshot` и явные adapter mode/capabilities. CommandBar показывает `Демо` для demo adapter и `Продакшн` для HTTP adapter. Demo mode стартует live из детерминированного snapshot и допускает локальный acknowledgement; production HTTP mode показывает fallback как непроверенный, сразу запрашивает same-origin `GET /api/admin/dashboard`, становится live только после schema-validated ответа, offline после первого отказа и stale только после отказа, следующего за успешным remote snapshot. Remote incidents доступны только для чтения.
- Каждый HTTP 200 JSON проверяется Zod-схемой до изменения state: проверяются все поля/enums/timestamps, ровно четыре metrics, лимиты коллекций, уникальность IDs для metrics/modules/edges/incidents/providers и ссылки edges/incidents. Запрос имеет 10-секундный abort timeout; ручное и interval-обновление используют single-flight.
- Standalone Vite-to-nginx image сохраняет `/healthz` и SPA fallback. nginx проксирует и добавляет server-side `X-Admin-Dashboard-Token` только для exact `GET /api/admin/dashboard`; non-GET exact path получает `405`, остальные `/api/*` получают `404` без proxy/token. Docker resolver и variable-form upstream откладывают DNS resolution до API-запроса и сохраняют URI/query, поэтому `/healthz` стартует при unresolvable upstream hostname. Root Compose задаёт upstream/token только контейнеру и не содержит obsolete top-level `version`.
- Admin topology paths `dagre -> lodash` и `graphlib -> lodash` принудительно переведены на patched `lodash@4.18.1`; admin-scoped production audit paths отсутствуют. Проверенный dashboard и connector diagnostics merged в `main`.
- На branch `codex/feat/admin-telemetry-api` добавлен общий пакет `@workspace/admin-dashboard-contract`, который одинаково валидирует snapshot в API и admin UI. Неизвестные deployment/provider timestamps стали необязательными; UI показывает `Нет данных`/`Не проверялся`, не придумывая время наблюдения.
- Реализован защищённый `GET /api/admin/dashboard`. Пустой server token отключает endpoint с `503`, неверный token получает `401`, точное непустое значение сравнивается по SHA-256 digest через `timingSafeEqual`; успешный schema-validated ответ имеет `Cache-Control: no-store`. Token не возвращается, не компилируется в browser и добавлен в logger redaction.
- Добавлена bounded process telemetry: 60-second окно до 10 000 категориальных записей без body/query/cookies/credentials, requests/search/download/error counters, queue depth, coalesced PostgreSQL probe с connection/query/statement timeout и раздельные cache Redis/Queue Redis status. Admin/health requests исключены. Queue failure возвращает partial snapshot; непроверенные providers и независимые контейнеры остаются `unknown`.
- Root и API Compose передают `ADMIN_DASHBOARD_TOKEN` только серверным API/admin services; optional `APOLLO_API_VERSION` и `APOLLO_DEPLOYED_AT` не подменяют отсутствующие данные. Admin nginx требует `ADMIN_ACCESS_USER`/`ADMIN_ACCESS_PASSWORD`, закрыт при их отсутствии, rate-limits probes и публикуется локально только на `127.0.0.1:3001`. Оба Docker build включают общий contract package. Coolify/HomeNode в этом этапе не менялись.
- Authenticated module heartbeat rollout: root и nested API Compose передают `APOLLO_MODULE_HEARTBEAT_KEYS` только API service с empty-default interpolation; admin, web, PostgreSQL и Redis его не получают. `.gitignore` и `.dockerignore` exclude `.env`, `.env.*` and `.ops-private` while retaining `.env.example`. `MODULES.md` documents the Unix-second HMAC canonical string, 30-second sender interval, 90-second freshness TTL, API-restart reset, per-module JSON keys, and disabled-by-default behavior. HomeNode/Coolify were not changed.
- На branch `codex/fix/admin-thin-connector-lines` длинные status-colored кабели topology заменены нейтральными полностью непрозрачными трассами `#596273` шириной `1.75` topology units. Каждая физическая ветка сохраняет тонкую непрозрачную status-lane шириной `1`; общий source trunk рисуется одной нейтральной основой и максимум тремя отдельными lanes с фиксированными позициями `healthy=-1`, `warning=0`, `degraded=1`, поэтому состояния не смешиваются и не меняют вертикальное положение между render cycles. `unknown` остаётся доступен отдельной ветке, но не создаёт четвёртую линию общей шины.
- Существующая female/male геометрия, gaps, module terminals, dragging/reset и incident activation сохранены. Штекеры стали выразительнее за счёт state-colored корпуса/glow, непрозрачного внутреннего светового штриха и тёмной обводки, которая рисуется последней поверх корпуса. Длинные линии, status-lanes и новые детали не используют alpha mixing; HomeNode/Coolify/Caddy/UFW/domains не менялись.
- Topology Task 7 завершает режимы `Свободно`/`Выровнять`, 24-unit grid и безопасный drag: карточки больше нельзя положить друг на друга, поэтому совпадающие module ports не создаются пользовательским перемещением. Переключение режима не двигает узлы; клавиатура сохраняет grid/Alt-precision контракт.
- Составной вертикальный fan удалён. Перегруженная source-группа получает одну короткую горизонтальную aggregate-шину с opaque weighted gradient и уникальные attachment/channel координаты для каждой ветки; одинаковые target-row подходы разделяются для целей выше, на уровне и ниже источника. Стандартный Core above/same/below layout остаётся прежним.
- SVG gradient identity объединяет стабильный React instance ID и инъективно кодированный edge ID, поэтому два одновременно открытых topology экземпляра не делят `<linearGradient>`. Bounds учитывают шину, полные маршруты, контакты, traffic и evidence labels.
- Task 8 завершил локальный production-compatible Apollo Platform stack: отдельные PostgreSQL, Redis, one-shot migrator и API, immutable migration bundle без startup migrations, private profile smoke без test-only public policy route, loopback-only API и отсутствие host ports у data services. Debian/glibc image запускается от UID/GID `10001:10001` с root-owned/non-writable app tree и native Argon2 production closure.
- Read-only Platform services получают generated per-run credentials только через file-backed top-level Compose secrets в фиксированных `/run/secrets/*` paths. Linux contract использует private host directory `0700` и read-only files `0444`, поэтому bind-mounted file читается UID `10001`, но host path недоступен другим users через parent. Docker Desktop использует собственные bind metadata semantics; Compose `uid`/`gid`/`mode` не заявляются. Smoke удаляет host temp directory после гарантированного `down -v --remove-orphans`.
- Task 8 smoke сравнивает externally observable status/full body для consumed и unknown invitation, а также consumed и unknown verification token. Он нормализует только проверенный response `requestId`; token validity не появляется в public contract.
- Final whole-branch review сообщил один Critical, три Important и один Minor finding: inherited remote build selectors, неполный migration/history contract, disabled-module entitlements, unbounded PostgreSQL paths и отсутствие startup assertion для actual protected-route mapping. Technical fix `2eb4bed` закрыл исходные findings; последующие focused fixes `8082809` и `67fe0e6` закрыли обнаруженные re-review race/cleanup paths. Финальный независимый re-review на `a83a6a6` завершился без Critical/Important/Minor findings: `SPEC: PASS`, `QUALITY: APPROVED`, `READY TO MERGE: YES`.
- Smoke теперь case-insensitively отклоняет BuildKit/Buildx/Bake routing state до Docker invocation и после local selector validation принудительно использует `COMPOSE_BAKE=false`. Migration runner/readiness требуют exact manifest/history без extra rows. Activation/effective listing требуют active module state. Runtime/migrator PostgreSQL profiles имеют bounded connection/query/statement/lock/idle-transaction/pool limits, а app construction проверяет actual protected capability mapping.
- Final narrow follow-up technical fix `8082809` требует active `entitlement.moduleState` в последнем PolicyService allow predicate, поэтому disable между module lookup и entitlement projection больше не может разрешить доступ. Migration cleanup сохраняет primary failure при rollback/unlock errors, всегда пытается advisory unlock и передаёт cleanup failure в `client.release(error)`; cleanup-only failure возвращается вызывающему коду.
- Final single-path migration-lock fix `67fe0e6` трактует любую ошибку acquisition как uncertain client state: exact lock error сохраняется для caller и передаётся в `client.release(error)`, а unlock не выполняется без подтверждённого acquisition. Focused TDD RED был `1 failed / 16 passed`, GREEN — `17/17`; финальный re-review подтвердил исправление без оставшихся findings.
- Task 9 реализовал локальный disposable Apollo Platform/Apollo TF auth bridge из семи сервисов: `platform-postgres`, `platform-redis`, `platform-migrate`, `platform-api`, `tf-postgres`, `tf-redis`, `tf-api`. Data planes разделены, только два API делят private control network, а отдельная `bridge-edge` разрешает исключительно loopback-bound host probes; базы и Redis не публикуют host ports.
- Platform public issuer отделён от TF server-to-server control origin. Внутренний HTTP разрешён только development bridge-флагом и только для exact `http://platform-api:8080`; production сохраняет HTTPS. Dynamic callback port допускается только для точного loopback hostname и полного registered redirect URI. Deterministic file-backed PKCE verifier разрешён только этому disposable bridge, production продолжает использовать случайный verifier.
- TF image запускается как `10001:10001` через non-root entrypoint, читает `DATABASE_URL_FILE` до импорта bundle, сохраняет Pino worker layout в `/app/artifacts/api-server/dist`, остаётся read-only с bounded tmpfs и проверяет PostgreSQL/Redis в readiness. Root и nested TF Compose переведены на file secrets, отдельные data networks и loopback API binding без передачи database/control credentials web/admin контейнерам.
- Полный TLS browser-equivalent smoke доказал closed registration, operator bootstrap/login, invite-only регистрацию, verify/activate, PKCE S256 с exact replay verifier, single-use code equivalence, `tf.search`, deny/grant/revoke `tf.downloads`, одноразовый WebSocket ticket, replay reject и close `4403` после suspend. Rendered config, responses/projections, logs, command output и tracked bytes сканируются на raw values и SHA-256 digests; cleanup проверяет нулевые ресурсы и временные secret directories.
- `MODULES.md` фиксирует будущие `tf-search`, `tf-integrations`, `tf-download-worker`: authenticated HTTP/heartbeat, least-privilege entitlements, собственные хранилища, отсутствие shared DB/Docker/SSH/control access, private Coolify DNS на одной ноде либо owner-approved TLS между нодами. Для локального этапа новый домен не нужен; HomeNode/Coolify/Caddy/UFW/DNS не менялись.

### TF web Platform session

- Status: implemented and locally validated
- Browser auth: Platform PKCE through `api.tf.apollot.ru`, host-only TF cookie
- CSRF: `/api/auth/me` uses an unmanaged credentialed GET; success, HTTP error, malformed body, and transport outcomes never clear/commit module state or publish auth events, and only the mounted current auth-provider generation clears before refresh and commits its accepted canonical token
- Policy: `tf.search` gates application mount; server remains authoritative for every capability
- Runtime invalidation: confirmed `401` and core WebSocket/search/media policy failures synchronously unmount protected providers, cancel and clear protected queries, clear CSRF, then revalidate `/auth/me` where applicable
- Account replacement: an accepted account B session can remount only after account A queries are cancelled and cleared; obsolete `/auth/me` successes or typed failures cannot publish, alter provider state, clear B's CSRF, or commit stale CSRF
- Logout: the CSRF-protected server request starts with the current token, then local auth and query state clear immediately without waiting for network settlement
- Search: generated `searchTracks` receives current credential/CSRF options at mutation time
- Generated media: stream/download `unauthorized`, `module_access_denied`, and `policy_unavailable` failures feed the auth channel before existing local error feedback
- WebSocket: one-time ticket acquired before every connection attempt; exact terminal close pairs and stale handlers are fail-closed, and pre-open `websocket_unavailable` forces session revalidation before a fresh player lifecycle can mount
- Yandex: browser token entry/transport removed; new onboarding is deferred to server-side OAuth while existing server-backed connections remain readable and logout-capable
- Legacy browser UUID: removed
- Remote infrastructure: unchanged; domains/Caddy/Coolify deployment still requires preflight and explicit approval

## Validation

- TF search-container Task 6 Steps 1-3 повторно выполнены 2026-07-25 на clean branch `codex/feat/tf-search-container` и exact implementation head `10124a33a2d49a5c8d016e5eedd2af16df6242e2`. `pnpm install --frozen-lockfile` прошёл для `18` workspace projects без изменения SHA-256 lockfile. Точные успешные команды и результаты: `pnpm --filter @workspace/module-runtime-contract test` — `9/9`; `pnpm --filter @workspace/tf-search-contract test` — `6/6`; `pnpm --filter @workspace/api-zod test` — `2/2`; `pnpm --filter @workspace/tf-search test` — `140 passed / 1 explicitly gated skip`; `pnpm --filter @workspace/api-server test` — `365 passed / 2 environment/permission-gated skips`; `pnpm --filter @workspace/music-player test` — `85/85`. Windows Vitest worker pool не падал, isolated/low-worker fallback не потребовался.
- `pnpm run typecheck` прошёл для libraries и всех `8` artifact/script projects. Production builds прошли: `tf-search` dist `2 files / 3,772,787 bytes` (`index.mjs` `1,469,641`); `tf-api` dist `10 files / 11,666,533 bytes` (`index.mjs` `4,265,441`); music-player dist `6 files / 1,698,369 bytes` (`JS` `517,554`, `CSS` `121,197`). Оба server entrypoint прошли `node --check`; pre-doc `git diff --check` завершился без замечаний.
- Exact root/nested Compose renders использовали свежий workspace-contained каталог с шестью canary secret files: root `8,168` bytes, nested `7,086` bytes, оба exit `0`, stderr `0`, raw/digest leaks `0`. Canary directory удалён после проверки.
- Explicit real local Docker smoke прошёл на проекте `apollo-tf-search-smoke-1308-c08d13e8`: signed internal command, policy-gated public search, response projection и heartbeat `unknown -> healthy`/recovery подтверждены. Smoke cleanup и отдельный пятикомпонентный аудит совпали: `containers=0`, `images=0`, `networks=0`, `volumes=0`, `temporaryDirectories=0`.
- Production scans: unresolved `@workspace/` imports в server `.mjs` bundles `0`; forbidden account/session/installation/entitlement/CSRF, database/Redis/Platform/provider-account и control-plane identifiers в production `tf-search` source/bundle `0`; legacy in-process search adapter/cache/classifier/ranker imports в `tf-api` runtime `0`; credential/private-key/token и release canary literals `0`. Известные non-blocking предупреждения остались прежними: tooltip sourcemap advisory и music-player chunk `517.55 kB` выше Vite threshold.
- Findings первого whole-branch review и follow-up покрыты fix-коммитами `53deb1f4f16db9acef45926b0fd3febf247e4e15`, `a04debd9519390e718292c1d7bf0544301098a66`, `8c35ca8debc7a83ad018aedce2fc1d97cd384bf3` и `10124a33a2d49a5c8d016e5eedd2af16df6242e2`; полная release matrix после fixes прошла на последнем из них. Финальный независимый re-review проверил 90 changed paths, не нашёл findings и вернул `SPEC PASS / QUALITY APPROVED / READY TO MERGE YES`. Task 6 Step 5 publication, fast-forward merge и merged-result validation завершены.
- Ignored stale Task-5 directory ранее безопасно удалён точечно: `2 files / 2 directories`, содержимое canary-файлов не читалось. Свежий residue audit подтвердил отсутствие соответствующих временных каталогов.
- Домены для локальной validation не потребовались. HomeNode, Coolify, Caddy, UFW, DNS, доменные записи, Android и любая другая удалённая инфраструктура не проверялись на запись и не изменялись.
- TF search-container Task 6 Step 5 merged-result validation выполнена 2026-07-25 на clean local `main` и exact pre-doc head `6b43cdb84e142a9aed73b4ae3ee23ee7b48cc2ff`. Frozen install охватил `18` workspace projects и сохранил SHA-256 `pnpm-lock.yaml` без изменений. Полные suites: module-runtime `9/9`, tf-search-contract `6/6`, api-zod `2/2`, tf-search `140 passed / 1 explicitly gated skip`, API `365 passed / 2 environment/permission-gated skips`, player `85/85`.
- Root typecheck прошёл для libraries и всех `8` artifact/script projects. Fresh production builds: tf-search `2 files / 3,772,787 bytes` (`index.mjs` `1,469,641`), API `10 files / 11,666,323 bytes` (`index.mjs` `4,265,408`), player `6 files / 1,698,369 bytes` (`JS` `517,554`, `CSS` `121,197`). Оба server entrypoint прошли `node --check`; сохранились только известные Vite warnings о tooltip sourcemap и chunk `517.55 kB`.
- Exact root/nested Compose renders использовали шесть свежих workspace-contained canary files: raw stdout `7,626` и `6,658` bytes, оба exit `0`, stderr `0`, raw/digest leaks `0`. Canary directory и созданный временный parent удалены точечно.
- Explicit real local Docker smoke прошёл на проекте `apollo-tf-search-smoke-43552-a5e600df`: signed internal command, policy-gated public search, response projection и heartbeat recovery подтверждены. Встроенный cleanup и отдельный пятикомпонентный аудит дали `containers=0`, `images=0`, `networks=0`, `volumes=0`, `temporaryDirectories=0`.
- Fresh runtime/security scans проверили `6` server bundles, `16` production tf-search source files, `28` API runtime files и `58` tracked runtime files: unresolved `@workspace/` imports, forbidden browser/account/session/install/entitlement/CSRF, DB/Redis/Platform/provider-account/control-plane identifiers, legacy provider/ranker/cache imports и credential/private-key/token/canary literals -- по `0`. Pre-doc `git diff --check` прошёл; worktree был clean.
- Whole-branch verdict остаётся `SPEC PASS / QUALITY APPROVED / READY TO MERGE YES`. Удалённая feature-ветка подтверждена на `6b43cdb84e142a9aed73b4ae3ee23ee7b48cc2ff`; validated merged docs tip `28aa25b340b6182c8da7259405b1239876121ffd` подтверждён в `origin/main`. Домены, HomeNode, Coolify, Caddy, UFW, DNS и Android не изменялись.
- TF web-session unmanaged `/auth/me` merge-blocker follow-up (2026-07-24): focused and full music-player suites passed `85/85`, including six real-adapter stale failure cases after account B commit; selected API auth/boundary/ticket/policy/WebSocket tests passed `100/100`; player/root typechecks and player production build passed. Frozen install, exact runtime legacy/provider-secret/Yandex-token scans, and diff checks passed. No lockfile, generated shared-client, Compose/Docker, server runtime, or remote infrastructure change was made.
- TF web-session independent whole-branch review (2026-07-24) found no Critical, Important, or Minor findings at `87905127ad12845bc77923e40be2a42ccbb5ca43` and returned `SPEC PASS`, `QUALITY APPROVED`, `READY TO MERGE YES`. Production cross-origin cookie behavior remains intentionally outside local validation; new Yandex onboarding remains deferred to server-side OAuth.
- TF web-session merged-result validation (2026-07-24) on `main` at `567d0f2322c10d34846911b3af84669d80cd0a7b`: frozen install passed without lockfile changes; music-player passed `85/85`; selected API browser-contract tests passed `100/100`; player/root typechecks and player production build passed. Runtime legacy/secret scans were clean; exact `docker compose config` passed with three disposable workspace-local canary files, followed by verified cleanup (`TEMP_CLEAN=True`). Only the existing tooltip sourcemap and `517.55 kB` chunk-size advisories remain. No HomeNode, Coolify, Caddy, UFW, DNS, domain, or other remote infrastructure was changed.

- TF web-session second whole-branch follow-up (2026-07-24): focused session/auth/generated-media/WebSocket coverage and the full music-player suite passed `78/78`; selected API auth/boundary/ticket/policy/WebSocket tests passed `100/100`; player/root typechecks and player production build passed. Frozen install, exact runtime legacy/provider-secret/Yandex-token scans, and `git diff --check` passed. No lockfile, generated shared-client, Compose/Docker, server runtime, or remote infrastructure change was made.

- TF web-session consolidated final-review fix wave (2026-07-24): focused and full music-player suites passed `66/66`; selected API auth/boundary/ticket/policy/WebSocket tests passed `100/100`; player/root typechecks and player production build passed; exact runtime legacy/provider-secret scans and `git diff --check` were clean. `pnpm 10.33.2` regenerated `pnpm-lock.yaml` unchanged and `pnpm install --frozen-lockfile` passed. The required music-player test importer entries were retained together with pnpm's normalized shared Vitest peer snapshots and `path-scurry` deduplication to the already locked `lru-cache@11.5.2`. No tracked Compose file changed, so Compose was not rerun and no remote service or infrastructure was touched.

- Historical TF web-session local release validation (2026-07-24): music-player suite `41/41`, selected API browser-contract suite `100/100`, player/root typechecks and player production build passed. That historical controller fixture used the then-active secret names `tf_client_secret`, `tf_database_url`, and `tf_postgres_password`; they are not current setup guidance. Exact `docker compose config` exited `0`, and all temporary files were individually deleted (`TEMP_CLEAN=True`). No real secret, Compose configuration, or remote infrastructure was changed.

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
- Status terminal connector verification 2026-07-15: focused RED/GREEN suites прошли `20/20` и `11/11`; полный admin suite -- 9 files / 86 tests; admin typecheck, Vite production build (2554 modules) и `git diff --check` прошли. Два независимых task review одобрили spec compliance и code quality без findings.
- Connector continuity regression verification 2026-07-15: две новые проверки сначала воспроизвели hollow healthy contact и тёмный terminal seam, после исправления focused suite прошёл `25/25`; полный admin suite -- 9 files / 90 tests, admin typecheck и Vite production build (2554 modules) прошли. In-app browser подтвердил состояния контактов и terminal styles, но эта DOM-геометрическая проверка не подтверждала фактическую растеризацию `BaseEdge` и была superseded следующей visual regression validation. Клик по `ERROR DLW-E502` раскрывает точный журнал с sanitized log excerpt. Независимый read-only review завершился `No findings` и вердиктом `APPROVED`.
- Connector cable rasterization verification 2026-07-15: минимальный browser experiment подтвердил root cause -- снятие mask немедленно показывает все семь route paths. Первая регрессия упала `6 failed / 9 passed` из-за отсутствующего route-cover и установленной mask; review затем обнаружил translucent cover при dimmed contact и отдельный RED воспроизвёл это `1 failed / 15 passed`. После sibling-occlusion fix и выравнивания cable/contact thickness focused suite прошёл `17/17`; полный admin suite -- 9 files / 92 tests, admin typecheck и Vite production build (2554 modules) прошли. In-app browser на fit и увеличенном масштабе показывает видимые source/target cable stubs для healthy, warning и degraded contacts; computed mask равна `none`, stroke width равна `4.5px` у 7/7 edges, присутствуют 7 opaque route-covers с computed fill topology canvas, dimmed contact `0.28` сохраняет occlusion opacity `1`, а `DLW-E502` продолжает открывать точный sanitized journal. Повторный независимый review завершился `No findings / APPROVED`.
- Connector join/gradient/layout verification 2026-07-15: RED-регрессии воспроизвели заход последней дуги под корпус штекера, отсутствие aggregate gradient trunk и пересечение всех трёх status labels с target modules. После исправления focused suites прошли `29/29`; полный admin suite до и после fast-forward в `main` прошёл 9 files / 97 tests, admin typecheck и Vite production build (2554 modules) завершились с exit code `0`. In-app browser подтвердил final bend endpoint `x=525.5`, совпадающий с outer female edge, один solid shared trunk с gradient stops `0/50/100%`, `stroke-width: 4.5px`, `stroke-dasharray: none`, `stroke-linecap: butt`; collision audit показывает `0` пересечений labels/modules на fit-view и после двух шагов zoom-in. Оба контакта `DLW-E502` продолжают открывать точный журнал и выбирать Download Worker. HomeNode/Coolify не менялись.
- Codex in-app browser QA status terminals: desktop и `390x844` имеют 16 видимых terminals, `0` arrow markers, `0` opaque handles и чистые console logs. Mobile document width остаётся внутри viewport (`375 < 390`), topology использует внутренний `349 -> 760` horizontal scroller; activation edge `download-worker -> media-storage` раскрывает точный журнал `DLW-E502`.
- Codex in-app browser connector/layout QA -- passed at `1536x1024` and `390x844`: pointer, Enter и Space activation open `DLW-E502` with the matching sanitized log; both outer endpoints of all seven demo connectors lie on the horizontal route, including bent edges; reduced motion removes warning flicker while preserving status; a fresh tab has no warning/error console entries.
- Final incident/provider check: computed incident position is `static`, incident/topology bottom delta is `0px`, provider bottom is `996.42px` inside a `1024px` viewport, no incident hover selectors are present, and scrolling/navigation to providers produces no module overlap.
- Incident rail regression check after interruption: focused admin suite passed, 2 files / 37 tests; static positioning, topology-aligned height and absence of incident hover selectors remain enforced by `config-contract.test.ts`.
- Admin telemetry focused TDD после review fixes: 4 API test files / 19 tests passed, 1 disposable-Redis integration test корректно пропущен без `APOLLO_REDIS_INTEGRATION_URL`. Покрыты shared snapshot, download route classification, partial queue snapshot, coalesced probes, authenticated real HTTP, container security contract и независимость queue routing от telemetry failures. API typecheck и esbuild production build passed.
- Оба production Docker image собраны локально. Admin runtime: `/healthz=200`, UI без operator auth `401`, с корректной Basic Auth `200`. API image с временным PostgreSQL: `/api/healthz=200`, admin без service token `401`, с token `200`, `Cache-Control=no-store`, 9 modules / 6 providers, token отсутствует в body. Это локальная container validation, не deployment.
- Финальная telemetry/API validation: shared contract -- 1 file / 3 tests; API -- 4 files / 19 tests, 1 integration test skipped без Redis URL; admin -- 8 files / 83 tests. Workspace typecheck, API/admin production builds, root/nested Compose config и `git diff --check` прошли. Compose вывел только ожидаемые предупреждения о незаданных локальных Spotify credentials.
- Disposable Redis integration отдельно прошла `2/2`: idle BullMQ workers не получили `Command timed out`, telemetry-only failure не переключил backend с Redis, а следующий реальный probe восстановил healthy status. Полный локальный API/PostgreSQL/Redis stack вернул authenticated snapshot с `queue-redis=healthy` и нулём worker timeout errors.
- Независимое read-only review после исправлений одобрило этап без оставшихся actionable findings по auth, secret handling, bounded telemetry, PostgreSQL timeout, queue failure isolation и container wiring.
- Independent code review found and verified fixes for bent-edge attachment, invalid edge-to-incident relations, SVG mask ID collisions, long visible diagnostic codes, keyboard Space handling, CSS layout contracts, and custom adapters bypassing schema endpoint validation. Final re-review reports no actionable findings.
- Workspace `pnpm run typecheck` -- passed после устранения конфликтующих React type definitions в lockfile/catalog.
- Local Docker/Compose validation -- admin image and runtime template build locally; disposable `/healthz` validation использует intentionally unresolvable upstream hostname, а Compose config проходит без obsolete-version warning. Exact evidence записано в `.superpowers/sdd/final-review-fix-report.md`. Эта проверка подтверждает только локальную readiness конфигурации, не deployment в Coolify/HomeNode.
- Codex in-app browser QA -- passed at `1536x1090` and `390x844`: no page-level horizontal overflow, topology uses an internal portrait scroller, node/incident focus works, acknowledgement survives dashboard refresh, open/all filters work, and reduced-motion removes animated traffic packets while preserving status dots and labels.
- Draggable unified connectors final validation 2026-07-15 on `codex/feat/admin-draggable-connectors`: `pnpm vitest run` in `artifacts/admin-dashboard` passed 11 files / 118 tests; both admin/root `pnpm typecheck` commands and Vite production `pnpm build` (2556 modules) passed, as did `git diff --check`. Controller-supplied Codex in-app browser evidence confirms: short clearance uses one shortened trunk shared by all three Core branches; zero clearance removes the trunk and starts all three at the Core terminal; positive off-row routes remain bounded; the crossed off-row route has its vertical center at `femaleOuter` and its six-unit painted right edge ends at the socket center-band fill. The final browser run reported 7 edges, 7 contacts, 14 conductor segments, one default trunk, no warnings/errors, and reset restored the default layout. Final whole-branch review verdict: `READY TO MERGE YES`, with no Critical/Important findings. Technical fix commits after `90c5dbc` are `b43f711`, `0d09788`, `43be802`, and `c558c9b`. HomeNode/Coolify were not changed.
- Module heartbeat Task 4 validation 2026-07-15: rollout commit `9b7b970`, browser-QA status commit `20b6694`, and review-fix commits `a1fdfe9`, `d187300`, and `b37af83`. The configuration contract recorded RED (1 failed / 6 passed) before Compose/ignore edits and GREEN (1 file / 7 tests) after. A disposable isolated local HTTP smoke with generated test-only secrets returned heartbeat `202`, then an authenticated admin snapshot with the fresh module status/version/`lastHeartbeatAt`; advancing the injected clock by 90,001 ms changed status to `unknown` while retaining the receipt time. Fresh full validation passed: shared contract 1 file / 4 tests, API 6 files / 83 passed with 1 opt-in Redis skip, admin 11 files / 120 tests, workspace typecheck, API build, admin Vite build (2556 modules), both Compose configs, and `git diff --check`. Compose emitted only unset local Spotify credential warnings. Codex in-app browser QA passed at default desktop `1280x720` and mobile `390x844`: the existing deployment table renders the `Последний сигнал` column with 5 timestamps and 3 truthful `Нет данных` values, console warning/error logs are empty, desktop fits without table overflow, and mobile keeps page width at `375 < 390` while the table alone scrolls horizontally `349 -> 620`; scrolling to the right makes the full last-signal column visible without overlap.
- Module heartbeat whole-branch runtime fix 2026-07-15: technical fix `f4c52444352a2288966b4a6169d849297f886b8d` rejects non-identity content encoding before inflation/auth, enforces the exact lowercase/no-trailing-slash heartbeat path, uses injected monotonic elapsed time for heartbeat and replay/capacity aging, restores the exact success/`405` response contracts, and sanitizes malformed percent-encoded route responses. TDD RED was 3 failed files / 18 failed / 59 passed; final focused GREEN was 3 files / 77 passed. Fresh full API validation passed 6 files / 106 tests with 1 existing opt-in Redis skip; API typecheck, production build, Prettier over all six changed tracked files, and `git diff --check` passed. HomeNode, Coolify, Caddy, UFW, domains, frontend styling, and unrelated modules were not changed.
- Module heartbeat clock compatibility follow-up 2026-07-15: technical fix `b49d346bbb02e67f439847f11ef696b092932302` preserves deterministic now-only injection by using the injected wall clock when no monotonic clock is supplied, keeps no-argument production snapshots on monotonic elapsed time, and preserves `snapshot(number)` as explicit wall-clock milliseconds. TDD RED was 1 file / 2 failed / 45 passed; service GREEN was 1 file / 47 passed and heartbeat/route/admin focused GREEN was 3 files / 79 passed, including the existing backward-wall-clock freshness, replay-expiry, and nonce-capacity regressions. The first full API attempt had one non-assertion Vitest worker exit after 89 passed / 1 skipped; an immediate verbose rerun completed 6 files / 108 passed / 1 existing opt-in Redis skip. API typecheck, production build, Prettier, and `git diff --check` passed. The old tracked `.superpowers/sdd/whole-branch-fix-report.md` was not changed.
- Module heartbeat optional snapshot API follow-up 2026-07-15: technical fix `00237813b4f50e3cc51539432649cb84f7a6d207` exposes `snapshot(atWallTime?: number)` directly so literal `undefined` and `number | undefined` callers remain source-compatible while preserving monotonic behavior for omitted/undefined arguments and wall-time behavior for numbers. TDD RED was API typecheck exit `2` with two `TS2345` errors for literal and optional undefined calls. GREEN was service 1 file / 48 passed, heartbeat/route/admin focused 3 files / 80 passed, and full API 6 files / 109 passed with 1 existing opt-in Redis skip. API typecheck, production build, Prettier, and `git diff --check` passed. The old tracked whole-branch report and all out-of-scope files were unchanged.
- Module heartbeat final feature validation 2026-07-15 at `0f39175`: shared contract 1 file / 4 passed, API 6 files / 109 passed with 1 opt-in Redis skip, and admin 11 files / 120 passed. Workspace typecheck, API/admin production builds, root/nested Compose config, and `git diff --check` passed; Compose emitted only the expected unset local Spotify credential warnings. Final independent re-review reported no actionable findings with `READY TO MERGE: YES`, `Spec: PASS`, and `Quality: APPROVED`. Browser evidence remains valid because the post-QA fixes changed only API tests/runtime and status documentation. HomeNode/Coolify/Caddy/UFW/domains were not changed.
- Thin topology connector TDD 2026-07-15: initial implementation focused GREEN was `47/47`; independent review then found shifting subset offsets, a possible fourth shared `unknown` lane, weak outline paint order and alpha highlight. Review-fix RED reproduced the contracts with `6 failed / 26 passed`; focused GREEN passed `32/32`, connector regression passed `54/54`, and fresh full admin regression passed 11 files / `127/127`. Admin and workspace typecheck, Vite production build (2556 modules), and `git diff --check` passed.
- Codex in-app browser QA for thin connectors passed at the default side-panel viewport and temporary `390x844`: 15 neutral conductor bases render at `1.75`, 17 opaque status lanes render at `1`, and the shared trunk exposes exactly three ordered lanes `healthy -1`, `warning 0`, `degraded +1`. Fourteen plug outlines and fourteen internal highlights are present; keyboard drag/reset restores module translation, `ERROR DLW-E502` opens the matching sanitized incident journal, and no module/diagnostic regression was observed. Temporary mobile viewport override was reset after QA.
- Admin topology Task 7 collision-safe horizontal-fan validation 2026-07-16: boundary RED reproduced edge-touching and narrow corridors, cross-row approach collisions, attachment/approach collisions, positive Q/L overlap, stale batched drag state and duplicate directed relations. Focused admin GREEN passed 5 files / 124 tests; full admin passed 15 files / 216 tests, shared contract 5/5, and API 109 passed with 1 opt-in Redis skip. Workspace typecheck, admin/API production builds, and `git diff --check` passed. In-app browser DOM reported 8 modules, 7 female/male contact pairs, one horizontal shared trunk and three unobscured diagnostic labels; paired visual comparison confirms the reported Download Worker/Search Media loop is absent. Final independent spec and quality re-reviews returned PASS with no findings.
- Apollo Platform Task 8 live container validation 2026-07-17: production image built on Debian/glibc with pinned `pnpm@10.33.2`; native Argon2 completed a real in-image hash/verify. Live Compose tests passed 13 files with `216 passed / 9 skipped`; a separate disposable PostgreSQL/Redis regression ran platform-contract `5/5`, platform-db `24/24` and platform-api `222 passed / 3 skipped`. The opt-in skips were covered in their corresponding live environment rather than silently omitted.
- Task 8 smoke passed the complete closed/bootstrap/login/invite/redeem/verify/grant/activate/allow/revoke/deny sequence and scanned rendered config, logs and response projections for generated secret canaries and digests. API server passed `109 passed / 1 existing opt-in Redis skip`; admin passed `216/216`; root typecheck, all required production builds, `node --check`, workspace-import scan, Prettier and `git diff --check` passed. Every disposable project ended with no matching containers, networks, volumes or temp secret directories.
- Direct environment-backed Compose secrets produced the expected Docker Desktop failure for a read-only service (`file` is the sole supported option). File-backed direct `/run/secrets/*` mounts were then proven readable by UID `10001`; Docker Desktop exposed bind-backed files with host-controlled metadata, so no `uid`/`gid`/`mode` guarantee is claimed. No persistent credential volume, remote infrastructure mutation or deployment was performed.
- Task 8 initial independent review failed with two Critical, two Important and one Minor finding: inherited Compose project teardown, inherited database credentials/paths, socket-only PostgreSQL readiness, missing tracked-file secret-byte scan and inaccurate review/count status. Fix commit `39bfe2f` addressed those reported boundaries. The second independent re-review then reported one Critical, one Important and one Minor finding; those findings and all later follow-ups are resolved by `d82718c`, `1741c4d`, `2eb4bed`, `8082809` and `67fe0e6`, with the final clean verdict recorded above.
- Final whole-branch TDD RED: focused API command produced `16 failed / 97 passed / 3 skipped` and focused platform-db produced `6 failed / 7 passed`; failures directly exercised remote build routing, full migration history, disabled modules, pool/rollback bounds and startup route drift. Final fresh disposable GREEN: platform-contract `5/5`, platform-db `30/30`, platform-api `250 passed / 3 live-container-only skipped`; root typecheck, Platform build, exact three-bundle syntax/import scan, Prettier and `git diff --check` passed.
- Final production smoke passed `closed/bootstrap/login/invite/redeem/verify/grant/activate/allow/revoke/deny`. Bundles were exactly `index.mjs` (104791 bytes), `migrate.mjs` (6226) and `policy-smoke.mjs` (35526), with no `@workspace/` imports. Cleanup audit found zero Compose projects, matching containers, volumes and temporary secret directories. This is local validation only; Coolify/HomeNode and other remote infrastructure were not touched.
- Narrow follow-up TDD RED was policy `1 failed / 31 passed` and migration/helper `3 failed / 13 passed`; focused GREEN was policy `32/32` and migration/helper `16/16`. Fresh live-PostgreSQL suites passed platform-db `33/33` and platform-api `251 passed / 3 live-container-only skipped`. Root typecheck, Platform build, exact three-bundle syntax/import checks, full production smoke, Prettier and `git diff --check` passed; cleanup again found zero Compose projects, matching containers, volumes or temporary secret directories.
- Final single-path migration-lock validation: focused GREEN `17/17`; fresh disposable PostgreSQL platform-db suite `34/34`; root typecheck and Platform build passed sequentially; all three production bundles passed syntax checks with zero `@workspace/` imports; `git diff --check` passed. Full smoke was intentionally not rerun because runtime/container behavior did not change. The unique Compose project, network and volumes were removed.
- Final controller validation 2026-07-17 on `a83a6a6`: sequential live suites passed platform-contract `5/5`, platform-db `34/34`, platform-api `251 passed / 3 live-container-only skipped`, API server `109 passed / 1 existing opt-in Redis skip` and admin `216/216`. Root typecheck and Platform/API/admin production builds passed. Platform output contained exactly `index.mjs` (104791 bytes), `migrate.mjs` (7098 bytes) and `policy-smoke.mjs` (35566 bytes); all passed `node --check` with zero `@workspace/` imports. Final production smoke passed the complete flow in 73.4 seconds. Scoped Prettier and `git diff --check` passed; cleanup found zero Compose projects, matching containers, volumes, networks or temporary secret directories.
- Merged-result validation 2026-07-17 on `main` at `9d6d952`: platform-contract passed `5/5`, live platform-db `34/34`, live platform-api `251 passed / 3 live-container-only skipped`, root typecheck and Platform build. The exact three bundles retained the validated sizes, passed syntax checks and contained zero `@workspace/` imports. Full production smoke passed the complete flow in 74.3 seconds; cleanup reported Compose `[]` and zero matching containers, volumes, networks or temporary secret directories.
- Task 8 review-fix TDD recorded meaningful RED at 5 failed / 3 passed / 3 skipped for project/config isolation, remote Docker refusal, TCP readiness and tracked-file enumeration, followed by a separate scanner RED at 2 failed / 7 passed / 3 skipped. Focused GREEN is 1 file with `9 passed / 3 live-only skipped`. This was an intermediate checkpoint; subsequent independent re-reviews and their fixes are complete, with the final clean verdict recorded above.
- Review-fix live validation reran the complete smoke successfully in 64 seconds. A fresh disposable PostgreSQL/Redis project then passed platform-contract `5/5`, platform-db `24/24` and platform-api `227 passed / 3 live-container-only skipped`; API server remained `109 passed / 1 existing opt-in Redis skip` and admin remained `216/216`. Root typecheck, all three builds, exact Platform bundle checks, `node --check`, workspace-import scan, Prettier and `git diff --check` passed, followed by zero matching containers/networks/volumes/temp directories.
- Task 8 second re-review TDD reproduced Docker selector precedence, mixed-case selector handling, duplicate rejection and live Compose project scoping at `4 failed / 9 passed / 3 skipped`. Fix `d82718c` canonicalizes selector keys case-insensitively, rejects conflicting duplicates, applies Docker CLI context-over-host precedence, freezes and validates the effective local selector, and carries it into every later explicitly project-scoped Compose call. Focused GREEN is `13 passed / 3 live-only skipped`.
- Second re-review live validation passed the full generated-project smoke in 66.4 seconds and a separate fresh production stack passed all `16/16` E2E tests, including readiness, UID/read-only ownership, native Argon2 hash/verify and runtime-role constraints. Default package regressions passed platform-db `10 passed / 14 environment-gated skipped` and platform-api `222 passed / 12 environment-gated skipped`; root typecheck, Platform build, all three `node --check` runs, zero-match workspace-import scan, Prettier and `git diff --check` passed. Cleanup ended with an empty Compose project list and zero matching Task 8 containers or volumes.
- Task 8 follow-up review reported two separate Important findings: the live smoke did not compare unknown tokens with consumed/unavailable public responses, and Linux file-backed secrets created as `0600` were unreadable to container UID `10001`. TDD RED was `2 failed / 13 passed / 3 skipped`; fix `1741c4d` added full status/body equivalence checks and the `0700` directory plus `0444` file contract. Focused GREEN was `15 passed / 3 live-only skipped`; fresh smoke passed in 62.2 seconds and cleanup reported Compose `[]`, zero matching containers/volumes and zero temp secret directories. Later whole-branch re-reviews are complete and approved.
- Follow-up validation passed root typecheck before the Platform build, then `node --check` on exactly three bundles and a zero-match `@workspace/` scan over exactly those bundles. This proves local build/smoke behavior only; no Coolify/HomeNode validation, deployment or remote mutation occurred.
- Residual constraints are explicit: password rotation against a retained PostgreSQL volume requires coordinated role-password and URL-secret updates, and the Debian/PostgreSQL/Redis base image tags are not yet digest-pinned. No HomeNode/Coolify/Caddy/UFW/DNS or other remote infrastructure was changed.
- Task 9 focused bridge suite прошёл `45/45` с одним явно gated live-тестом; финальный `bridge:smoke` завершил полный TLS/PKCE/policy/WebSocket flow за `104.2s` без runtime warnings. Redirect projection требует ровно один экземпляр каждого разрешённого параметра, actual TF callback принимает только exact `code+state`, а отдельные RED/GREEN тесты отклоняют duplicate/missing/extra query keys без отражения секретов в ошибках.
- Fresh disposable dependencies: platform-contract `10/10`, live PostgreSQL platform-db `39/39`, live serial Platform API `427 passed / 4 container-gated`, TF API с реальным Redis `298/298`, admin dashboard `216/216`. Fake-Docker suite прошёл `26 passed / 3 explicitly gated`; его child process ограничен `20s`, а enclosing tests — `30s`.
- Workspace typecheck, Platform build и TF build прошли. Platform dist содержит ровно `index.mjs`, `migrate.mjs`, `policy-smoke.mjs`; TF dist содержит пять runtime `.mjs`. Все восемь прошли `node --check` и scans на unresolved workspace imports/legacy client-session.
- Bridge/root/TF `docker compose config` прошли с generated file secrets. Финальный cleanup-аудит нашёл `0` matching containers, networks, volumes, временных bridge secret directories и validation fixtures. Промежуточные RED/root causes и исправления build context, Pino path, edge network, WebSocket timeout, projection scan, full-suite timeouts, migration test contention, Fetch blocked port и fixture typing записаны в `.superpowers/sdd/task-9-report.md`.
- Полный независимый Task 9 re-review подтвердил `SPEC PASS`, `QUALITY APPROVED`, `READY TO COMMIT YES` без Critical/Important/Minor findings. Последний socket-listener follow-up также независимо одобрен; HomeNode, Coolify, Caddy, UFW и DNS не менялись.
- Final whole-branch fix сохранил исходные Compose service/database/role/volume identities, перенёс `VITE_API_URL` в web build args, добавил exact production CORS и общий CSRF boundary для unsafe browser API, сделал migration `0004` non-destructive, выровнял confidential-client limit с Platform и закрыл конкурентные entitlement/expiry races через fail-closed пересечение актуальной интроспекции и Redis policy view. Browser-equivalent bridge smoke теперь получает CSRF из `/api/auth/me`, редактирует его и отправляет на download/WebSocket-ticket mutations.
- Контрольная validation на feature tip: TF API `315 passed / 1 existing skip`, Platform API `420 passed / 21 environment-gated`, live PostgreSQL platform-db `39/39`, root typecheck, TF/Platform builds, root/nested Compose config, Vite canary bundle и scoped formatting/diff checks прошли. Семиконтейнерный bridge прошёл за `113.0s`; после fast-forward тот же flow из `main` прошёл за `108.7s`. Оба cleanup-аудита нашли `0` matching containers, networks, volumes и temp directories.
- Финальный whole-branch re-review и отдельный credential-validator follow-up завершились без findings: `SPEC PASS`, `QUALITY APPROVED`, `READY TO COMMIT YES`. Remote deployment не выполнялся; HomeNode, Coolify, Caddy, UFW и DNS не менялись.

## Commit/push

- TF search-container feature опубликована в `origin/codex/feat/tf-search-container` на reviewed tip `6b43cdb84e142a9aed73b4ae3ee23ee7b48cc2ff` и fast-forward merged в `main`. Merged-result matrix повторно прошла на exact pre-doc head `6b43cdb84e142a9aed73b4ae3ee23ee7b48cc2ff`; evidence commit `28aa25b340b6182c8da7259405b1239876121ffd` опубликован в `origin/main`.
- Cleanup и операционная документация опубликованы в `main` commit `9a7d770fc053fcc64daeb337749920ce85f46506`.
- Smart Git HTTPS завершался `Recv failure: Connection was reset`, поэтому commit опубликован через GitHub Git Database API после проверки parent и полного tree SHA.
- Feature commit `2481f57b674be15e48140e818653a104e9dff3b0` опубликован в `origin/codex/feat/admin-topology-dashboard`, fast-forward merged в `main` и опубликован в `origin/main` после повторной validation на merged result.
- Финальное whole-branch review для admin dashboard завершилось `Final Review: Approved` без открытых branch findings.
- Feature branch UI сохранена в origin как проверяемая история серьёзного этапа. Backend telemetry/API implementation commit `a5a1b52177f746fc6693b4c1356c83f405bbeeb1` и validation status commit `1f169e57f78ea9c8713ab04a11133e06d56d83d3` опубликованы в `origin/codex/feat/admin-telemetry-api`, затем fast-forward merged и опубликованы в `origin/main`; HomeNode/Coolify не изменялись.
- Status terminal connector work опубликован в `origin/codex/fix/admin-connector-ports`; implementation commits `ed28e9c` и `6e4278b` прошли TDD, полный admin regression, два task review и whole-branch review `APPROVED` без findings. Проверенный feature tip `362d8f637760fc76d9a143e0d3adae67ba98a594` fast-forward merged и опубликован в `origin/main`; merged result повторно прошёл `86/86`, typecheck и production build.
- Connector continuity fix опубликован в `origin/codex/fix/admin-connector-continuity` commit `d05eff1735bd0954b2bbcadf557c8a2d27f050fd`, независимо одобрен без findings, fast-forward merged и опубликован в `origin/main`. Merged result повторно прошёл `90/90`, typecheck и production build; HomeNode/Coolify не изменялись.
- Full-width connector cable fix опубликован в `origin/codex/fix/admin-connector-cables` commit `788ccbd13bc9bb35c29652e3d8039812156def55`, прошёл review-fix и повторный `APPROVED`, fast-forward merged и опубликован в `origin/main`. Merged result повторно прошёл `92/92`, typecheck и production build; HomeNode/Coolify не изменялись.
- Connector join/gradient/layout fix опубликован в `origin/codex/fix/admin-connector-join-gradient` commit `a12c4bdbe44306758639fe82e6006dca5dfae5eb`, fast-forward merged и опубликован в `origin/main` после повторной merged-result validation `97/97`, typecheck и production build.
- Draggable unified connectors опубликованы в `origin/codex/feat/admin-draggable-connectors` through status tip `fce9f92` (technical fix tip `c558c9b`), затем fast-forward merged и опубликованы в `origin/main`. Merged result повторно прошёл 11 files / 118 tests, admin/root typecheck, production build (2556 modules) и `git diff --check`; HomeNode/Coolify не изменялись.
- Module heartbeat whole-branch runtime fixes are committed locally on `codex/feat/module-heartbeat-adapter` as `f4c52444352a2288966b4a6169d849297f886b8d`; no push, merge, or infrastructure deployment was performed in this bounded fix wave.
- Module heartbeat clock compatibility is committed locally on `codex/feat/module-heartbeat-adapter` as `b49d346bbb02e67f439847f11ef696b092932302`; the follow-up remains local with no push, merge, or infrastructure deployment.
- Module heartbeat optional snapshot API compatibility is committed locally on `codex/feat/module-heartbeat-adapter` as `00237813b4f50e3cc51539432649cb84f7a6d207`; no push, merge, or infrastructure deployment was performed.
- Module heartbeat adapter feature branch is published through `f17cec5e7cca2884e9252e5fc8df74620729dc09`, then fast-forward merged into local `main`. Fresh merged-result validation passed after a frozen offline dependency install: shared contract 4/4, API 109 passed with 1 opt-in Redis skip, admin 120/120, workspace typecheck, API/admin production builds, both Compose configs, and `git diff --check`. Final `main` publication is recorded by the current docs-only status commit; no HomeNode/Coolify/Caddy/UFW/domain deployment was performed.
- Thin topology connectors опубликованы в `origin/codex/fix/admin-thin-connector-lines` through validation tip `ee2f33f` (implementation/review-fix tips `98ca750` and `da23795`), затем fast-forward merged и опубликованы в `origin/main`. Merged result повторно прошёл 11 files / `127/127`, admin/workspace typecheck, Vite production build (2556 modules) и `git diff --check`; final independent review reported `SPEC: PASS`, `QUALITY: APPROVED`, `READY TO MERGE: YES`. HomeNode/Coolify/Caddy/UFW/domains не менялись.
- Утверждённые Apollo Platform/Identity/topology/client/Coolify design specs зафиксированы на `codex/docs/apollo-platform-specs` commit `299db7f70dd8b3f358d04f40954ed5d5f1b8e5a9`; commit уже входит в локальный `main` и `origin/main`, ветка сохранена как проверяемая история этапа.
- Topology Task 7 collision-safe routing implementation `13a2743` and validation documentation `7ab3a4f` опубликованы в `origin/codex/feat/admin-topology-alignment-routing`, затем fast-forward merged в `main`. Final `main` publication is recorded by the current status commit after fresh merged-result validation; HomeNode/Coolify/Caddy/UFW/domains не менялись.
- Apollo Platform Task 8 container/smoke implementation is committed locally on `codex/feat/apollo-identity-policy` as `9632f46`; the status documentation is a separate local commit. No push, merge or HomeNode/Coolify/Caddy/UFW/DNS mutation was performed.
- Task 8 independent-review fixes are committed locally as `39bfe2f`; final status evidence is committed separately. No push, merge or remote infrastructure mutation was performed.
- Task 8 second independent re-review fixes are committed locally as `d82718c`; corrected status evidence is committed separately. Its findings were closed by the later review/fix chain. No push, merge or remote infrastructure mutation was performed at that checkpoint.
- Task 8 generic-response/Linux-secret fix is committed locally as `1741c4d`; documentation/status is committed separately. Its findings were closed by the later whole-branch review/fix chain. No push, merge, Coolify/HomeNode validation or remote infrastructure mutation was performed at that checkpoint.
- Final whole-branch technical fix is committed locally as `2eb4bed`; this documentation/status update is separate. The later focused re-reviews closed its remaining policy/migration findings. No push, merge, Coolify/HomeNode validation or remote infrastructure mutation was performed at that checkpoint.
- Final narrow policy/migration cleanup fix is committed locally as `8082809`; this documentation/status update is separate. The final lock-cleanup follow-up and clean re-review are recorded by `67fe0e6` and `a83a6a6`. No push, merge, Coolify/HomeNode validation or remote infrastructure mutation was performed at that checkpoint.
- Final single-path migration-lock fix is `67fe0e6`, its evidence commit is `a83a6a6`, and final branch status is `9d6d952`. The independently approved feature branch is published as `origin/codex/feat/apollo-identity-policy`, fast-forward merged and published in `origin/main`; no Coolify/HomeNode validation or remote infrastructure mutation was performed.
- Task 9 implementation commit `e8f07282cd2485b29084c34ee269847cfe886a95` и final release-review fix `ef28fe8844f27d4a12b9b2311735e55de1e94dda` опубликованы в `origin/codex/feat/platform-pkce-tf-bridge`, fast-forward merged и опубликованы в `origin/main`. Merged result повторно прошёл live DB, TF/Platform suites, workspace typecheck, production builds и полный bridge smoke; remote infrastructure не изменялась.
- TF web-session feature опубликована в `origin/codex/feat/tf-web-session` through reviewed tip `567d0f2322c10d34846911b3af84669d80cd0a7b`, fast-forward merged и опубликована в `origin/main`. Merged-result validation повторно прошла полную Task 5 матрицу; этот docs-only status commit закрывает release checklist.

## Следующий логичный этап реализации

- Локальная Apollo Platform Identity/Policy foundation и production-compatible container smoke завершены. Следующий feature stage должен начинаться только по отдельному binding brief; Task 8 не включает portal/TF client zone или дальнейшую платформенную функциональность.
- Coolify/HomeNode rollout выполняется только после локальной реализации и validation всех web/server модулей, повторного read-only preflight и явного разрешения владельца непосредственно перед удалёнными изменениями.
- Native Android APK decision remains separate: сохранить Expo-модули через native prebuild/Gradle либо выполнить отдельную миграцию на bare React Native.
- Apollo TF web client подключён к Platform authorize/callback, cookie-backed session, CSRF boundary и одноразовым WebSocket tickets. `tf-search` и `tf-integrations` уже выделены и локально провалидированы; следующий server/web этап -- `tf-download-worker` как независимый least-privilege контейнер. Единый root Compose сохраняется для локального полного стека, а Coolify deployment contracts не переходят к удалённому rollout до read-only preflight и отдельного подтверждения владельца.

## Notes

- Node.js не предоставляет кроссплатформенные `openat`/`unlinkat` и блокировку переименования каталога. Поэтому защита smoke и API fixture использует opaque per-run ownership markers, exclusive validated file handles, inode/realpath revalidation, allowlisted non-recursive cleanup и fail-closed substitution tests. Это признанное остаточное ограничение при локальном adversary с возможностью конкурентно менять filesystem, а не заявление об атомарной блокировке каталога.
- Web build проходит с предупреждением о chunk больше 500 kB.
- Полный root build останется красным, пока старый Expo static build не будет заменён согласованным APK pipeline.
- Admin topology dashboard не меняет HomeNode и не содержит provider credentials или его инвентарных данных.
