# Apollo TF implementation status

Last updated: 2026-07-14.

## Что сделано

- Проверен Git checkout: локальный `HEAD` совпадает с `origin/main` на commit `d6590464ef244e9d15d96e7dbc98377762efb066`.
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

## Validation

- Baseline 2026-06-23: `pnpm install`, full typecheck и build прошли до изменения mobile delivery target.
- Residual search: активных Replit/Cursor артефактов в коде не найдено; оставшиеся `cursor` совпадения относятся к CSS/Redis cursor, не к Cursor IDE.
- `gh auth status`: authenticated as `ALTIS13`; GitHub connector вызван успешно.
- SSH connection test: passed; только read-only команды, изменений инфраструктуры не было.
- Credential-bearing Git remote заменён на credential-free HTTPS URL.
- Повторный `git fetch` через GitHub завершился сетевой ошибкой `Recv failure: Connection was reset`; auth при этом подтверждён через `gh` и GitHub connector.
- `adb devices -l`: подключены два физических устройства в состоянии `device`.
- Fresh `pnpm run typecheck`: passed.
- Fresh filtered build для API, web player и mockup sandbox: passed.
- Fresh root `pnpm run build`: web, API и mockup прошли, старый mobile static Expo build остановился на зарезервированном Windows-порту `8081`. Этот delivery path после решения владельца считается superseded, а не целевым APK validation.
- `git diff --cached --check`: passed; sensitive-pattern scan по Git index не нашёл ключей, токенов или приватных infrastructure values.

## Commit/push

- Cleanup и операционная документация опубликованы в `main` commit `9a7d770fc053fcc64daeb337749920ce85f46506`.
- Smart Git HTTPS завершался `Recv failure: Connection was reset`, поэтому commit опубликован через GitHub Git Database API после проверки parent и полного tree SHA.
- Локальные `main`, `origin/main` и GitHub `main` выровнены на один commit.

## Следующий логичный этап реализации

- Согласовать контейнерную архитектуру и одно из трёх визуальных направлений admin dashboard.
- Уточнить границу отказа от Expo: сохранить Expo-модули через native prebuild/Gradle либо выполнить отдельную миграцию на bare React Native.
- После согласования создать `codex/coolify-modular-admin`, реализовать и проверить изменения, затем подготовить merge в `main`.

## Notes

- Web build проходит с предупреждением о chunk больше 500 kB.
- Полный root build останется красным, пока старый Expo static build не будет заменён согласованным APK pipeline.
