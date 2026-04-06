import AsyncStorage from '@react-native-async-storage/async-storage';

const SESSION_KEY = 'trackfinder_session_id';
const API_URL_KEY = 'trackfinder_api_url';
const NODE_MODE_KEY = 'trackfinder_node_mode';

export type NodeMode = 'primary' | 'fallback' | 'custom';

const API_NODES = {
  primary: 'https://api.apollot.ru/api',
  fallback: (() => {
    const domain = process.env.EXPO_PUBLIC_DOMAIN;
    if (domain) return `https://${domain}/api`;
    return 'http://localhost:8080/api';
  })(),
};

let _sessionId: string | null = null;
let _apiBase: string | null = null;
let _nodeMode: NodeMode = 'fallback';
let _usingFallback = false;
let _primaryRetryTimer: ReturnType<typeof setInterval> | null = null;

function makeId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

export async function initSession(): Promise<void> {
  try {
    const [storedSession, storedUrl, storedMode] = await Promise.all([
      AsyncStorage.getItem(SESSION_KEY),
      AsyncStorage.getItem(API_URL_KEY),
      AsyncStorage.getItem(NODE_MODE_KEY),
    ]);
    if (storedSession) {
      _sessionId = storedSession;
    } else {
      _sessionId = makeId();
      await AsyncStorage.setItem(SESSION_KEY, _sessionId);
    }
    _nodeMode = (storedMode as NodeMode) || 'fallback';
    if (_nodeMode === 'custom' && storedUrl) {
      _apiBase = storedUrl;
    } else if (_nodeMode === 'primary') {
      _apiBase = API_NODES.primary;
    } else {
      _apiBase = API_NODES.fallback;
    }
  } catch {
    _sessionId = makeId();
    _apiBase = API_NODES.fallback;
  }
}

export function getSessionId(): string {
  if (!_sessionId) _sessionId = makeId();
  return _sessionId;
}

export function getApiBase(): string {
  if (_usingFallback) return API_NODES.fallback;
  if (!_apiBase) _apiBase = API_NODES.fallback;
  return _apiBase;
}

export function getConfiguredApiUrl(): string {
  return _apiBase ?? API_NODES.fallback;
}

export function getNodeMode(): NodeMode {
  return _nodeMode;
}

export function getNodes(): { primary: string; fallback: string } {
  return { ...API_NODES };
}

export function isUsingFallback(): boolean {
  return _usingFallback;
}

export async function setNodeMode(mode: NodeMode, customUrl?: string): Promise<void> {
  _nodeMode = mode;
  _usingFallback = false;
  await AsyncStorage.setItem(NODE_MODE_KEY, mode);
  if (mode === 'primary') {
    _apiBase = API_NODES.primary;
    await AsyncStorage.removeItem(API_URL_KEY);
  } else if (mode === 'fallback') {
    _apiBase = API_NODES.fallback;
    await AsyncStorage.removeItem(API_URL_KEY);
  } else if (mode === 'custom' && customUrl) {
    const normalized = customUrl.trim().replace(/\/+$/, '');
    _apiBase = normalized.endsWith('/api') ? normalized : `${normalized}/api`;
    await AsyncStorage.setItem(API_URL_KEY, _apiBase);
  }
}

export async function setApiUrl(url: string): Promise<void> {
  await setNodeMode('custom', url);
}

export async function resetApiUrl(): Promise<void> {
  await setNodeMode('fallback');
}

export function sessionHeaders(): Record<string, string> {
  return { 'X-Client-Session': getSessionId() };
}

function startPrimaryRetry() {
  if (_primaryRetryTimer || _nodeMode !== 'primary') return;
  _primaryRetryTimer = setInterval(async () => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      const r = await fetch(`${API_NODES.primary}/healthz`, { signal: ctrl.signal });
      clearTimeout(t);
      if (r.ok) {
        _usingFallback = false;
        if (_primaryRetryTimer) { clearInterval(_primaryRetryTimer); _primaryRetryTimer = null; }
      }
    } catch {}
  }, 60_000);
}

async function fetchWithFallback(url: string, init: RequestInit): Promise<Response> {
  try {
    const resp = await fetch(url, init);
    return resp;
  } catch (err) {
    if (_nodeMode === 'primary' && !_usingFallback) {
      _usingFallback = true;
      startPrimaryRetry();
      const fallbackUrl = url.replace(_apiBase ?? '', API_NODES.fallback);
      return fetch(fallbackUrl, init);
    }
    throw err;
  }
}

export async function apiFetch<T>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const base = getApiBase();
  const resp = await fetchWithFallback(`${base}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...sessionHeaders(),
      ...(options?.headers ?? {}),
    },
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`HTTP ${resp.status}: ${text}`);
  }
  return resp.json() as Promise<T>;
}

export async function testServerConnection(url: string): Promise<{ ok: boolean; message: string }> {
  try {
    const normalized = url.trim().replace(/\/+$/, '');
    const base = normalized.endsWith('/api') ? normalized : `${normalized}/api`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(`${base}/healthz`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (resp.ok) {
      return { ok: true, message: 'Подключено' };
    }
    return { ok: false, message: `Сервер вернул ${resp.status}` };
  } catch (e: any) {
    if (e.name === 'AbortError') {
      return { ok: false, message: 'Тайм-аут подключения (5с)' };
    }
    return { ok: false, message: e.message ?? 'Ошибка подключения' };
  }
}
