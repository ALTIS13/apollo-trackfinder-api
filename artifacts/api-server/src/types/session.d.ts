import "express-session";

declare module "express-session" {
  interface SessionData {
    session_id: string;
    spotify_state: string;
  }
}
