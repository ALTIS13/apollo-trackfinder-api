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

| Файл | Описание |
|------|----------|
| `src/index.ts` | Запускает HTTP-сервер на порту из `PORT` env |
| `src/app.ts` | Создаёт Express-приложение, подключает все роутеры под `/api`, настраивает сессии и pino-http |

### 1.2 Роуты — `src/routes/`

#### `tracks.ts` — Поиск и стриминг треков

**Архитектура:** параллельный поиск по 4 источникам → ранжирование → кэш → стриминг через yt-dlp.

| Эндпоинт | Метод | Описание |
|----------|-------|----------|
| `/tracks/search` | POST | Поиск по `artist` + `title`. Параллельно опрашивает YouTube, SoundCloud, Bandcamp, Deezer. Результаты ранжируются и кэшируются на 1 час. Поддерживает `maxResults` (5–40). |
| `/tracks/:id/audio-stream` | GET | Стрим аудио. Декодирует base64url-ID трека → получает оригинальный URL источника → через yt-dlp качает и проксирует поток клиенту. Fallback: Deezer → YouTube → SoundCloud. |
| `/tracks/:id/download` | GET | Скачивание файла с нужным качеством (`128`, `192`, `256`, `320` kbps или FLAC). Аналогичный fallback. |
| `/tracks/lyrics` | GET | Поиск текста песни по `artist` + `title` (+ `duration`). Возвращает синхронизированный LRC и/или обычный текст. |

**Безопасность:** ID треков — `source_prefix` + base64url(URL). При декодировании URL проверяется против allowlist хостов (`youtube.com`, `soundcloud.com`, `bandcamp.com`, `dzcdn.net`). Только `https://`.

#### `spotify.ts` — Интеграция Spotify

| Эндпоинт | Метод | Описание |
|----------|-------|----------|
| `/spotify/status` | GET | Проверяет, авторизован ли текущий сессионный пользователь |
| `/spotify/login` | GET | Инициирует OAuth 2.0 Authorization Code Flow. Генерирует state с зашифрованным session ID и nonce. `redirect_uri` определяется из `SERVER_URL` env или `PUBLIC_API_DOMAIN`. |
| `/spotify/callback` | GET | Обменивает код на токены, сохраняет в БД, редиректит в приложение |
| `/spotify/logout` | POST | Удаляет токены сессии из БД |
| `/spotify/liked` | GET | Получает лайкнутые треки пользователя (пагинация) |
| `/spotify/playlists` | GET | Список плейлистов пользователя |
| `/spotify/playlist/:id/tracks` | GET | Треки конкретного плейлиста |
| `/spotify/top` | GET | Топ-треки пользователя |

**Особенности:** автоматическое обновление `access_token` через `refresh_token` за 60 сек до истечения. Мобильный режим определяется по суффиксу `__m` в state — редиректит на `trackfinder://favorites`.

#### `yandex.ts` — Интеграция Яндекс Музыки

| Эндпоинт | Метод | Описание |
|----------|-------|----------|
| `/yandex/token` | POST | Сохраняет OAuth-токен (пользователь вводит вручную из браузера) |
| `/yandex/status` | GET | Статус подключения |
| `/yandex/disconnect` | POST | Удаляет токен из БД |
| `/yandex/liked` | GET | Лайкнутые треки через `api.music.yandex.net` |
| `/yandex/playlists` | GET | Плейлисты пользователя |
| `/yandex/playlist/:uid/:kind/tracks` | GET | Треки плейлиста |

**Особенности:** использует мобильный User-Agent (`YandexMusicAndroid/24023621`), без PKCE — пользователь сам вставляет OAuth-токен.

#### `health.ts`

`GET /health` — возвращает статус сервера и версию.

#### `module-heartbeats.ts` — Heartbeat независимых модулей

`POST /api/internal/modules/:moduleId/heartbeat` принимает только JSON heartbeat от заранее настроенного модуля. Отправитель посылает его каждые 30 секунд. `moduleId` должен иметь отдельный ключ в API-only JSON map `APOLLO_MODULE_HEARTBEAT_KEYS`; пример формы значения: `{"search-media":"<per-module-secret>"}`. Пустая, невалидная или отсутствующая map безопасно отключает endpoint (`503 {"error":"heartbeat_disabled"}`), поэтому модульная телеметрия выключена по умолчанию.

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

| Файл | Источник | Метод поиска |
|------|----------|-------------|
| `youtube.ts` | YouTube | `yt-dlp --dump-json ytsearch:N "запрос"` |
| `soundcloud.ts` | SoundCloud | `yt-dlp --dump-json scsearch:N "запрос"` |
| `bandcamp.ts` | Bandcamp | Парсинг HTML страницы поиска Bandcamp |
| `deezer.ts` | Deezer | REST API `api.deezer.com/search` |

**Поле `id` трека:** `{source}_{base64url(originalUrl)}`  
Примеры: `yt_aHR0cHM6...`, `sc_aHR0cHM6...`, `bc_...`, `dz_...`

### 1.4 Библиотеки — `src/lib/`

#### `classifier.ts` — Классификация треков

Определяет тип трека по заголовку через регулярные выражения:

| Тип | Паттерны |
|-----|----------|
| `original` | (по умолчанию, если ничего не подошло) |
| `remix` | remix, rmx, bootleg, flip, edit, extended, club mix, radio edit, instrumental... |
| `live` | live, concert, tour, acoustic, unplugged, session, at ...@ |
| `cover` | cover, tribute, originally by, sung by |

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

| Состояние | Тип | Описание |
|-----------|-----|----------|
| `currentTrack` | `PlayerTrack \| null` | Текущий трек |
| `queue` | `PlayerTrack[]` | Полная очередь |
| `queueIndex` | `number` | Позиция в очереди |
| `shuffle` | `boolean` | Режим перемешивания |
| `repeat` | `'none' \| 'one' \| 'all'` | Режим повтора |
| `isPlaying` | `boolean` | Состояние воспроизведения |
| `isLoading` | `boolean` | Загрузка аудио |
| `position` | `number` | Позиция в секундах |
| `duration` | `number` | Длительность в секундах |

| Метод | Описание |
|-------|----------|
| `play(track)` | Играть одиночный трек (очередь = [track]) |
| `playQueue(tracks, startIndex)` | Играть список, начиная с индекса |
| `playNext()` | Следующий трек (с учётом shuffle) |
| `playPrev()` | Предыдущий трек или перемотка в начало (если >3 сек) |
| `pause() / resume()` | Пауза / продолжение |
| `stop()` | Остановить и очистить очередь |
| `seek(pos)` | Перемотка в секундах |
| `toggleShuffle()` | Переключить перемешивание |
| `cycleRepeat()` | Цикл: none → all → one → none |

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

| Метод | Описание |
|-------|----------|
| `saveToLibrary(track)` | Добавить трек в библиотеку (без скачивания файла) |
| `download(track)` | Скачать аудио через `/download` → сохранить в файловую систему устройства (MediaLibrary) |
| `bulkDownload(tracks)` | Массовое скачивание с прогрессом и возможностью отмены |
| `remove(id)` | Удалить трек и файл с диска |
| `bulkRemove(ids)` | Массовое удаление |
| `isSaved(id)` / `isDownloaded(id)` | Проверки статуса |

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

| Файл | Описание |
|------|----------|
| `src/pages/Home.tsx` | Поиск треков, воспроизведение через `<audio>` HTML5 |
| `src/pages/Favorites.tsx` | Сохранённые треки (localStorage) |

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

### `artifacts/api-server/Dockerfile`

1. Базовый образ: `node:20-alpine`
2. Устанавливает Python + pip → `yt-dlp` (последняя версия)
3. Копирует монорепозиторий, запускает `pnpm install --frozen-lockfile`
4. Собирает через `esbuild` (`pnpm run build`)
5. Запускает `node dist/index.mjs`

### `artifacts/admin-dashboard/Dockerfile`

Собирает standalone admin dashboard с pinned `pnpm@10.33.2`, затем nginx отдаёт production bundle. При старте `ADMIN_ACCESS_USER`/`ADMIN_ACCESS_PASSWORD` преобразуются в закрытый `.htpasswd`; без обеих переменных UI остаётся deny-by-default. nginx защищает UI через Basic Auth, rate-limits admin probes, проксирует только exact `GET /api/admin/dashboard` и добавляет server token только к этому запросу. Независимый `GET /healthz` не требует operator auth. Локальная проверка image/health/Compose не является deployment в Coolify/HomeNode.

### Корневой `docker-compose.yml`

```yaml
services:
  db:     # PostgreSQL 16-alpine
  api:    # API-сервер на порту 8080
  web:    # Web player на порту 3000
  admin:  # Admin dashboard на порту 3001
```

Root stack содержит PostgreSQL, API, web и admin services. Compose передаёт одинаковый server-side `ADMIN_DASHBOARD_TOKEN` API и admin nginx; браузер его не получает. `APOLLO_MODULE_HEARTBEAT_KEYS` передаётся только API container. Admin port привязан к `127.0.0.1`, а UI дополнительно требует `ADMIN_ACCESS_USER`/`ADMIN_ACCESS_PASSWORD`. Пустой service token отключает backend endpoint; пустые operator credentials закрывают UI. Deployment в Coolify/HomeNode пока не выполнялся.

### `artifacts/api-server/docker-compose.yml`

```yaml
services:
  db:     # PostgreSQL 16-alpine
  api:    # API-сервер на порту 8080
```

Этот вложенный compose относится к API, PostgreSQL и Redis; admin service входит в корневой `docker-compose.yml`. `ADMIN_DASHBOARD_TOKEN` и `APOLLO_MODULE_HEARTBEAT_KEYS` передаются только API service.

**Переменные окружения:**

| Переменная | Обязательно | Описание |
|------------|-------------|----------|
| `SPOTIFY_CLIENT_ID` | Для Spotify | ID приложения Spotify |
| `SPOTIFY_CLIENT_SECRET` | Для Spotify | Секрет приложения Spotify |
| `SERVER_URL` | Для self-hosted Spotify | Публичный URL сервера (`https://api.yourdomain.com`). Callback для Spotify Dashboard: `${SERVER_URL}/api/spotify/callback` |
| `DATABASE_URL` | Авто | Заполняется docker-compose автоматически |
| `PORT` | Авто | 8080 |
| `APOLLO_API_UPSTREAM` | Для admin runtime | nginx upstream origin только для exact same-origin `GET /api/admin/dashboard` proxy |
| `ADMIN_DASHBOARD_TOKEN` | До production deployment | Server-side token, который nginx пересылает как `X-Admin-Dashboard-Token`; не попадает в browser bundle |
| `ADMIN_ACCESS_USER` | Для доступа к admin UI | Operator username для nginx Basic Auth; допустимы буквы, цифры и `_.@-` |
| `ADMIN_ACCESS_PASSWORD` | Для доступа к admin UI | Operator password; хэшируется при старте контейнера и удаляется из окружения nginx process |
| `APOLLO_MODULE_HEARTBEAT_KEYS` | Нет | API-only JSON map `{ "moduleId": "per-module-secret" }`; пустое/невалидное значение отключает module heartbeat endpoint |
| `APOLLO_API_VERSION` | Нет | Версия in-process API-модулей в admin snapshot; default `unknown` |
| `APOLLO_DEPLOYED_AT` | Нет | ISO timestamp фактического deployment; при отсутствии UI показывает `Нет данных` |

### Запуск на своём сервере

```bash
git clone https://github.com/ALTIS13/apollo-trackfinder-api
cd apollo-trackfinder-api
cp artifacts/api-server/.env.example .env
# Заполни SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SERVER_URL
docker compose up -d --build
```

---

## 8. Среда разработки

| Workflow | Команда | Порт |
|----------|---------|------|
| API Server | `pnpm --filter @workspace/api-server run dev` | 8080 |
| Admin Dashboard | `pnpm --filter @workspace/admin-dashboard dev` | 5173 |
| TrackFinder Mobile (legacy source only) | `expo start --localhost` | dynamic |
| Music Player (web) | `vite --host 0.0.0.0` | 25424 |
| Mockup Sandbox | `vite dev` | 8081 |

**Мобильная поставка:**
Expo Go и custom static deployment больше не являются целевым способом поставки. Следующий мобильный этап должен выдавать APK, устанавливаемый и проверяемый через ADB на физических Android-устройствах. Текущий код всё ещё использует Expo SDK; решение между native prebuild/Gradle и миграцией на bare React Native фиксируется до реализации APK pipeline.

**API URL в мобильном:**  
Задаётся через `EXPO_PUBLIC_DOMAIN` при сборке или вручную в настройках (`ServerSettings`).
