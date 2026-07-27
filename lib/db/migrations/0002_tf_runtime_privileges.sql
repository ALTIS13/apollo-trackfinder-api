grant usage on schema apollo_tf to apollo_tf_runtime;

grant select on apollo_tf.schema_migrations to apollo_tf_runtime;

grant select, insert, update, delete on
  public.track_search_cache,
  public.play_history,
  public.liked_tracks,
  public.playlists,
  public.playlist_tracks
to apollo_tf_runtime;

grant usage on sequence
  public.track_search_cache_id_seq,
  public.play_history_id_seq,
  public.liked_tracks_id_seq,
  public.playlists_id_seq,
  public.playlist_tracks_id_seq
to apollo_tf_runtime;
