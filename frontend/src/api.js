import axios from "axios";

/**
 * Shared API client.
 *
 * The base URL was previously hardcoded as "http://localhost:5000" in six
 * places across four components. It is now configured through
 * VITE_API_URL (see .env.example), so deploying against another host does not
 * require editing source.
 */
// Empty by default: requests are same-origin and the Vite dev server proxies
// /api and /uploads to the backend. Set VITE_API_URL for a separate API host.
const API_URL = import.meta.env.VITE_API_URL || "";

export const TOKEN_KEY = "token";

const api = axios.create({
  baseURL: `${API_URL}/api`,
  headers: { "Content-Type": "application/json" },
});

/** Read the stored JWT, or null when signed out. */
export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

// Attach the JWT to every request, using the standard Bearer scheme.
// The backend also accepts a bare token, so older clients keep working.
api.interceptors.request.use((config) => {
  const token = getToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

/**
 * Normalize errors into a consistent { message, status } shape so components
 * do not have to dig through axios internals.
 *
 * A 401 means the token expired or the account was removed: clear it so the
 * app falls back to the login screen instead of looping on failed requests.
 */
api.interceptors.response.use(
  (response) => response,
  (error) => {
    const status = error.response?.status;
    const message =
      error.response?.data?.message ||
      (error.code === "ERR_NETWORK"
        ? "Cannot reach the server. Is the backend running?"
        : "Something went wrong. Please try again.");

    if (status === 401) {
      clearToken();
    }

    return Promise.reject({ message, status });
  }
);

/**
 * Full URL for a file the API serves (for example an uploaded menu photo).
 * Absolute URLs pass through unchanged; anything else is returned as-is.
 */
export function assetUrl(path) {
  if (!path) return null;
  if (/^https?:\/\//.test(path)) return path;
  if (path.startsWith("/uploads/")) return `${API_URL}${path}`;
  return path;
}

export default api;