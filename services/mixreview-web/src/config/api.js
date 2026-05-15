const productionApiBaseUrl = "https://wavstat-api-production.up.railway.app";
const configuredApiBaseUrl =
  import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, "") ||
  (import.meta.env.PROD ? productionApiBaseUrl : "");

export function apiUrl(path) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${configuredApiBaseUrl}${normalizedPath}`;
}

export const apiBaseUrl = configuredApiBaseUrl;
