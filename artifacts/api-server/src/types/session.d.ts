import "express-session";

declare module "express-session" {
  // Legacy provider state only; Apollo TF authentication uses TfSessionStore.
  interface SessionData {
    session_id: string;
    spotify_state: string;
  }
}
