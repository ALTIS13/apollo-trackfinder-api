import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  type TfApiError,
  type TfBrowserSession,
  loadTfSession,
  logoutTfSession,
  normalizeTfApiError,
  startTfLogin,
} from "@/lib/tf-session-client";

export type TfAuthStatus =
  | "loading"
  | "authenticated"
  | "unauthenticated"
  | "unavailable";

export interface TfAuthContextValue {
  status: TfAuthStatus;
  session: TfBrowserSession | null;
  error: TfApiError | null;
  refresh: () => Promise<void>;
  login: () => void;
  logout: () => Promise<void>;
  hasEntitlement: (capability: string) => boolean;
}

interface TfAuthState {
  status: TfAuthStatus;
  session: TfBrowserSession | null;
  error: TfApiError | null;
}

const TfAuthContext = createContext<TfAuthContextValue | null>(null);

export function TfAuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<TfAuthState>({
    status: "loading",
    session: null,
    error: null,
  });

  const refresh = useCallback(async () => {
    setState({ status: "loading", session: null, error: null });
    try {
      const session = await loadTfSession();
      setState({ status: "authenticated", session, error: null });
    } catch (error) {
      const apiError = normalizeTfApiError(error);
      setState({
        status: apiError.kind === "unauthenticated" ? "unauthenticated" : "unavailable",
        session: null,
        error: apiError,
      });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(() => {
    startTfLogin();
  }, []);

  const logout = useCallback(async () => {
    try {
      await logoutTfSession();
    } finally {
      queryClient.clear();
      setState({ status: "unauthenticated", session: null, error: null });
    }
  }, [queryClient]);

  const hasEntitlement = useCallback((capability: string) => (
    state.session?.entitlements.includes(capability) ?? false
  ), [state.session]);

  const value = useMemo<TfAuthContextValue>(() => ({
    ...state,
    refresh,
    login,
    logout,
    hasEntitlement,
  }), [state, refresh, login, logout, hasEntitlement]);

  return <TfAuthContext.Provider value={value}>{children}</TfAuthContext.Provider>;
}

export function useTfAuth(): TfAuthContextValue {
  const context = useContext(TfAuthContext);
  if (context === null) {
    throw new Error("useTfAuth must be used within a TfAuthProvider");
  }

  return context;
}
