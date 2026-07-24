import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  type TfApiError,
  type TfBrowserSession,
  loadTfSession,
  logoutTfSession,
  normalizeTfApiError,
  startTfLogin,
  subscribeTfAuthSecurityEvents,
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
  const mountedRef = useRef(false);
  const stateGenerationRef = useRef(0);
  const refreshPromiseRef = useRef<Promise<void> | null>(null);

  const refresh = useCallback((): Promise<void> => {
    if (refreshPromiseRef.current !== null) {
      return refreshPromiseRef.current;
    }

    const generation = ++stateGenerationRef.current;
    if (mountedRef.current) {
      setState({ status: "loading", session: null, error: null });
    }

    const refreshPromise = (async () => {
      try {
        const session = await loadTfSession();
        if (mountedRef.current && generation === stateGenerationRef.current) {
          setState({ status: "authenticated", session, error: null });
        }
      } catch (error) {
        const apiError = normalizeTfApiError(error);
        if (mountedRef.current && generation === stateGenerationRef.current) {
          setState({
            status: apiError.kind === "unauthenticated" ? "unauthenticated" : "unavailable",
            session: null,
            error: apiError,
          });
        }
      }
    })();

    refreshPromiseRef.current = refreshPromise;
    void refreshPromise.finally(() => {
      if (refreshPromiseRef.current === refreshPromise) {
        refreshPromiseRef.current = null;
      }
    });
    return refreshPromise;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const unsubscribe = subscribeTfAuthSecurityEvents((event) => {
      if (!mountedRef.current) return;

      if (event.type === "invalidated") {
        stateGenerationRef.current += 1;
        refreshPromiseRef.current = null;
        queryClient.clear();
        setState({
          status: "unauthenticated",
          session: null,
          error: event.error,
        });
        return;
      }

      void refresh();
    });
    void refresh();

    return () => {
      mountedRef.current = false;
      stateGenerationRef.current += 1;
      refreshPromiseRef.current = null;
      unsubscribe();
    };
  }, [queryClient, refresh]);

  const login = useCallback(() => {
    startTfLogin();
  }, []);

  const logout = useCallback(async () => {
    stateGenerationRef.current += 1;
    refreshPromiseRef.current = null;
    try {
      await logoutTfSession();
    } catch {
      // Local invalidation still completes when the server logout is unavailable.
    } finally {
      queryClient.clear();
      if (mountedRef.current) {
        setState({ status: "unauthenticated", session: null, error: null });
      }
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
