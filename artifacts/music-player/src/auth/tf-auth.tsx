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
  clearTfSessionSecurityState,
  commitTfSessionSecurityState,
  fetchTfSession,
  type TfApiError,
  type TfBrowserSession,
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

interface ActiveRefresh {
  mode: "standard" | "policy";
  promise: Promise<void>;
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
  const activeRefreshRef = useRef<ActiveRefresh | null>(null);

  const beginRefresh = useCallback((mode: ActiveRefresh["mode"]): Promise<void> => {
    const activeRefresh = activeRefreshRef.current;
    if (
      activeRefresh !== null
      && (mode === "standard" || activeRefresh.mode === "policy")
    ) {
      return activeRefresh.promise;
    }

    const generation = ++stateGenerationRef.current;
    clearTfSessionSecurityState();
    const cancellation = queryClient.cancelQueries();
    queryClient.clear();
    if (mountedRef.current) {
      setState({ status: "loading", session: null, error: null });
    }

    const refreshPromise = (async () => {
      await cancellation.catch(() => {});
      if (!mountedRef.current || generation !== stateGenerationRef.current) {
        return;
      }

      try {
        const session = await fetchTfSession();
        if (mountedRef.current && generation === stateGenerationRef.current) {
          commitTfSessionSecurityState(session);
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

    const refreshRecord: ActiveRefresh = { mode, promise: refreshPromise };
    activeRefreshRef.current = refreshRecord;
    void refreshPromise.finally(() => {
      if (activeRefreshRef.current === refreshRecord) {
        activeRefreshRef.current = null;
      }
    });
    return refreshPromise;
  }, [queryClient]);

  const refresh = useCallback(
    (): Promise<void> => beginRefresh("standard"),
    [beginRefresh],
  );

  useEffect(() => {
    mountedRef.current = true;
    const unsubscribe = subscribeTfAuthSecurityEvents((event) => {
      if (!mountedRef.current) return;

      if (event.type === "invalidated") {
        stateGenerationRef.current += 1;
        activeRefreshRef.current = null;
        clearTfSessionSecurityState();
        void queryClient.cancelQueries().catch(() => {});
        queryClient.clear();
        setState({
          status: "unauthenticated",
          session: null,
          error: event.error,
        });
        return;
      }

      void beginRefresh("policy");
    });
    void refresh();

    return () => {
      mountedRef.current = false;
      stateGenerationRef.current += 1;
      activeRefreshRef.current = null;
      unsubscribe();
      clearTfSessionSecurityState();
      void queryClient.cancelQueries().catch(() => {});
      queryClient.clear();
    };
  }, [beginRefresh, queryClient, refresh]);

  const login = useCallback(() => {
    startTfLogin();
  }, []);

  const logout = useCallback(async () => {
    const remoteLogout = logoutTfSession().catch(() => {});
    stateGenerationRef.current += 1;
    activeRefreshRef.current = null;
    clearTfSessionSecurityState();
    const cancellation = queryClient.cancelQueries();
    queryClient.clear();
    if (mountedRef.current) {
      setState({ status: "unauthenticated", session: null, error: null });
    }

    await Promise.all([
      remoteLogout,
      cancellation.catch(() => {}),
    ]);
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
