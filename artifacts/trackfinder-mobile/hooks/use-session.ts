import AsyncStorage from '@react-native-async-storage/async-storage';

const SESSION_KEY = 'trackfinder_session_id';

let _sessionId: string | null = null;

function makeId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

export async function initSession(): Promise<string> {
  if (_sessionId) return _sessionId;
  try {
    const stored = await AsyncStorage.getItem(SESSION_KEY);
    if (stored) {
      _sessionId = stored;
    } else {
      _sessionId = makeId();
      await AsyncStorage.setItem(SESSION_KEY, _sessionId);
    }
  } catch {
    _sessionId = makeId();
  }
  return _sessionId;
}

export function getSessionId(): string {
  if (!_sessionId) _sessionId = makeId();
  return _sessionId;
}

export function sessionHeaders(): Record<string, string> {
  return { 'X-Client-Session': getSessionId() };
}

export function getApiBase(): string {
  const domain = process.env.EXPO_PUBLIC_DOMAIN;
  return domain ? `https://${domain}/api` : '/api';
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
