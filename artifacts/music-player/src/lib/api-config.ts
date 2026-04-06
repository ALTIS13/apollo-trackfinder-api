const envApiUrl = import.meta.env.VITE_API_URL as string | undefined;

export const API_BASE: string = envApiUrl
  ? envApiUrl.replace(/\/+$/, "")
  : `${import.meta.env.BASE_URL}api`.replace(/\/+/g, "/").replace(":/", "://");

export function apiUrl(path: string): string {
  return `${API_BASE}${path.startsWith("/") ? "" : "/"}${path}`;
}
