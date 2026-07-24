import "express-session";
import type { TfPrincipal } from "../lib/tf-policy.js";

declare module "express-session" {
  interface SessionData {
    spotify_state?: string;
  }
}

declare global {
  namespace Express {
    interface Request {
      tfPrincipal?: TfPrincipal;
    }
  }
}
