import { useCallback, useEffect, useRef } from 'react';
import { getApiBase, getSessionId } from './use-session';

export interface PlayerSyncState {
  type: 'player_state';
  track: {
    id: string;
    title: string;
    artist: string;
    thumbnailUrl: string | null;
    duration: number;
    source?: string;
  } | null;
  position: number;
  isPlaying: boolean;
}

const RECONNECT_DELAY_MS = 3000;
const MAX_RECONNECT_DELAY_MS = 30000;

function buildWsUrl(): string {
  const apiBase = getApiBase();
  const wsBase = apiBase.replace(/^https?:\/\//, (match) =>
    match.startsWith('https') ? 'wss://' : 'ws://',
  );
  const sessionId = encodeURIComponent(getSessionId());
  return `${wsBase}/ws?sessionId=${sessionId}`;
}

interface UseSyncOptions {
  onRemoteState: (state: PlayerSyncState) => void;
  enabled?: boolean;
}

export function usePlayerSync({ onRemoteState, enabled = true }: UseSyncOptions) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelayRef = useRef(RECONNECT_DELAY_MS);
  const mountedRef = useRef(true);
  const onRemoteStateRef = useRef(onRemoteState);
  onRemoteStateRef.current = onRemoteState;

  const disconnect = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.onerror = null;
      wsRef.current.onmessage = null;
      wsRef.current.close();
      wsRef.current = null;
    }
  }, []);

  const connect = useCallback(() => {
    if (!mountedRef.current || !enabled) return;
    if (wsRef.current?.readyState === WebSocket.CONNECTING || wsRef.current?.readyState === WebSocket.OPEN) return;

    try {
      const url = buildWsUrl();
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectDelayRef.current = RECONNECT_DELAY_MS;
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data) as PlayerSyncState;
          if (msg.type === 'player_state') {
            onRemoteStateRef.current(msg);
          }
        } catch {}
      };

      ws.onclose = () => {
        wsRef.current = null;
        if (!mountedRef.current || !enabled) return;
        const delay = Math.min(reconnectDelayRef.current, MAX_RECONNECT_DELAY_MS);
        reconnectDelayRef.current = Math.min(delay * 2, MAX_RECONNECT_DELAY_MS);
        reconnectTimerRef.current = setTimeout(connect, delay);
      };

      ws.onerror = () => {
        ws.close();
      };
    } catch {
      const delay = Math.min(reconnectDelayRef.current, MAX_RECONNECT_DELAY_MS);
      reconnectDelayRef.current = Math.min(delay * 2, MAX_RECONNECT_DELAY_MS);
      reconnectTimerRef.current = setTimeout(connect, delay);
    }
  }, [enabled]);

  const sendState = useCallback((state: Omit<PlayerSyncState, 'type'>) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({ ...state, type: 'player_state' }));
    } catch {}
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    if (enabled) connect();
    return () => {
      mountedRef.current = false;
      disconnect();
    };
  }, [enabled, connect, disconnect]);

  return { sendState };
}
