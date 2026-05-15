const productionApiBaseUrl = "https://wavstat-api-production.up.railway.app";
const frontendProductionOrigin = "https://mixreview.kingzbreadent.com";
const configuredApiBaseUrl = resolveApiBaseUrl(import.meta.env.VITE_API_BASE_URL);

export function apiUrl(path) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${configuredApiBaseUrl}${normalizedPath}`;
}

export const apiBaseUrl = configuredApiBaseUrl;

function resolveApiBaseUrl(value) {
  const configuredValue = normalizeApiBaseUrl(value);

  if (!import.meta.env.PROD) {
    return configuredValue;
  }

  if (!configuredValue || configuredValue === frontendProductionOrigin) {
    return productionApiBaseUrl;
  }

  return configuredValue;
}

function normalizeApiBaseUrl(value) {
  if (!value || typeof value !== "string") {
    return "";
  }

  return value
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/api$/, "");
}
