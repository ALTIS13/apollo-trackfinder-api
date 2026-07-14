# Apollo TrackFinder — Документация по модулям

> Кросс-платформенный музыкальный плеер: Expo-приложение (Android + PWA) + самохостящийся Docker-бэкенд.
> Язык интерфейса: русский. Монорепозиторий на pnpm.

---

## Структура проекта

```
apollo-trackfinder/
├── artifacts/
│   ├── api-server/          # Бэкенд (Express + Node.js)
│   ├── admin-dashboard/     # Admin topology dashboard (React + Vite + nginx)
│   ├── trackfinder-mobile/  # Мобильное приложение (Expo / React Native)
│   └── music-player/        # Веб-плеер (React + Vite)
├── lib/
│   ├── db/                  # Drizzle ORM + PostgreSQL схема
│   ├── api-spec/            # OpenAPI-спецификация
│   ├── api-zod/             # Zod-схемы (авто-генерация из OpenAPI)
│   └── api-client-react/    # React Query клиент (авто-генерация из OpenAPI)
└── docker-compose.yml       # Root stack: PostgreSQL + API + admin service
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

## 2. Мобильное приложение — `artifacts/trackfinder-mobile`

**Стек:** Expo SDK 53, React Native, Expo Router (file-based navigation), expo-av (аудио), TypeScript

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
- Визуальная основа -- вариант 2: центральная topology-схема с устойчивым left-to-right layout. Из варианта 1 добавлены четыре метрики: активные модули, поиски в минуту, глубина очереди и error rate; рядом остаётся rail инцидентов с фильтрацией, фокусом сервиса и локальным acknowledgement.
- Типизированный `DashboardSnapshot` описывает метрики, сервисы, связи, инциденты, deployments и provider health. `VITE_ADMIN_API_URL` включает HTTP-адаптер для `GET /api/admin/dashboard`; при пустой переменной используется demo snapshot, а ошибка обновления сохраняет last-known-good состояние как stale.
- `Dockerfile` собирает Vite bundle и отдаёт его через nginx. `nginx.conf` объявляет `/healthz` и SPA fallback; корневой `docker-compose.yml` поднимает PostgreSQL, API и `admin` service.
- Проверено в отчётах checkpoint: 41 dashboard test, dashboard typecheck/build, workspace typecheck, локальный Docker `/healthz` (`200`, `ok`) и Docker/Compose/Coolify readiness конфигурации. Deployment в Coolify или на HomeNode не выполнялся.
- Следующий этап: production backend telemetry/API для `/api/admin/dashboard`, затем визуальное подтверждение владельца перед merge в `main`; технический desktop/mobile QA focus, incidents, refresh и reduced motion уже пройден.

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

### `artifacts/api-server/Dockerfile`

1. Базовый образ: `node:20-alpine`
2. Устанавливает Python + pip → `yt-dlp` (последняя версия)
3. Копирует монорепозиторий, запускает `pnpm install --frozen-lockfile`
4. Собирает через `esbuild` (`pnpm run build`)
5. Запускает `node dist/index.mjs`

### `artifacts/admin-dashboard/Dockerfile`

Собирает standalone admin dashboard с pinned `pnpm@10.33.2`, затем nginx отдаёт production bundle. Runtime health endpoint -- `GET /healthz`; service `admin` определён в корневом `docker-compose.yml`. Локально проверены image, Compose configuration и Coolify readiness; deployment в Coolify/HomeNode не выполнялся.

### Корневой `docker-compose.yml`

```yaml
services:
  db:     # PostgreSQL 16-alpine
  api:    # API-сервер на порту 8080
  admin:  # Admin dashboard на порту 3001
```

Это полный root stack для PostgreSQL, API и admin service. Конфигурация локально проверена для Docker/Compose и готовности к Coolify; фактического deployment в Coolify/HomeNode не было.

### `artifacts/api-server/docker-compose.yml`

```yaml
services:
  db:     # PostgreSQL 16-alpine
  api:    # API-сервер на порту 8080
```

Этот вложенный compose относится только к API и PostgreSQL; admin service входит в корневой `docker-compose.yml`.

**Переменные окружения:**

| Переменная | Обязательно | Описание |
|------------|-------------|----------|
| `SPOTIFY_CLIENT_ID` | Для Spotify | ID приложения Spotify |
| `SPOTIFY_CLIENT_SECRET` | Для Spotify | Секрет приложения Spotify |
| `SERVER_URL` | Для self-hosted Spotify | Публичный URL сервера (`https://api.yourdomain.com`). Callback для Spotify Dashboard: `${SERVER_URL}/api/spotify/callback` |
| `DATABASE_URL` | Авто | Заполняется docker-compose автоматически |
| `PORT` | Авто | 8080 |

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
| TrackFinder Mobile | `expo start --localhost` | dynamic |
| Music Player (web) | `vite --host 0.0.0.0` | 25424 |
| Mockup Sandbox | `vite dev` | 8081 |

**Мобильная поставка:**
Expo Go и custom static deployment больше не являются целевым способом поставки. Следующий мобильный этап должен выдавать APK, устанавливаемый и проверяемый через ADB на физических Android-устройствах. Текущий код всё ещё использует Expo SDK; решение между native prebuild/Gradle и миграцией на bare React Native фиксируется до реализации APK pipeline.

**API URL в мобильном:**  
Задаётся через `EXPO_PUBLIC_DOMAIN` при сборке или вручную в настройках (`ServerSettings`).
