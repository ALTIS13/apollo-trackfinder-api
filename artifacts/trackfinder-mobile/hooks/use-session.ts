import AsyncStorage from '@react-native-async-storage/async-storage';

const SESSION_KEY = 'trackfinder_session_id';
const API_URL_KEY = 'trackfinder_api_url';

let _sessionId: string | null = null;
let _apiBase: string | null = null;

function makeId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

function defaultApiBase(): string {
  const domain = process.env.EXPO_PUBLIC_DOMAIN;
  if (domain) return `https://${domain}/api`;
  return 'http://localhost:8080/api';
}

export async function initSession(): Promise<void> {
  try {
    const [storedSession, storedUrl] = await Promise.all([
      AsyncStorage.getItem(SESSION_KEY),
      AsyncStorage.getItem(API_URL_KEY),
    ]);
    if (storedSession) {
      _sessionId = storedSession;
    } else {
      _sessionId = makeId();
      await AsyncStorage.setItem(SESSION_KEY, _sessionId);
    }
    _apiBase = storedUrl ?? defaultApiBase();
  } catch {
    _sessionId = makeId();
    _apiBase = defaultApiBase();
  }
}

export function getSessionId(): string {
  if (!_sessionId) _sessionId = makeId();
  return _sessionId;
}

export function getApiBase(): string {
  if (!_apiBase) _apiBase = defaultApiBase();
  return _apiBase;
}

export function getConfiguredApiUrl(): string {
  return _apiBase ?? defaultApiBase();
}

export async function setApiUrl(url: string): Promise<void> {
  const normalized = url.trim().replace(/\/+$/, '');
  _apiBase = normalized.endsWith('/api') ? normalized : `${normalized}/api`;
  await AsyncStorage.setItem(API_URL_KEY, _apiBase);
}

export async function resetApiUrl(): Promise<void> {
  _apiBase = defaultApiBase();
  await AsyncStorage.removeItem(API_URL_KEY);
}

export function sessionHeaders(): Record<string, string> {
  return { 'X-Client-Session': getSessionId() };
}

export async function apiFetch<T>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const base = getApiBase();
  const resp = await fetch(`${base}${path}`, {
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
      return { ok: true, message: 'Connected successfully' };
    }
    return { ok: false, message: `Server returned ${resp.status}` };
  } catch (e: any) {
    if (e.name === 'AbortError') {
      return { ok: false, message: 'Connection timed out (5s)' };
    }
    return { ok: false, message: e.message ?? 'Connection failed' };
  }
}
