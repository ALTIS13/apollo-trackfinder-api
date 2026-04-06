# Overview

This project is a pnpm workspace monorepo utilizing TypeScript, designed to provide a comprehensive music player experience across multiple platforms. It includes a robust API, a web-based music player, and a mobile application. The core purpose is to enable users to search for, stream, and manage music from various sources like YouTube, SoundCloud, Bandcamp, and Deezer, alongside integrating with Spotify and Yandex Music favorites.

The business vision is to offer a unified and feature-rich music discovery and playback platform, addressing the fragmentation of music content across different services. The market potential lies in providing a seamless user experience for music enthusiasts who use multiple platforms. The project aims to deliver high-quality audio streaming, efficient search capabilities, and convenient access to personalized music libraries.

# User Preferences

I prefer iterative development, with a focus on delivering working features incrementally. I value clear and concise communication, preferring direct answers and practical solutions. Please ask before making major architectural changes or introducing new dependencies. I prefer detailed explanations for complex technical decisions. Do not make changes to files in the `lib/api-spec` directory directly.

# System Architecture

The project is structured as a pnpm workspace monorepo using Node.js 24 and TypeScript 5.9.

**UI/UX Decisions:**
The `music-player` frontend is a React + Vite SPA with a dark, professional design. It features a persistent bottom player bar, track cards with various badges (original, remix, live, cover, source), and a hero search page. The `trackfinder-mobile` app, built with Expo React Native, mirrors much of this design for Android and web (Windows PWA).

**Technical Implementations:**
-   **API Framework:** Express 5 handles all backend API logic.
-   **Database:** PostgreSQL is used with Drizzle ORM for data persistence, including search caches and Spotify/Yandex tokens.
-   **Validation:** Zod (`zod/v4`) and `drizzle-zod` are used for robust API request and response validation.
-   **API Codegen:** Orval generates API client code and Zod schemas from an OpenAPI specification, ensuring consistency between frontend and backend.
-   **Build System:** `esbuild` is used for CJS bundle creation.
-   **Media Search & Processing:** `yt-dlp` (CLI tool) and `ffmpeg` are system dependencies for YouTube search, stream resolution, and download functionalities. SoundCloud API is accessed via HTTP.
-   **Music Player API:**
    -   Provides endpoints for searching, batch searching, streaming, and downloading tracks.
    -   Track IDs are encoded with source URLs.
    -   Search results are cached with a 1-hour TTL.
    -   Features classification (original, remix, live, cover) and ranking based on title similarity, type weight, view count, and duration.
    -   "Smart Auto Mode" enhances search by boosting certain sources based on query keywords.
-   **Frontend (music-player):**
    -   React + Vite SPA utilizing React Query for data fetching.
    -   Features client-side filtering, local storage persistence for source preferences, and programmatic download triggering.
    -   HTML5 Audio is used for playback.
-   **Mobile App (trackfinder-mobile):**
    -   Expo React Native app supporting Android and web PWA.
    -   Includes search, offline track library (using `expo-file-system` and `expo-media-library`), and favorites integration.
    -   Uses `expo-av` for audio playback.
    -   Implements an API node system with primary/fallback/custom options and auto-failover.
    -   Session ID is stored in `AsyncStorage`.
-   **Monorepo Structure:**
    -   `artifacts/`: Contains deployable applications (`api-server`, `music-player`, `trackfinder-mobile`).
    -   `lib/`: Houses shared libraries (`api-spec`, `api-client-react`, `api-zod`, `db`).
    -   `scripts/`: Holds utility scripts.
-   **TypeScript Configuration:** Employs composite projects and project references, ensuring consistent type-checking across packages using `tsc --build --emitDeclarationOnly`.

**System Design Choices:**
-   Modular design through pnpm workspaces for independent package management.
-   Clear separation of concerns between API, web, and mobile clients.
-   Database schema defined with Drizzle ORM for type-safe interactions.
-   OpenAPI specification as the single source of truth for API contracts.
-   Robust session management for integrations using `express-session` and token storage in PostgreSQL.
-   Dockerization for easy self-hosted deployment.

# External Dependencies

-   **Monorepo Tool:** pnpm workspaces
-   **Node.js:** 24
-   **TypeScript:** 5.9
-   **API Framework:** Express 5
-   **Database:** PostgreSQL
-   **ORM:** Drizzle ORM
-   **Validation:** Zod (`zod/v4`), `drizzle-zod`
-   **API Codegen:** Orval
-   **Build Tool:** esbuild
-   **Media Search & Download:** `yt-dlp` (system dependency), `ffmpeg` (system dependency)
-   **SoundCloud:** SoundCloud API (HTTP requests)
-   **Spotify:** Spotify Web API (OAuth 2.0 for authorization, `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`)
-   **Yandex Music:** Yandex Music API (token-based authentication)
-   **React Framework:** React
-   **Frontend Build Tool:** Vite
-   **Mobile Framework:** Expo React Native
-   **Session Management:** `express-session`
-   **CORS Middleware:** `cors`
-   **Database Driver:** `pg`
-   **React Query:** For data fetching and state management in React applications.
-   **Expo Modules:** `expo-av`, `expo-file-system`, `expo-media-library` (for mobile app functionalities).
-   **Utility Libraries:** `async-storage`, `cn` (class name utility), `formatDuration`.