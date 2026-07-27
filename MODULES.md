# Apollo TrackFinder — Документация по модулям

> Web/server система Apollo TF с отдельным Apollo Platform Identity/Policy boundary и самохостящимся Docker-бэкендом. Native Android APK отложен; существующий Expo-код не является активным delivery path.
> Язык интерфейса: русский. Монорепозиторий на pnpm.

---

## Структура проекта

```
apollo-trackfinder/
├── artifacts/
│   ├── api-server/          # Бэкенд (Express + Node.js)
│   ├── admin-dashboard/     # Admin topology dashboard (React + Vite + nginx)
│   ├── platform-api/        # Apollo Platform Identity/Policy HTTP API + containers
│   ├── trackfinder-mobile/  # Существующий Expo-код; native APK delivery отложен
│   └── music-player/        # Веб-плеер (React + Vite)
├── lib/
│   ├── db/                  # Drizzle ORM + PostgreSQL схема
│   ├── platform-contract/   # Apollo Platform shared contracts
│   ├── platform-db/         # Apollo Platform repositories + immutable migrations
│   ├── api-spec/            # OpenAPI-спецификация
│   ├── api-zod/             # Zod-схемы (авто-генерация из OpenAPI)
│   └── api-client-react/    # React Query клиент (авто-генерация из OpenAPI)
└── docker-compose.yml       # Root stack: PostgreSQL + API + web + admin services
```

---

## 1. Бэкенд — `artifacts/api-server`

**Стек:** Node.js, Express, TypeScript, Drizzle ORM, pino (логи), esbuild (сборка)

### 1.1 Точка входа

| Файл           | Описание                                                                                      |
| -------------- | --------------------------------------------------------------------------------------------- |
| `src/index.ts` | Запускает HTTP-сервер на порту из `PORT` env                                                  |
| `src/app.ts`   | Создаёт Express-приложение, подключает все роутеры под `/api`, настраивает сессии и pino-http |

### 1.2 Роуты — `src/routes/`

#### `tracks.ts` — Поиск и стриминг треков

**Архитектура:** параллельный поиск по 4 источникам → ранжирование → кэш → стриминг через yt-dlp.

| Эндпоинт                   | Метод | Описание                                                                                                                                                                    |
| -------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/tracks/search`           | POST  | Поиск по `artist` + `title`. Параллельно опрашивает YouTube, SoundCloud, Bandcamp, Deezer. Результаты ранжируются и кэшируются на 1 час. Поддерживает `maxResults` (5–40).  |
| `/tracks/:id/audio-stream` | GET   | Стрим аудио. Декодирует base64url-ID трека → получает оригинальный URL источника → через yt-dlp качает и проксирует поток клиенту. Fallback: Deezer → YouTube → SoundCloud. |
| `/tracks/:id/download`     | GET   | Скачивание файла с нужным качеством (`128`, `192`, `256`, `320` kbps или FLAC). Аналогичный fallback.                                                                       |
| `/tracks/lyrics`           | GET   | Поиск текста песни по `artist` + `title` (+ `duration`). Возвращает синхронизированный LRC и/или обычный текст.                                                             |

**Безопасность:** ID треков — `source_prefix` + base64url(URL). При декодировании URL проверяется против allowlist хостов (`youtube.com`, `soundcloud.com`, `bandcamp.com`, `dzcdn.net`). Только `https://`.

#### `spotify.ts` — Интеграция Spotify

| Эндпоинт                       | Метод | Описание                                                                                                                                                                    |
| ------------------------------ | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/spotify/status`              | GET   | Проверяет, авторизован ли текущий сессионный пользователь                                                                                                                   |
| `/spotify/login`               | GET   | Инициирует OAuth 2.0 Authorization Code Flow. Генерирует state с зашифрованным session ID и nonce. `redirect_uri` определяется из `SERVER_URL` env или `PUBLIC_API_DOMAIN`. |
| `/spotify/callback`            | GET   | Обменивает код на токены, сохраняет в БД, редиректит в приложение                                                                                                           |
| `/spotify/logout`              | POST  | Удаляет токены сессии из БД                                                                                                                                                 |
| `/spotify/liked`               | GET   | Получает лайкнутые треки пользователя (пагинация)                                                                                                                           |
| `/spotify/playlists`           | GET   | Список плейлистов пользователя                                                                                                                                              |
| `/spotify/playlist/:id/tracks` | GET   | Треки конкретного плейлиста                                                                                                                                                 |
| `/spotify/top`                 | GET   | Топ-треки пользователя                                                                                                                                                      |

**Особенности:** автоматическое обновление `access_token` через `refresh_token` за 60 сек до истечения. Мобильный режим определяется по суффиксу `__m` в state — редиректит на `trackfinder://favorites`.

#### `yandex.ts` — Интеграция Яндекс Музыки

| Эндпоинт                             | Метод | Описание                                                        |
| ------------------------------------ | ----- | --------------------------------------------------------------- |
| `/yandex/token`                      | POST  | Сохраняет OAuth-токен (пользователь вводит вручную из браузера) |
| `/yandex/status`                     | GET   | Статус подключения                                              |
| `/yandex/disconnect`                 | POST  | Удаляет токен из БД                                             |
| `/yandex/liked`                      | GET   | Лайкнутые треки через `api.music.yandex.net`                    |
| `/yandex/playlists`                  | GET   | Плейлисты пользователя                                          |
| `/yandex/playlist/:uid/:kind/tracks` | GET   | Треки плейлиста                                                 |

**Особенности:** использует мобильный User-Agent (`YandexMusicAndroid/24023621`), без PKCE — пользователь сам вставляет OAuth-токен.

#### `health.ts`

`GET /health` — возвращает статус сервера и версию.

#### `module-heartbeats.ts` — Heartbeat независимых модулей

`POST /api/internal/modules/:moduleId/heartbeat` принимает только JSON heartbeat
от заранее настроенного модуля. Отправитель посылает его каждые 30 секунд.
`moduleId` должен иметь отдельный ключ в API-only JSON map
`APOLLO_MODULE_HEARTBEAT_KEYS`; production startup требует entries
`search-media`, `account-integrations` и `download-worker`, например
`{"search-media":"<search-secret>","account-integrations":"<integrations-secret>","download-worker":"<download-secret>"}`.
Пустая, невалидная, неполная или отсутствующая map завершает startup общей
ошибкой `invalid runtime configuration` без вывода key names или values.
Endpoint по-прежнему fail-closed, если ingestion создаётся отдельно без
настроенной map.

Запрос использует заголовки `X-Apollo-Heartbeat-Timestamp` (целое Unix-время в секундах), `X-Apollo-Heartbeat-Nonce` и `X-Apollo-Heartbeat-Signature`. Для raw UTF-8 body вычисляется `bodySha256` как lowercase hex SHA-256. Точная canonical string, включая символы новой строки, имеет вид:

```text
POST
/api/internal/modules/<moduleId>/heartbeat
<unix-seconds>
<nonce>
<bodySha256>
```

`X-Apollo-Heartbeat-Signature` равен `v1=<hex HMAC-SHA256(canonical string, per-module secret)>`. API принимает корректно подписанный timestamp только в своём окне допуска и защищает nonce от повтора. Полезная нагрузка имеет `schemaVersion: 1`, `status`, `version`, а также опциональные `deployedAt` и `requestsPerMinute`.

Принятый heartbeat остаётся свежим 90 секунд. После этого в admin snapshot статус модуля становится `unknown`, а `lastHeartbeatAt` сохраняет последнее подтверждённое получение. Состояние хранится в памяти API: перезапуск API возвращает настроенные модули к `unknown` до следующего успешного heartbeat. Ключи не передаются web/admin/db/redis контейнерам и не попадают в Vite bundle или nginx.

### 1.3 Адаптеры — `src/adapters/`

Каждый адаптер нормализует ответ источника в единый тип `NormalizedTrack`.

| Файл            | Источник   | Метод поиска                             |
| --------------- | ---------- | ---------------------------------------- |
| `youtube.ts`    | YouTube    | `yt-dlp --dump-json ytsearch:N "запрос"` |
| `soundcloud.ts` | SoundCloud | `yt-dlp --dump-json scsearch:N "запрос"` |
| `bandcamp.ts`   | Bandcamp   | Парсинг HTML страницы поиска Bandcamp    |
| `deezer.ts`     | Deezer     | REST API `api.deezer.com/search`         |

**Поле `id` трека:** `{source}_{base64url(originalUrl)}`  
Примеры: `yt_aHR0cHM6...`, `sc_aHR0cHM6...`, `bc_...`, `dz_...`

### 1.4 Библиотеки — `src/lib/`

#### `classifier.ts` — Классификация треков

Определяет тип трека по заголовку через регулярные выражения:

| Тип        | Паттерны                                                                         |
| ---------- | -------------------------------------------------------------------------------- |
| `original` | (по умолчанию, если ничего не подошло)                                           |
| `remix`    | remix, rmx, bootleg, flip, edit, extended, club mix, radio edit, instrumental... |
| `live`     | live, concert, tour, acoustic, unplugged, session, at ...@                       |
| `cover`    | cover, tribute, originally by, sung by                                           |

#### `ranker.ts` — Ранжирование результатов

Оценивает каждый трек числовым `score` на основе:

- Jaccard-сходство токенов заголовка/исполнителя с запросом
- Точное совпадение строк (бонус)
- Близость длительности к эталону (если передана)
- Приоритет типа (original > remix > live > cover)
- Количество просмотров/воспроизведений (логарифмически)

Использует Unicode-нормализацию NFD для сравнения строк на разных языках.

#### `cache.ts` — Кэш поиска

- Ключ: `artist::title` (нижний регистр)
- Хранение: PostgreSQL таблица `track_search_cache` (JSONB)
- TTL: 1 час
- При стандартном поиске (`maxResults ≤ 20`) кэш используется автоматически

#### `ytdlp.ts` — Обёртка над yt-dlp

- `ytdlpSearch(query, limit)` — поиск через `ytsearch:` / `scsearch:`
- `getStreamUrl(url)` — получает прямой URL потока (для редиректа)
- `spawnAudioDownload(url, quality)` — спавнит дочерний процесс yt-dlp, пайпит stdout в Response
- Таймаут: 30 сек
- yt-dlp устанавливается через pip при сборке Docker-образа (всегда последняя версия)

#### `migrate.ts` + `logger.ts`

- `migrate.ts` — запускает Drizzle-миграции при старте сервера
- `logger.ts` — конфигурирует pino (JSON-логи в production, красивый вывод в dev)

---

## 1A. Apollo Platform — `artifacts/platform-api` + `lib/platform-*`

Apollo Platform является отдельной Identity/Policy границей, а не частью Apollo TF media API. Он реализует режимы регистрации `closed`, `invite_only` и `open_approval`, invitation lifecycle, verification, операторские сессии, module entitlements и server-side policy evaluation.

HTTP runtime использует versioned contract и доменные сервисы из `lib/platform-*`. Readiness становится успешной только при готовом Redis и точном наборе имён/checksum immutable PostgreSQL migrations `0001`–`0003`; runtime не запускает миграции. Migrator и runtime используют отдельные роли с минимальными правами.

Локальный production-compatible stack находится в `artifacts/platform-api/docker-compose.yml` и содержит отдельные `platform-postgres`, `platform-redis`, one-shot `platform-migrate` и `platform-api`; private profile `platform-smoke` выполняет end-to-end policy проверку без test-only public route. PostgreSQL и Redis не публикуют host ports, API привязан только к loopback. Образ Debian/glibc запускает API от numeric UID/GID `10001:10001`; app tree остаётся root-owned/non-writable, а runtime services используют `read_only: true`.

Smoke проверяет generic external failure contract без раскрытия валидности токена: status и полное JSON body consumed invitation сравниваются с unknown invitation, а consumed verification token — с unknown verification token. Динамический `requestId` нормализуется только после проверки его совпадения с response header; остальные наблюдаемые поля сравниваются полностью.

File-backed top-level secrets подключаются напрямую в `/run/secrets/*` без volume/tmpfs overmount. Для Linux smoke создаёт private host directory с mode `0700`, записывает файлы закрыто и затем принудительно выставляет им read-only mode `0444`: закрытый parent запрещает другим host users обход пути, а read bits позволяют non-root UID/GID `10001:10001` прочитать отдельный bind-mounted file. Smoke проверяет mode перед Compose startup и удаляет directory только после `docker compose down -v --remove-orphans`. Docker Desktop представляет bind-backed files со своими ownership/mode semantics, поэтому Compose `uid`/`gid`/`mode` не заявляются. Это локальный Linux-compatible delivery contract и локальный Docker Desktop smoke, а не validation или deployment в Coolify/HomeNode.

Остаточные deployment constraints: PostgreSQL role initialization выполняется только для нового data volume. При сохранённом volume ротация migrator/runtime passwords требует согласованного изменения паролей ролей и соответствующих URL secrets; простая замена файлов без обновления ролей нарушит подключение. Используемые base image tags (`node:20-bookworm-slim`, `postgres:16-bookworm`, `redis:7-bookworm`) пока не закреплены digest-значениями, поэтому digest pinning остаётся обязательным release-hardening шагом перед удалённым production rollout.

Final whole-branch hardening закрывает пять локально найденных границ. Smoke case-insensitively отклоняет inherited BuildKit/Buildx/Bake routing selectors до любого Docker вызова и принудительно использует `COMPOSE_BAKE=false` после проверки exact local Docker selector. Migration runner загружает только exact file-backed manifest, сверяет имена/checksums до подключения и отклоняет extra persisted history; readiness читает всю migration history, поэтому missing, changed и extra rows дают `503`. Account activation и effective-entitlement listing учитывают только entitlements активных modules, а repository проецирует module state из PostgreSQL. Application construction проверяет actual protected-route capability mapping до регистрации routes.

PostgreSQL pools имеют bounded локальные defaults. Runtime profile: connection `5s`, query/statement `10s`, lock `3s`, idle-in-transaction `10s`, idle pool `30s`, максимум `10` connections. One-shot migrator profile: connection `10s`, query/statement `120s`, lock `10s`, idle-in-transaction `30s`, idle pool `30s`, максимум `2` connections. Transaction helper сохраняет исходную ошибку timeout/query и discard-ит client при неуспешном rollback. Эти значения являются кодовыми defaults, а не проверенными remote deployment settings.

Final narrow follow-up закрывает ещё две race/cleanup границы. PolicyService принимает allow-решение только если более поздняя entitlement projection также сообщает `moduleState: active`; disable между module lookup и entitlement read теперь даёт fail-closed `module_access_denied`. Migration runner отдельно хранит primary operation failure и cleanup failure: rollback и advisory unlock по-прежнему предпринимаются в bounded migration pool, cleanup failure передаётся в `client.release(error)` для уничтожения client, primary error не маскируется, а cleanup-only failure возвращается вызывающему коду.

Advisory-lock acquisition также считается uncertain connection state: если `pg_advisory_lock` завершается ошибкой или client-side timeout, runner сохраняет точный primary error для вызывающего кода и передаёт тот же `Error` в `client.release(error)`, чтобы pool уничтожил client. Поскольку успешное получение lock не подтверждено, runner не заявляет и не выполняет advisory unlock; существующие rollback/unlock cleanup guarantees остаются без изменений.

Native Android delivery остаётся отдельным будущим этапом: текущая Apollo Platform foundation предназначена для web/server workflows, а Android должен поставляться как отдельно проверяемый APK.

---

## 2. Мобильное приложение — `artifacts/trackfinder-mobile`

**Состояние:** существующий Expo SDK 53 / React Native код сохранён как исходная база, но Expo Go и static export не являются активным delivery path. Android delivery отложен до отдельного native APK этапа с проверкой через ADB.

### 2.1 Экраны — `app/(tabs)/`

#### `index.tsx` — Поиск треков (главный экран)

- TextInput для ввода запроса (artist + title)
- Фильтры по типу: Все / Оригинал / Ремикс / Живое / Кавер
- Пагинация: первые 20 результатов, кнопка «Загрузить ещё» (40 следующих)
- Подключается к `/tracks/search` через `apiFetch`
- Поддерживает deep link параметры: `?artist=`, `?title=`, `?q=`
- Каждый трек отображается через `TrackCard`

#### `library.tsx` — Личная библиотека

- Отображает все сохранённые треки из `useLibrary`
- **Поиск/фильтр** по названию и исполнителю (TextInput в шапке)
- **Сортировка:** Новые / Старые / Плейлист (по importOrder)
- **Режим выбора:** чекбоксы → массовое скачивание / удаление
- **Свайп влево** по треку: скачать / удалить (Swipeable)
- Статистика: кол-во треков, объём скачанных файлов
- При нажатии на трек запускает `playQueue(filteredTracks, index)` — весь список становится очередью плеера

#### `favorites.tsx` — Избранное / Импорт

Объединяет интеграции Spotify и Яндекс Музыки в одном экране.

**Spotify:**

- Авторизация через OAuth (открывает браузер → сервер → redirect)
- Вкладки: Liked Songs / Плейлисты / Топ треков
- Поиск трека по исполнителю → переход на главный экран с поисковым запросом
- Массовый импорт через `BatchImportModal`

**Яндекс Музыка:**

- Авторизация через ручной ввод OAuth-токена
- Вкладки: Лайкнутые / Плейлисты
- Просмотр треков плейлиста, поиск, импорт

### 2.2 Хуки — `hooks/`

#### `use-player.tsx` — Глобальный плеер

Центральный контекст воспроизведения. Предоставляет:

| Состояние      | Тип                        | Описание                  |
| -------------- | -------------------------- | ------------------------- |
| `currentTrack` | `PlayerTrack \| null`      | Текущий трек              |
| `queue`        | `PlayerTrack[]`            | Полная очередь            |
| `queueIndex`   | `number`                   | Позиция в очереди         |
| `shuffle`      | `boolean`                  | Режим перемешивания       |
| `repeat`       | `'none' \| 'one' \| 'all'` | Режим повтора             |
| `isPlaying`    | `boolean`                  | Состояние воспроизведения |
| `isLoading`    | `boolean`                  | Загрузка аудио            |
| `position`     | `number`                   | Позиция в секундах        |
| `duration`     | `number`                   | Длительность в секундах   |

| Метод                           | Описание                                             |
| ------------------------------- | ---------------------------------------------------- |
| `play(track)`                   | Играть одиночный трек (очередь = [track])            |
| `playQueue(tracks, startIndex)` | Играть список, начиная с индекса                     |
| `playNext()`                    | Следующий трек (с учётом shuffle)                    |
| `playPrev()`                    | Предыдущий трек или перемотка в начало (если >3 сек) |
| `pause() / resume()`            | Пауза / продолжение                                  |
| `stop()`                        | Остановить и очистить очередь                        |
| `seek(pos)`                     | Перемотка в секундах                                 |
| `toggleShuffle()`               | Переключить перемешивание                            |
| `cycleRepeat()`                 | Цикл: none → all → one → none                        |

**Как работает авто-переход:**  
Статус-коллбэк `expo-av` (`didJustFinish`) считывает режимы из refs (без stale closure), затем:

- `repeat: 'one'` → воспроизвести тот же трек
- `repeat: 'all'` → следующий, при конце очереди — с начала
- `shuffle: true` → случайный индекс ≠ текущий
- Иначе → следующий по порядку, стоп в конце

Интервал обновления позиции: **250 мс** (точный тайминг на Android).  
Режим аудио: `staysActiveInBackground: true`, `playsInSilentModeIOS: true`.

URI трека: сначала проверяется `localUri` (размер > 0 байт), иначе — прокси-стрим через `/tracks/:id/audio-stream`.

#### `use-library.tsx` — Библиотека треков

Хранит список скачанных треков в `AsyncStorage` (ключ `trackfinder_library`).

| Метод                              | Описание                                                                                 |
| ---------------------------------- | ---------------------------------------------------------------------------------------- |
| `saveToLibrary(track)`             | Добавить трек в библиотеку (без скачивания файла)                                        |
| `download(track)`                  | Скачать аудио через `/download` → сохранить в файловую систему устройства (MediaLibrary) |
| `bulkDownload(tracks)`             | Массовое скачивание с прогрессом и возможностью отмены                                   |
| `remove(id)`                       | Удалить трек и файл с диска                                                              |
| `bulkRemove(ids)`                  | Массовое удаление                                                                        |
| `isSaved(id)` / `isDownloaded(id)` | Проверки статуса                                                                         |

Качество скачивания берётся из `use-settings.tsx` (128 / 192 / 256 / 320 kbps / FLAC).

#### `use-session.ts` — Сессия и API

- Генерирует уникальный `session_id` (сохраняется в `AsyncStorage`)
- Хранит URL API-сервера (настраивается в `ServerSettings`)
- По умолчанию использует `EXPO_PUBLIC_DOMAIN` env var (устанавливается при сборке)
- `apiFetch<T>(path)` — типизированный fetch с `X-Client-Session` заголовком
- `sessionHeaders()` — возвращает заголовки сессии для запросов

#### `use-settings.ts` — Настройки качества

Хранит выбранное качество скачивания в `AsyncStorage`.  
Доступные значения: `128`, `192`, `256`, `320` kbps, `flac`.  
Экспортирует `useDownloadQuality()` хук с реактивным обновлением через listener-паттерн.

#### `use-spotify.ts` / `use-yandex.ts` — Интеграции

Обёртки над API-запросами к соответствующим эндпоинтам сервера.  
Используют кастомные хуки (React Query-стиль) с состояниями загрузки/ошибки.

### 2.3 Компоненты — `components/`

#### `MiniPlayer.tsx` — Мини-плеер

Всегда показывается поверх контента когда играет трек.

- Обложка трека, название, исполнитель, таймер
- Прогресс-бар (2px линия сверху)
- Кнопки: `▶/⏸`, `⏭` (следующий), `✕` (стоп)
- Тап на плеер → открывает `FullPlayer`
- Анимация появления/скрытия: `FadeInDown / FadeOutDown` (react-native-reanimated)

#### `FullPlayer.tsx` — Полноэкранный плеер (Spotify-стиль)

Открывается как `Modal` с `pageSheet` анимацией.

**Структура экрана (сверху вниз):**

1. Drag-handle + кнопка закрытия + бейджи источника/типа
2. Обложка альбома (280px или SCREEN_W - 80)
3. Название и исполнитель
4. Seek-bar с таймером
5. Кнопки: `🔀 Shuffle` | `⏮ Prev` | `⏯ Play/Pause` | `⏭ Next` | `🔁 Repeat`
6. Разделитель «Текст песни»
7. Прокручиваемый текст (синхронизированный LRC или обычный)

**Возможности:**

- Свайп вниз (Δy > 80px, Δx < 60px) закрывает плеер
- Текст загружается **автоматически** при открытии плеера
- LRC-синхронизация: активная строка увеличивается и выделяется, прокрутка следует за музыкой
- Shuffle и Repeat показывают зелёную точку-индикатор когда активны
- Repeat icon меняется: `repeat` (all) ↔ `repeat-one` (one)

#### `TrackCard.tsx` — Карточка трека в поиске

- Обложка, название, исполнитель, источник, тип, длительность, качество
- Кнопка Play → `play(track)` через `usePlayer`
- Кнопка «Сохранить» → `saveToLibrary` + `download`
- Кнопка «Варианты» → поиск похожих треков
- Активный трек подсвечивается акцентным цветом

#### `SavedTrackCard.tsx` — Карточка трека в библиотеке

- Расширенная карточка с поддержкой Swipeable (react-native-gesture-handler)
- Свайп влево → кнопки «Скачать» / «Удалить»
- Долгое нажатие → `TrackActionSheet` (контекстное меню)
- Чекбокс в режиме выбора
- Индикатор прогресса скачивания
- Бейдж качества (FLAC / 320 kbps / и т.д.)
- При нажатии вызывает `onPlay(track)` → библиотека передаёт `playQueue`

#### `TrackActionSheet.tsx` — Контекстное меню

Action Sheet с опциями: воспроизвести, скачать, удалить, найти по исполнителю, поделиться.

#### `BatchImportModal.tsx` — Массовый импорт

Модальное окно для импорта списка треков из Spotify/Яндекс.  
Показывает прогресс: сохранено X из N, ошибок: Y.

#### `ServerSettings.tsx` — Настройки сервера

Экран ввода URL самохостящегося API-сервера.  
Сохраняет URL в `AsyncStorage` через `use-session.ts`.

#### `MaterialIcons.tsx`, `ErrorBoundary.tsx`, `ErrorFallback.tsx`

Вспомогательные компоненты: иконки Material Design, обработка ошибок рендера.

---

## 3. Веб-плеер — `artifacts/music-player`

**Стек:** React 19, Vite, TypeScript, Tailwind CSS, TanStack Query, shadcn/ui

### 3.1 Экраны

| Файл                      | Описание                                            |
| ------------------------- | --------------------------------------------------- |
| `src/pages/Home.tsx`      | Поиск треков, воспроизведение через `<audio>` HTML5 |
| `src/pages/Favorites.tsx` | Сохранённые треки (localStorage)                    |

### 3.2 Особенности

- Использует `lib/api-client-react` для типизированных запросов к серверу
- Сессия хранится в `sessionStorage` (аналог мобильной)
- Воспроизведение через нативный `<audio>` элемент браузера
- Адаптивная сетка карточек треков

---

## 4. Admin topology dashboard — `artifacts/admin-dashboard`

**Стек:** React 19, Vite, TypeScript, React Flow, Dagre, Framer Motion, Vitest, nginx.

- Отдельный operational UI на feature branch `codex/feat/admin-topology-dashboard`; `artifacts/music-player` и HomeNode не менялись.
- Визуальная основа -- вариант 2: центральная topology-схема с устойчивым left-to-right layout. Из варианта 1 добавлены четыре метрики; incident rail поддерживает фильтрацию и service focus. Локальный acknowledgement доступен только в demo mode, remote mode явно read-only.
- `DashboardSnapshotAdapter` объявляет mode/capabilities; CommandBar показывает `Демо` для demo adapter и `Продакшн` для HTTP adapter. Demo mode стартует live из `demoSnapshot`. Production HTTP mode сразу загружает same-origin `/api/admin/dashboard`, удерживает визуальный fallback в непроверенном refreshing/offline состоянии, становится live только после валидного remote snapshot и stale только после последующего отказа.
- Каждый HTTP 200 JSON проходит Zod validation до state mutation: поля/enums/timestamps, ровно четыре metrics, bounded collections, unique IDs для metrics/modules/edges/incidents/providers и edge/incident service references. HTTP adapter имеет 10-second abort timeout и single-flight refresh.
- Production browser не получает API base или service token. nginx требует operator Basic Auth для UI и admin proxy, rate-limits dashboard probes, затем добавляет `X-Admin-Dashboard-Token` только для exact `GET /api/admin/dashboard`; non-GET exact path возвращает `405`, остальные `/api/*` -- `404` без proxy/token. `/healthz` остаётся доступен без operator credentials. При пустых `ADMIN_ACCESS_USER`/`ADMIN_ACCESS_PASSWORD` UI закрыт по умолчанию.
- `pnpm` override фиксирует `lodash@4.18.1` для `dagre`/`graphlib`; parsed production audit содержит 0 admin paths. Final re-review verification включает 8 files / 62 tests, dashboard/workspace typecheck, production build, Docker `/healthz` с unresolvable upstream, warning-free Compose config и scoped audit evidence.
- Backend реализует `GET /api/admin/dashboard`: пустой `ADMIN_DASHBOARD_TOKEN` безопасно отключает route с `503`, неверный `X-Admin-Dashboard-Token` получает `401`, а успешный ответ проходит общий `@workspace/admin-dashboard-contract` и отправляется с `Cache-Control: no-store`. Токены сравниваются по SHA-256 digest через `timingSafeEqual` и редактируются из request logs.
- Текущая telemetry boundary ограничена процессом API: bounded 60-second HTTP counters, 5xx rate, download queue, coalesced PostgreSQL probe с connection/query/statement timeout и раздельные состояния cache Redis/Queue Redis. BullMQ workers, producers и короткий telemetry probe используют отдельные Redis connections: telemetry timeout не останавливает workers и не переключает enqueue routing на in-memory backend. Сбой queue probe даёт partial snapshot с `Нет данных`, а не общий `503`. Непроверенные внешние контейнеры и providers честно получают `unknown`; пользовательские Spotify/Yandex credentials не используются как global health probe. Deployment в Coolify/HomeNode не выполнялся.

---

## 5. База данных — `lib/db`

**ORM:** Drizzle ORM + PostgreSQL  
**Провайдер:** встроенный PostgreSQL (через `DATABASE_URL` env)

### 5.1 Схема

#### `track_search_cache`

```sql
id          SERIAL PRIMARY KEY
cache_key   TEXT UNIQUE NOT NULL        -- "artist::title"
results     JSONB NOT NULL              -- массив NormalizedTrack[]
expires_at  TIMESTAMP WITH TIMEZONE    -- TTL 1 час
created_at  TIMESTAMP WITH TIMEZONE
```

#### `spotify_tokens`

```sql
id              SERIAL PRIMARY KEY
session_id      TEXT UNIQUE NOT NULL    -- клиентская сессия
access_token    TEXT NOT NULL
refresh_token   TEXT NOT NULL
expires_at      TIMESTAMP WITH TIMEZONE
spotify_user_id TEXT
display_name    TEXT
created_at / updated_at  TIMESTAMP
```

#### `yandex_tokens`

```sql
id              SERIAL PRIMARY KEY
session_id      TEXT UNIQUE NOT NULL
oauth_token     TEXT NOT NULL           -- вводится пользователем вручную
yandex_user_id  TEXT
display_name    TEXT
login           TEXT
created_at / updated_at  TIMESTAMP
```

### 5.2 Миграции

Drizzle Kit. Миграции запускаются **автоматически при старте** сервера (`src/lib/migrate.ts`).

---

## 6. Общие библиотеки — `lib/`

### `lib/api-spec` — OpenAPI-спецификация

`openapi.yaml` — единый контракт между клиентами и сервером.  
Описывает все эндпоинты, типы запросов/ответов.

### `lib/api-zod` — Zod-валидация

Авто-генерируется из `openapi.yaml` через Orval.  
Используется сервером для валидации входящих запросов:

```typescript
const parseResult = SearchTracksBody.safeParse(req.body);
```

Типы: `TrackResult`, `SearchRequest`, `SearchResponse`, `DownloadResponse`, `TrackSource`, `TrackType`, `StreamResponse`, `HealthStatus`, `ErrorResponse`

### `lib/api-client-react` — React Query клиент

Авто-генерируется из `openapi.yaml` через Orval.  
Используется веб-плеером для запросов с типовой безопасностью.  
Включает кастомный `custom-fetch.ts` с сессионными заголовками.

---

## 7. Деплой — Docker

### `artifacts/platform-api/Dockerfile` и `docker-compose.yml`

Root-context multi-stage build использует Debian/glibc Node 20 и pinned `pnpm@10.33.2`, собирает только нужный workspace subset и производит `dist/index.mjs`, `dist/migrate.mjs` и private `dist/policy-smoke.mjs`. Production dependency closure включает native Argon2; image verification выполняет реальный `hash` + `verify`, а не только dynamic import. Runtime image запускается от UID `10001` с root-owned read-only app tree.

Compose запускает PostgreSQL, Redis, one-shot migrator и API раздельно. Migrator применяет immutable migration bundle до старта готового API; API не выполняет startup migrations. `/healthz` отражает process liveness, а `/readyz` отдельно требует Redis readiness и точный migration manifest. Локальный smoke использует generated per-run secrets, loopback API port, private policy runner и гарантированный teardown с volumes/orphans; это локальная validation, а не deployment в Coolify/HomeNode.

Migration `0004_authorization_code_binding.sql` берёт `ACCESS EXCLUSIVE` lock и прерывает transaction со статической ошибкой, если legacy `authorization_codes` не пуст. Перед rollout нужно остановить выдачу новых кодов, дождаться истечения/потребления pending codes или явно удалить их после backup/audit, затем повторить migration. Ошибка сохраняет строки и откатывает transaction. После успешного применения откат схемы требует отдельной согласованной migration и не выполняется при наличии новых кодов.

### `artifacts/api-server/Dockerfile`

Root-context multi-stage build использует Debian/glibc Node 20 и pinned `pnpm@10.33.2`. Runtime устанавливает Python, FFmpeg и `yt-dlp`, запускается как UID/GID `10001:10001`, сохраняет read-only application tree и пишет только в объявленные tmpfs-пути. Entrypoint читает `DATABASE_URL_FILE` до импорта bundle и не выводит значение. Pino worker bundles сохраняют builder path `/app/artifacts/api-server/dist`.

### Локальный Platform-TF bridge

`artifacts/platform-api/docker-compose.bridge.yml` содержит ровно семь сервисов:

```text
platform-postgres
platform-redis
platform-migrate
platform-api
tf-postgres
tf-redis
tf-api
```

Platform PostgreSQL/Redis доступны только в `platform-data`, TF PostgreSQL/Redis -- только в `tf-data`. Только `platform-api` и `tf-api` состоят в `platform-tf-control`; отдельная `bridge-edge` нужна лишь для одноразовых loopback TLS listener локального smoke. У баз данных и Redis нет host ports. Platform и TF используют разные роли, URL, secrets и volumes; ни один API не получает database secret другого продукта.

Platform signing JWK/JWKS и OAuth client registry, TF confidential client secret и TF database URL подключаются как file-backed secrets. API/migrator работают без root, с read-only root filesystem, `no-new-privileges` и `cap_drop: ALL`. Disposable smoke проверяет браузерный TLS + PKCE S256, одноразовый OAuth code, live grant/revoke, одноразовый WebSocket ticket и close `4403`, после чего сканирует config/logs/projections/tracked bytes и удаляет project containers, networks, volumes и временные каталоги.

Public Platform issuer и server-to-server control origin разделены. В production оба используют одобренный HTTPS. Внутренний `http://platform-api:8080` разрешён только явным disposable bridge flag в development; deterministic PKCE verifier также доступен только из bridge secret file и не заменяет production `randomBytes`.

### Контейнерный `tf-integrations`

Compose поставляет три независимо размещаемых сервиса:

```text
tf-integrations-postgres
tf-integrations-migrate
tf-integrations
```

`tf-integrations-postgres` -- отдельный PostgreSQL 17 Bookworm с базой
`apollo_tf_integrations`; он не разделяет volume, database, role или URL с TF
API и Apollo Platform. One-shot `tf-integrations-migrate` подключается ролью
`apollo_tf_integrations_migrator`, а runtime `tf-integrations` -- отдельной
ролью `apollo_tf_integrations_runtime`. Мигратор обязан успешно завершиться
после database health check до старта runtime. Существующие legacy
provider-token tables и данные TF API не импортируются, не изменяются и не
удаляются.

Immutable migrations `0001`--`0004` не меняются. Additive
`0005_provider_account_generation.sql` добавляет обязательный UUIDv4
`generation` существующим provider-account rows и удаляет database default
после backfill. Каждый repository upsert/reconnect создаёт новый
криптографически случайный generation. Spotify refresh выполняет только
`UPDATE ... WHERE generation = <loaded generation>` и никогда не вставляет
missing row, поэтому in-flight refresh не восстанавливает disconnect и не
перезаписывает reconnect.

`0004_runtime_privileges.sql` удаляет прежние default table grants, отзывает
все runtime grants на migration-owned tables и затем явно выдаёт только
`SELECT/INSERT/UPDATE/DELETE` на `provider_accounts` и `SELECT` на
`schema_migrations`. Обе таблицы остаются во владении migrator role; runtime
не может pre-seed, insert, update, delete или truncate migration history.
Role-init принимает password files размером только `1..512` bytes и задаёт
PostgreSQL bootstrap limits: connection `10s`, statement `30s`, lock `5s`.
Каждая будущая таблица требует отдельного reviewable grant.

API вызывает exact `POST /v1/commands`. Поддерживаемые account-bound
операции:

```text
spotify.oauth.authorize
spotify.oauth.complete
spotify.status
spotify.disconnect
spotify.liked.list
spotify.playlists.list
spotify.playlist-tracks.list
spotify.top-tracks.list
yandex.token.upsert
yandex.status
yandex.disconnect
yandex.liked.list
yandex.playlists.list
yandex.playlist-tracks.list
```

API и модуль совместно получают только
`tf_integrations_internal_auth_secret`; API читает его через
`TF_INTEGRATIONS_INTERNAL_AUTH_SECRET_FILE`. Подпись передаётся в
`X-Apollo-Internal-Signature` как `v1=<hex HMAC-SHA256>` над canonical bytes
`METHOD + "\n" + path + "\n" + timestamp + "\n" + nonce + "\n" +
sha256(rawBody)`. Timestamp и 32-byte base64url nonce находятся в
`X-Apollo-Internal-Timestamp` и `X-Apollo-Internal-Nonce`; окно timestamp --
60 секунд. Модуль сначала аутентифицирует exact raw bytes, timestamp и
signature, затем строго разбирает command. Readiness и module-concurrency
rejection происходят до nonce claim в canonical account partition. Replay
state хранит до `256` live nonces на каждый canonical account в пределах не
более `256` account partitions. Shared global nonce pool отсутствует, live
nonces не вытесняются и хранятся ровно до конца signed replay-valid окна;
исчерпание account или partition capacity возвращает явный `503`. Заполнение
одного account partition не блокирует остальные accounts. Только literal
`/v1/commands` допустим: query, fragment, trailing slash и любой дополнительный
request target получают `404` без path canonicalization. Command key обязан
отличаться от `tf_integrations_heartbeat_secret`.

Модуль получает только шесть runtime secrets:
`tf_integrations_runtime_database_url`, `tf_integrations_token_keyring`,
`tf_integrations_spotify_client_id`,
`tf_integrations_spotify_client_secret`,
`tf_integrations_internal_auth_secret` и
`tf_integrations_heartbeat_secret`. Keyring file имеет exact JSON-формат:

```json
{
  "activeKeyId": "rotation-id",
  "keys": {
    "rotation-id": "<32-byte base64url key>"
  }
}
```

Допустимо от одного до четырёх разных 32-byte keys. Новая запись использует
`activeKeyId`; чтение поддерживает остальные keys для контролируемой rotation.
Provider token сохраняется только как AES-256-GCM envelope версии 1 с
12-byte nonce, 16-byte authentication tag и AAD
`apollo-tf-integrations-token:v1:<provider>:<accountId>`. Provider и account
тем самым криптографически привязаны к ciphertext; plaintext token не
сохраняется.

Модуль отправляет подписанный heartbeat `account-integrations` сразу после
готовности и затем каждые 30 секунд. API считает последнее состояние свежим
90 секунд. До первого valid heartbeat и после API restart внешний модуль
имеет status `unknown`; после expiry он снова `unknown` и восстанавливается
только новым valid heartbeat. Heartbeat stop повторно проверяет shutdown
после awaited readiness и не создаёт поздний request. Readiness модуля зависит
только от exact migration history и bounded database capability probe, который
требует PostgreSQL 17+ и доступный session parameter `transaction_timeout`;
PG16 или отсутствие capability fail-closed возвращают `503` readiness.
Недоступность Spotify/Yandex не делает `/readyz` неуспешным.

Каждая command получает единый abort signal от HTTP disconnect, runtime
shutdown и fixed `8s` deadline, который короче API gateway timeout `10s`.
Каждая mutation до `BEGIN` устанавливает session `transaction_timeout` из
оставшегося absolute budget и оставляет его активным через `COMMIT`.
Transaction-local statement/lock timeouts сохраняются как defense in depth, а
session setting сбрасывается перед возвратом исправного client в pool. Abort,
deadline или uncertain transaction/reset outcome уничтожает checked-out
connection, поэтому PostgreSQL откатывает незавершённую transaction. После
validation и serialization ответа HTTP path выполняет финальную deadline check
до отправки response bytes.
Module допускает не более `32` active commands; provider boundary -- `8`
active calls плюс `24` queued. Spotify/Yandex читают response JSON streaming
с limit `1 MiB`, передают signal во все fixed HTTPS endpoints и
cancel/drain non-OK, malformed, oversized, stalled и non-terminating bodies.
Provider availability и эти I/O limits не входят в readiness.

Сеть `tf-integrations-control` является internal и содержит только `api` и
`tf-integrations`. Internal `tf-integrations-data` содержит только module,
migrator и dedicated PostgreSQL. Только module подключён к
`tf-integrations-egress`; у module, migrator и database нет host ports.
Runtime и migrator запускаются как numeric UID/GID `10001:10001` с
read-only root/app filesystem, `init`, `cap_drop: ALL`,
`no-new-privileges` и bounded tmpfs. Builder и runtime основаны на Node 24
Krypton LTS Bookworm.

Все integration secret assignments используют long-form Compose
`source`/`target` и документируют owner/mode. Для file-backed Compose secrets
эти `uid`/`gid`/`mode` поля не применяют ownership сами: на native Linux
источники должны быть заранее созданы с host owner `10001:10001` для
API/module/migrator и `999:999` для PostgreSQL-only password files, mode
`0400`. Private parent остаётся `root:root` mode `0700`. Docker Desktop
переназначает bind-backed owner/mode и предупреждает, что metadata
игнорируется; local smoke поэтому честно отмечает non-native evidence и
проверяет exact read-only mounts, regular/readable/non-writable targets и
отсутствие лишних owners, но не заявляет native owner/mode validation.

На одной ноде допустимы только exact origins
`http://tf-integrations:8080` с
`TF_INTEGRATIONS_ALLOW_INSECURE_HTTP=true` и `http://api:8080` с
`TF_INTEGRATIONS_HEARTBEAT_ALLOW_INSECURE_HTTP=true`. Для будущего
cross-node размещения возможен только separately approved HTTPS ingress
`https://integrations.tf.apollot.ru` с обычной проверкой сертификата и
hostname, без insecure flags и redirects. Такой ingress, а также Caddy, UFW,
DNS и remote rollout требуют отдельного approval; Task 6 их не изменяет.

`TF_INTEGRATIONS_SMOKE_FIXTURES=true` принимается только вместе с exact
`NODE_ENV=test`. Production отклоняет этот flag. Fixture adapters не выполняют
provider calls и нужны только для disposable local smoke с encrypted
at-rest записью.

### Контейнерный `tf-search`

`tf-search` разворачивается отдельным контейнером и получает только
`tf_search_internal_auth_secret` для команд API и отдельный
`tf_search_heartbeat_secret` для heartbeat `search-media`. API получает первый
ключ и file-backed map `tf_module_heartbeat_keys`; heartbeat secret не
монтируется в API. Командный и heartbeat ключи обязаны различаться.

На одной ноде API использует private DNS `http://tf-search:8080` с явным
local-only флагом. Сеть `tf-search-control` является internal, а
`tf-search-egress` подключена только к поисковому контейнеру. У `tf-search` нет
host port, доступа к `tf-data`, `tf-edge`, PostgreSQL, Redis, Platform,
provider-account credentials или control-plane. Для размещения на другой ноде
допускается только точный HTTPS origin с обычной проверкой сертификата и
hostname; редиректы запрещены.

Первый release: одна реплика, replay state и LRU-like cache хранятся
в памяти процесса. Cache ограничен 2 048 записями и TTL один час, поэтому
перезапуск выполняет cold start. Для HMAC timestamp на всех нодах обязательна
синхронизация часов. Для локального same-node этапа новый домен не нужен.
HomeNode, Coolify, Caddy, UFW и DNS не изменялись.

### Контейнерный `tf-download-worker`

Download stack состоит из `tf-download-redis` и ровно одной реплики
`tf-download-worker`. Публичный клиент работает только через API:
`POST /api/tracks/download/queue`, `GET /api/tracks/download/jobs`,
`GET /api/tracks/download/status/:jobId`,
`GET /api/tracks/download/file/:jobId` и
`DELETE /api/tracks/download/jobs/:jobId`. API и worker используют BullMQ
queue `apollo-tf-downloads-v1` с prefix `{apollo-tf-downloads}`. Worker
принимает от API только подписанный internal `POST /v1/files`, а heartbeat
отправляет в `POST /api/internal/modules/download-worker/heartbeat`.

Internal сеть `tf-download-queue` содержит только API, worker и queue Redis.
Internal `tf-download-control` содержит только API и worker. Только worker
подключён к `tf-download-egress`, причём egress имеет наивысший gateway
priority. Worker не получает `tf-data`, `tf-edge`, integration/search
data/control networks, Docker socket, host mounts, SSH/Caddy/Coolify,
provider-account, TF DB или Platform DB credentials. Worker и queue Redis не
публикуют host ports.

File secret `tf_download_queue_password` принадлежит только queue Redis.
Authenticated `tf_download_queue_redis_url` получают только API и worker.
`tf_download_internal_auth_secret` разделяют только API и worker для HMAC
command boundary. Отдельный `tf_download_heartbeat_secret` получает только
worker; API читает соответствующий `download-worker` key из
`tf_module_heartbeat_keys`. Значения различны и не задаются в environment.
На native rootful Linux source files необходимо заранее provision: queue
password с UID/GID `999:999`, а queue URL, command key и heartbeat key с
`10001:10001`; mode каждого файла `0400`. Long-form Compose metadata не меняет
host bind ownership. Docker Desktop сохраняет функциональные read-only mounts,
но не является доказательством native Linux owner/mode.

Переменные command key намеренно различаются по процессам: worker читает
`TF_DOWNLOAD_INTERNAL_AUTH_SECRET_FILE`, API читает
`TF_DOWNLOAD_WORKER_INTERNAL_AUTH_SECRET_FILE`. Heartbeat secret монтируется
только worker через `TF_DOWNLOAD_HEARTBEAT_SECRET_FILE`; API получает его
только как entry общей heartbeat map.

На одной ноде API использует private origin
`http://tf-download-worker:8080`, worker использует `http://api:8080`, а
queue clients используют authenticated `redis://default:<queue-secret>@tf-download-redis:6379/0`.
Plain HTTP/Redis допустимы только с явными same-node insecure flags.
Cross-node размещение требует отдельно одобренных HTTPS/TLS ingress и
защищённого Redis transport с обычной проверкой сертификата и hostname;
insecure flags там запрещены.

Worker хранит owned files только в named volume `tf-download-worker-data` по
`/var/lib/apollo-tf/downloads`; Redis AOF хранится в
`tf-download-redis-data`. Первый release ограничен одной worker replica,
поскольку локальный volume не обеспечивает cross-replica routing. Runtime
обрабатывает до двух jobs одновременно, ограничивает очередь 200 jobs, файл
1 GiB, storage quota по умолчанию 20 GiB, TTL файла 24 часа и job deadline
30 минут. При quota pressure удаляются старые unpinned completed files;
oversize, deadline и невозможность освободить quota завершаются bounded failure
codes. Waiting и active cancellation worker-mediated, удаляют partial output,
а sweep удаляет stale partial, expired и over-quota owned files.

Fixtures активируются только при exact `NODE_ENV=test` вместе с
`TF_DOWNLOAD_SMOKE_FIXTURES=true`; production final image отклоняет любое
присутствие fixture flag общей ошибкой и не содержит fixture scripts/preload.
HomeNode, Coolify, Caddy, UFW, DNS и remote rollout не изменялись. Rollout
остаётся закрыт до отдельного read-only preflight и явного подтверждения
владельца.

### Будущие контейнерные TF-модули

Модули не разделяют database credentials и не получают Docker/Coolify/Caddy/SSH доступ. На одной Coolify node связь строится через private service DNS. Между разными нодами требуется отдельно одобренный TLS upstream; Docker Compose network не является межузловой сетью.

Для локального bridge новый домен не нужен. Перед remote rollout нужно запросить точные upstreams для уже согласованных `apollot.ru`, `api.apollot.ru`, `tf.apollot.ru`, `api.tf.apollot.ru` и `admin.apollot.ru`. Caddy access logs обязаны удалять query string у `/api/ws`, потому что он содержит одноразовый ticket. Web client уже получает новый ticket перед каждой WebSocket connection attempt; единственный текущий server/web implementation stage -- `tf-download-worker`. HomeNode, Coolify, Caddy, UFW и DNS остаются gated до read-only preflight и отдельного подтверждения владельца.

### `artifacts/admin-dashboard/Dockerfile`

Собирает standalone admin dashboard с pinned `pnpm@10.33.2`, затем nginx отдаёт production bundle. При старте `ADMIN_ACCESS_USER`/`ADMIN_ACCESS_PASSWORD` преобразуются в закрытый `.htpasswd`; без обеих переменных UI остаётся deny-by-default. nginx защищает UI через Basic Auth, rate-limits admin probes, проксирует только exact `GET /api/admin/dashboard` и добавляет server token только к этому запросу. Независимый `GET /healthz` не требует operator auth. Локальная проверка image/health/Compose не является deployment в Coolify/HomeNode.

### Корневой `docker-compose.yml`

```yaml
services:
  db:
  tf-role-bootstrap: # только profile baseline
  tf-migrate:
  tf-baseline: # только profile baseline
  redis:
  api:
  tf-integrations-postgres:
  tf-integrations-migrate:
  tf-integrations:
  tf-search:
  tf-download-redis:
  tf-download-worker:
  web:
  admin:
```

Root template использует выделенный PostgreSQL 16 cluster `db` с database
`apollo_trackfinder` и exact roles `apollo_tf_migrator` /
`apollo_tf_runtime`. На свежем `pgdata` image init создаёт и нормализует роли,
после healthcheck обязательный one-shot `tf-migrate` применяет immutable
migrations, и только его успешное завершение разрешает запуск API. API получает
только runtime URL и не выполняет startup DDL. `tf-role-bootstrap` и
`tf-baseline` находятся в отключённом по умолчанию profile `baseline` и
предназначены только для ручного adoption старого volume.

TF database/client secrets приходят из `TF_SECRET_DIRECTORY`, API/web/admin
ports по умолчанию привязаны к `127.0.0.1`, data plane отделён от edge network.
`VITE_API_URL` передаётся как Docker build argument и компилируется в web
bundle; runtime environment nginx не может изменить уже собранный URL. Compose
передаёт одинаковый server-side `ADMIN_DASHBOARD_TOKEN` API и admin nginx;
браузер его не получает. `APOLLO_MODULE_HEARTBEAT_KEYS_FILE` указывает API на
`/run/secrets/tf_module_heartbeat_keys`; raw map не задаётся в Compose.
`tf-search` подключён только к `tf-search-control` и `tf-search-egress`,
`tf-integrations` -- только к своим control/data/egress сетям, а download
Redis/worker -- к isolated queue/control/egress contract выше. API ожидает
readiness search, integrations, download queue и worker без обратной
startup-зависимости worker -> API. Пустой service token отключает backend
endpoint; пустые operator credentials закрывают UI. Deployment в
Coolify/HomeNode пока не выполнялся.

### `artifacts/api-server/docker-compose.yml`

```yaml
services:
  db:
  tf-role-bootstrap: # только profile baseline
  tf-migrate:
  tf-baseline: # только profile baseline
  redis:
  api:
  tf-integrations-postgres:
  tf-integrations-migrate:
  tf-integrations:
  tf-search:
  tf-download-redis:
  tf-download-worker:
```

Вложенный template сохраняет services
`db`/`tf-migrate`/`redis`/`api`/`tf-search`, database `apollo_trackfinder`,
exact TF roles и тот же migration barrier, что root template. Он добавляет те
же integration и download services с отдельными owned data volumes, использует
file secrets, loopback API binding и отдельные `tf-data`/`tf-edge`. Admin
service входит только в корневой `docker-compose.yml`.
`ADMIN_DASHBOARD_TOKEN` передаётся только API service, а heartbeat map
подключается к API через `APOLLO_MODULE_HEARTBEAT_KEYS_FILE`. Вложенные
`tf-search`, `tf-integrations` и download stack сохраняют те же secret и
network boundaries, что корневой template; отличается только Docker build
context.

`artifacts/platform-api/docker-compose.bridge.yml` повторяет тот же контракт
под именами `tf-postgres -> tf-migrate -> tf-api`; Platform services не
получают ни один TF database secret. Все три templates используют одинаковые
шесть TF secret-файлов, runtime/migrator separation и отключённый ручной
baseline profile. Это позволяет разворачивать контейнерные модули на одной
Coolify node через private service DNS. Межузловое размещение требует отдельно
одобренного TLS upstream; Docker network не является межузловой связью.

**Переменные окружения:**

| Переменная                                     | Обязательно               | Описание                                                                                                                                            |
| ---------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SERVER_URL`                                   | Для self-hosted Spotify   | Публичный URL сервера (`https://api.yourdomain.com`). Callback для Spotify Dashboard: `${SERVER_URL}/api/spotify/callback`                          |
| `DATABASE_URL_FILE`                            | Да                        | API-only путь к file-backed `tf_runtime_database_url`; entrypoint читает его до импорта bundle                                                      |
| `TF_MIGRATOR_DATABASE_URL_FILE`                | Для `tf-migrate`          | Путь к file-backed `tf_migrator_database_url`; runtime services его не получают                                                                     |
| `TF_ROLE_BOOTSTRAP_DATABASE_URL_FILE`          | Только profile `baseline` | Shared superuser URL для ручного role bootstrap                                                                                                     |
| `TF_BASELINE_DATABASE_URL_FILE`                | Только profile `baseline` | Тот же shared superuser URL для exact legacy-catalog adoption                                                                                       |
| `PORT`                                         | Авто                      | 8080                                                                                                                                                |
| `APOLLO_API_UPSTREAM`                          | Для admin runtime         | nginx upstream origin только для exact same-origin `GET /api/admin/dashboard` proxy                                                                 |
| `ADMIN_DASHBOARD_TOKEN`                        | До production deployment  | Server-side token, который nginx пересылает как `X-Admin-Dashboard-Token`; не попадает в browser bundle                                             |
| `ADMIN_ACCESS_USER`                            | Для доступа к admin UI    | Operator username для nginx Basic Auth; допустимы буквы, цифры и `_.@-`                                                                             |
| `ADMIN_ACCESS_PASSWORD`                        | Для доступа к admin UI    | Operator password; хэшируется при старте контейнера и удаляется из окружения nginx process                                                          |
| `APOLLO_MODULE_HEARTBEAT_KEYS_FILE`            | В Compose                 | API-only путь к JSON map с keys `search-media`, `account-integrations` и `download-worker`; entrypoint отклоняет unreadable, empty и oversized файл |
| `TF_SEARCH_INTERNAL_AUTH_SECRET_FILE`          | В Compose                 | Общий только для API и `tf-search` HMAC command key                                                                                                 |
| `TF_SEARCH_ORIGIN`                             | В Compose                 | Same-node `http://tf-search:8080`; HTTP разрешён только вместе с `TF_SEARCH_ALLOW_INSECURE_HTTP=true`                                               |
| `TF_SEARCH_HEARTBEAT_SECRET_FILE`              | Для `tf-search`           | Отдельный heartbeat key, который не монтируется в API                                                                                               |
| `TF_INTEGRATIONS_INTERNAL_AUTH_SECRET_FILE`    | В Compose                 | Distinct command key, смонтированный только в API и `tf-integrations`                                                                               |
| `TF_INTEGRATIONS_ORIGIN`                       | В API Compose             | Same-node exact `http://tf-integrations:8080`; HTTP разрешён только с `TF_INTEGRATIONS_ALLOW_INSECURE_HTTP=true`                                    |
| `TF_INTEGRATIONS_DATABASE_URL_FILE`            | В module/migrator         | Разные file-backed URL dedicated runtime и migrator roles                                                                                           |
| `TF_INTEGRATIONS_TOKEN_KEYRING_FILE`           | В module                  | AES-256-GCM keyring; не монтируется в API                                                                                                           |
| `TF_INTEGRATIONS_SPOTIFY_CLIENT_ID_FILE`       | В module                  | File-backed Spotify client ID; не монтируется в API                                                                                                 |
| `TF_INTEGRATIONS_SPOTIFY_CLIENT_SECRET_FILE`   | В module                  | File-backed Spotify client secret; не монтируется в API                                                                                             |
| `TF_INTEGRATIONS_SPOTIFY_CALLBACK_URI`         | В module                  | Exact public HTTPS `/api/spotify/callback` URI                                                                                                      |
| `TF_INTEGRATIONS_HEARTBEAT_SECRET_FILE`        | В module                  | Отдельный `account-integrations` heartbeat key                                                                                                      |
| `TF_INTEGRATIONS_HEARTBEAT_API_ORIGIN`         | В module                  | Same-node exact `http://api:8080`; HTTP разрешён только с `TF_INTEGRATIONS_HEARTBEAT_ALLOW_INSECURE_HTTP=true`                                      |
| `TF_DOWNLOAD_QUEUE_REDIS_URL_FILE`             | В API/worker              | Authenticated full queue URL; secret монтируется только в API и worker                                                                              |
| `TF_DOWNLOAD_WORKER_ORIGIN`                    | В API Compose             | Same-node exact `http://tf-download-worker:8080`; HTTP разрешён только с `TF_DOWNLOAD_WORKER_ALLOW_INSECURE_HTTP=true`                              |
| `TF_DOWNLOAD_WORKER_INTERNAL_AUTH_SECRET_FILE` | В API                     | API-side путь к distinct HMAC command key для exact worker `POST /v1/files`                                                                         |
| `TF_DOWNLOAD_INTERNAL_AUTH_SECRET_FILE`        | В worker                  | Worker-side путь к тому же file-backed HMAC command key                                                                                             |
| `TF_DOWNLOAD_HEARTBEAT_SECRET_FILE`            | В worker                  | Отдельный `download-worker` heartbeat key; не монтируется в API                                                                                     |
| `TF_DOWNLOAD_HEARTBEAT_API_ORIGIN`             | В worker                  | Same-node exact `http://api:8080`; HTTP разрешён только с `TF_DOWNLOAD_HEARTBEAT_ALLOW_INSECURE_HTTP=true`                                          |
| `TF_DOWNLOAD_STORAGE_ROOT`                     | В worker                  | Exact owned named-volume mount `/var/lib/apollo-tf/downloads`                                                                                       |
| `APOLLO_API_VERSION`                           | Нет                       | Версия in-process API-модулей в admin snapshot; default `unknown`                                                                                   |
| `APOLLO_DEPLOYED_AT`                           | Нет                       | ISO timestamp фактического deployment; при отсутствии UI показывает `Нет данных`                                                                    |

### Запуск на своём сервере

```bash
git clone https://github.com/ALTIS13/Apollo.TF.git
cd Apollo.TF
cp artifacts/api-server/.env.example .env
# Заполни public origins/version variables; provider credentials загрузи
# в shell из approved secret manager, а не из tracked .env.
: "${TF_INTEGRATIONS_SPOTIFY_CLIENT_ID:?}"
: "${TF_INTEGRATIONS_SPOTIFY_CLIENT_SECRET:?}"

export TF_SECRET_DIRECTORY=/var/lib/apollo-tf/secrets
sudo install -d -m 0700 -o root -g root "$TF_SECRET_DIRECTORY"
# Только для нового dedicated TF pgdata:
TF_POSTGRES_ADMIN_PASSWORD="$(openssl rand -hex 32)"
TF_MIGRATOR_PASSWORD="$(openssl rand -hex 32)"
TF_RUNTIME_PASSWORD="$(openssl rand -hex 32)"
TF_CLIENT_SECRET="$(openssl rand -hex 32)"
TF_SEARCH_COMMAND_SECRET="$(openssl rand -hex 32)"
TF_SEARCH_HEARTBEAT_SECRET="$(openssl rand -hex 32)"
TFI_ADMIN_PASSWORD="$(openssl rand -hex 32)"
TFI_MIGRATOR_PASSWORD="$(openssl rand -hex 32)"
TFI_RUNTIME_PASSWORD="$(openssl rand -hex 32)"
TFI_COMMAND_SECRET="$(openssl rand -hex 32)"
TFI_HEARTBEAT_SECRET="$(openssl rand -hex 32)"
TFI_TOKEN_KEY="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
TFD_QUEUE_PASSWORD="$(openssl rand -hex 32)"
TFD_COMMAND_SECRET="$(openssl rand -hex 32)"
TFD_HEARTBEAT_SECRET="$(openssl rand -hex 32)"
printf '%s' "$TF_POSTGRES_ADMIN_PASSWORD" | sudo tee "$TF_SECRET_DIRECTORY/tf_postgres_admin_password" >/dev/null
printf '%s' "$TF_MIGRATOR_PASSWORD" | sudo tee "$TF_SECRET_DIRECTORY/tf_migrator_password" >/dev/null
printf '%s' "$TF_RUNTIME_PASSWORD" | sudo tee "$TF_SECRET_DIRECTORY/tf_runtime_password" >/dev/null
printf 'postgres://postgres:%s@db:5432/apollo_trackfinder' "$TF_POSTGRES_ADMIN_PASSWORD" | sudo tee "$TF_SECRET_DIRECTORY/tf_admin_database_url" >/dev/null
printf 'postgres://apollo_tf_migrator:%s@db:5432/apollo_trackfinder' "$TF_MIGRATOR_PASSWORD" | sudo tee "$TF_SECRET_DIRECTORY/tf_migrator_database_url" >/dev/null
printf 'postgres://apollo_tf_runtime:%s@db:5432/apollo_trackfinder' "$TF_RUNTIME_PASSWORD" | sudo tee "$TF_SECRET_DIRECTORY/tf_runtime_database_url" >/dev/null
printf '%s' "$TF_CLIENT_SECRET" | sudo tee "$TF_SECRET_DIRECTORY/tf_client_secret" >/dev/null
printf '%s' "$TF_SEARCH_COMMAND_SECRET" | sudo tee "$TF_SECRET_DIRECTORY/tf_search_internal_auth_secret" >/dev/null
printf '%s' "$TF_SEARCH_HEARTBEAT_SECRET" | sudo tee "$TF_SECRET_DIRECTORY/tf_search_heartbeat_secret" >/dev/null
printf '%s' "$TFI_ADMIN_PASSWORD" | sudo tee "$TF_SECRET_DIRECTORY/tf_integrations_postgres_admin_password" >/dev/null
printf '%s' "$TFI_MIGRATOR_PASSWORD" | sudo tee "$TF_SECRET_DIRECTORY/tf_integrations_migrator_password" >/dev/null
printf '%s' "$TFI_RUNTIME_PASSWORD" | sudo tee "$TF_SECRET_DIRECTORY/tf_integrations_runtime_password" >/dev/null
printf 'postgres://apollo_tf_integrations_migrator:%s@tf-integrations-postgres:5432/apollo_tf_integrations' "$TFI_MIGRATOR_PASSWORD" | sudo tee "$TF_SECRET_DIRECTORY/tf_integrations_migrator_database_url" >/dev/null
printf 'postgres://apollo_tf_integrations_runtime:%s@tf-integrations-postgres:5432/apollo_tf_integrations' "$TFI_RUNTIME_PASSWORD" | sudo tee "$TF_SECRET_DIRECTORY/tf_integrations_runtime_database_url" >/dev/null
printf '{"activeKeyId":"initial","keys":{"initial":"%s"}}' "$TFI_TOKEN_KEY" | sudo tee "$TF_SECRET_DIRECTORY/tf_integrations_token_keyring" >/dev/null
printf '%s' "$TF_INTEGRATIONS_SPOTIFY_CLIENT_ID" | sudo tee "$TF_SECRET_DIRECTORY/tf_integrations_spotify_client_id" >/dev/null
printf '%s' "$TF_INTEGRATIONS_SPOTIFY_CLIENT_SECRET" | sudo tee "$TF_SECRET_DIRECTORY/tf_integrations_spotify_client_secret" >/dev/null
printf '%s' "$TFI_COMMAND_SECRET" | sudo tee "$TF_SECRET_DIRECTORY/tf_integrations_internal_auth_secret" >/dev/null
printf '%s' "$TFI_HEARTBEAT_SECRET" | sudo tee "$TF_SECRET_DIRECTORY/tf_integrations_heartbeat_secret" >/dev/null
printf '%s' "$TFD_QUEUE_PASSWORD" | sudo tee "$TF_SECRET_DIRECTORY/tf_download_queue_password" >/dev/null
printf 'redis://default:%s@tf-download-redis:6379/0' "$TFD_QUEUE_PASSWORD" | sudo tee "$TF_SECRET_DIRECTORY/tf_download_queue_redis_url" >/dev/null
printf '%s' "$TFD_COMMAND_SECRET" | sudo tee "$TF_SECRET_DIRECTORY/tf_download_internal_auth_secret" >/dev/null
printf '%s' "$TFD_HEARTBEAT_SECRET" | sudo tee "$TF_SECRET_DIRECTORY/tf_download_heartbeat_secret" >/dev/null
printf '{"search-media":"%s","account-integrations":"%s","download-worker":"%s"}' "$TF_SEARCH_HEARTBEAT_SECRET" "$TFI_HEARTBEAT_SECRET" "$TFD_HEARTBEAT_SECRET" | sudo tee "$TF_SECRET_DIRECTORY/tf_module_heartbeat_keys" >/dev/null
unset TF_POSTGRES_ADMIN_PASSWORD TF_MIGRATOR_PASSWORD TF_RUNTIME_PASSWORD
unset TF_CLIENT_SECRET
unset TF_SEARCH_COMMAND_SECRET TF_SEARCH_HEARTBEAT_SECRET
unset TFI_ADMIN_PASSWORD TFI_MIGRATOR_PASSWORD TFI_RUNTIME_PASSWORD
unset TFI_COMMAND_SECRET TFI_HEARTBEAT_SECRET TFI_TOKEN_KEY
unset TFD_QUEUE_PASSWORD TFD_COMMAND_SECRET TFD_HEARTBEAT_SECRET
unset TF_INTEGRATIONS_SPOTIFY_CLIENT_ID TF_INTEGRATIONS_SPOTIFY_CLIENT_SECRET
sudo sh -eu -c '
  directory=$1
  chown 10001:10001 "$directory"/tf_*
  chmod 0400 "$directory"/tf_*
  chown 999:999 \
    "$directory"/tf_postgres_admin_password \
    "$directory"/tf_migrator_password \
    "$directory"/tf_runtime_password \
    "$directory"/tf_download_queue_password \
    "$directory"/tf_integrations_*_password
  chown 0:10002 "$directory"/tf_admin_database_url
  chmod 0440 "$directory"/tf_admin_database_url
' secret-permissions "$TF_SECRET_DIRECTORY"

docker compose up -d --build
```

`TF_SECRET_DIRECTORY` переопределяет каталог secret sources в обоих Compose
templates.
Без override оба Compose templates используют безопасный non-secret default
`/var/lib/apollo-tf/secrets`; production startup требует шесть database
secret-файлов, базовые TF/search files и десять `tf_integrations_*` files.
Download stack дополнительно требует четыре `tf_download_*` files.
Integration-набор включает
три PostgreSQL passwords, отдельные migrator/runtime URL, token keyring, два
Spotify credential files, command key и heartbeat key.
Download-набор включает отдельные queue password, authenticated queue URL,
command key и heartbeat key; heartbeat map содержит соответствующий
`download-worker` entry.
Для native rootful Docker каталог остаётся `root:root` mode `0700`; privileged
shell выполняет `chown` и `chmod` после записи. Физические source-файлы имеют
следующий обязательный metadata contract:

| Файлы                                                                       | Владелец      | Mode   | Consumers                                                                            |
| --------------------------------------------------------------------------- | ------------- | ------ | ------------------------------------------------------------------------------------ |
| `tf_postgres_admin_password`, `tf_migrator_password`, `tf_runtime_password` | `999:999`     | `0400` | PostgreSQL init/role bootstrap по exact scope                                        |
| `tf_migrator_database_url`, `tf_runtime_database_url`                       | `10001:10001` | `0400` | Только migrator или runtime соответственно                                           |
| `tf_admin_database_url`                                                     | `root:10002`  | `0440` | Только profiled `tf-role-bootstrap` и `tf-baseline` через supplemental group `10002` |

Остальные `tf_*` application secrets принадлежат их documented runtime UID;
обычно это `10001:10001` mode `0400`. Supplemental group `10002` нельзя
выдавать API, migrator или другим services. Для rootless Docker numeric host
owners преобразуются в UID/GID mapping конкретного daemon с сохранением
эквивалентной least-privilege читаемости. Long-form Compose `uid`/`gid`/`mode`
не заменяет physical source provisioning для file-backed secrets. Docker
Desktop доказывает функциональные read-only mounts, но не native Linux
ownership.

PostgreSQL применяет init scripts и `POSTGRES_PASSWORD_FILE` только при
инициализации пустого volume. На свежем volume штатный `docker compose up -d
--build` выполняет role init, затем обязательный `tf-migrate`; API может быть
live на `/healthz`, но `/readyz` остаётся unavailable, пока exact full migration
history не совпадает с manifest.

Старый volume не удаляется, не baseline-ится и не принимается автоматически.
Apollo TF PostgreSQL должен быть выделенным cluster: `tf-role-bootstrap`
нормализует роли и ACL всего cluster и запрещён на shared PostgreSQL instance.
В текущем проекте нет известного remote TF data volume, которое можно считать
готовым к adoption. Для production сначала требуются проверяемый backup,
успешное restore-доказательство и явное подтверждение владельца.

После остановки writers и проверки backup ручной legacy upgrade выполняется
строго так:

```bash
docker compose up -d db
docker compose --profile baseline run --rm tf-role-bootstrap
docker compose --profile baseline run --rm --no-deps tf-baseline
docker compose run --rm --no-deps tf-migrate
docker compose up -d
```

Перед этим `tf_admin_database_url` должен содержать current PostgreSQL
superuser URL для данного dedicated TF database. `tf-role-bootstrap` создаёт
exact roles, `tf-baseline` принимает только canonical legacy startup catalog и
передаёт ownership migrator role, а normal `tf-migrate` завершает/проверяет
history. Любая catalog/history/ownership mismatch останавливает процедуру.
Password rotation retained volume является отдельной согласованной операцией:
остановить writers, обновить роли через доверенный administrative channel,
атомарно заменить соответствующие password и URL files, затем снова проверить
readiness.

`tf_client_secret` регистрируется только как confidential Platform OAuth client
secret и не передаётся browser-коду.

Integration role-init также выполняется только для нового
`tf-integrations-postgres-data`. При сохранённом volume ротация admin,
migrator или runtime password требует согласованных `ALTER ROLE` и file/URL
updates; простая замена secret files не меняет PostgreSQL roles.

Root, nested API и Platform bridge Compose проходят один migration ordering и
secret-scope contract. Контейнеры остаются переносимыми между Coolify nodes:
на одной node используется private service DNS, между nodes нужен отдельно
одобренный TLS upstream. Этот этап не изменял HomeNode, Coolify, Caddy, UFW,
DNS или доменные записи.

---

## 8. Среда разработки

| Workflow                                | Команда                                        | Порт    |
| --------------------------------------- | ---------------------------------------------- | ------- |
| API Server                              | `pnpm --filter @workspace/api-server run dev`  | 8080    |
| Admin Dashboard                         | `pnpm --filter @workspace/admin-dashboard dev` | 5173    |
| TrackFinder Mobile (legacy source only) | `expo start --localhost`                       | dynamic |
| Music Player (web)                      | `vite --host 0.0.0.0`                          | 25424   |
| Mockup Sandbox                          | `vite dev`                                     | 8081    |

**Мобильная поставка:**
Expo Go и custom static deployment больше не являются целевым способом поставки. Следующий мобильный этап должен выдавать APK, устанавливаемый и проверяемый через ADB на физических Android-устройствах. Текущий код всё ещё использует Expo SDK; решение между native prebuild/Gradle и миграцией на bare React Native фиксируется до реализации APK pipeline.

**API URL в мобильном:**  
Задаётся через `EXPO_PUBLIC_DOMAIN` при сборке или вручную в настройках (`ServerSettings`).
