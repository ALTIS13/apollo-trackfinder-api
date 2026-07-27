create table public.track_search_cache (
  id serial primary key,
  cache_key text not null unique,
  results jsonb not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table public.play_history (
  id serial primary key,
  session_id text not null,
  track_id text not null,
  artist text,
  title text,
  played_at timestamptz not null default now()
);

create index play_history_session_idx
  on public.play_history (session_id);
create index play_history_played_at_idx
  on public.play_history (played_at);

create table public.liked_tracks (
  id serial primary key,
  session_id text not null,
  track_id text not null,
  artist text,
  title text,
  thumbnail_url text,
  duration text,
  liked_at timestamptz not null default now(),
  unique (session_id, track_id)
);

create index liked_tracks_session_idx
  on public.liked_tracks (session_id);

create table public.playlists (
  id serial primary key,
  session_id text not null,
  name text not null,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index playlists_session_idx
  on public.playlists (session_id);

create table public.playlist_tracks (
  id serial primary key,
  playlist_id integer not null,
  track_id text not null,
  artist text,
  title text,
  thumbnail_url text,
  duration text,
  position integer not null default 0,
  added_at timestamptz not null default now()
);

create index playlist_tracks_playlist_idx
  on public.playlist_tracks (playlist_id);
