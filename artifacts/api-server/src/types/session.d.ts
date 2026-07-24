import type { TfPrincipal } from "../lib/tf-policy.js";

declare global {
  namespace Express {
    interface Request {
      tfPrincipal?: TfPrincipal;
    }
  }
}
