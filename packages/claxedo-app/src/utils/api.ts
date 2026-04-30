/**
 * Shared API helpers for web and desktop.
 */
import { getAuthToken } from "./auth-client";

const cfg = {
  base: undefined as string | undefined,
  password: "",
}

export function configureApiRuntime(input: {
  baseUrl?: string | null
  password?: string | null
}) {
  if ("baseUrl" in input) {
    cfg.base = normalized(input.baseUrl ?? undefined)
  }
  if ("password" in input) {
    cfg.password = input.password?.trim() ?? ""
  }
}

export function resetApiRuntime() {
  cfg.base = undefined
  cfg.password = ""
}

/**
 * Returns true when the app is running in demo/preview mode.
 * Triggered by the `/demo` path prefix in the URL.
 */
export function isDemoPath(path: string) {
  return path === "/demo" || path.startsWith("/demo/")
}

export function isDemoMode() {
  if (typeof window === "undefined") return false
  return isDemoPath(window.location.pathname)
}

export function isEmbedMode() {
  if (typeof window === "undefined") return false
  return new URLSearchParams(window.location.search).has("embed")
}

export function fixDir(input: string | undefined) {
  const txt = input?.trim()
  if (!txt) return
  if (txt.startsWith("/")) return txt
  const hit = ["/Users/", "/private/", "/Volumes/", "/home/"]
    .map((item) => txt.indexOf(item))
    .filter((item) => item >= 0)
    .sort((a, b) => a - b)[0]

  if (hit !== undefined) return txt.slice(hit)
  if (/^(Users|private|Volumes|home)\//.test(txt)) return `/${txt}`
  return txt
}

function normalized(url: string | undefined): string | undefined {
  const trimmed = url?.trim()
  if (!trimmed) return
  return trimmed.replace(/\/+$/, "")
}

/**
 * Get the base URL for claxedo-server API calls (PTY, pages, events, etc.)
 * In demo mode returns the current origin so MSW service worker intercepts requests.
 */
export function getClaxedoServerUrl(): string {
  if (isDemoMode()) return normalized(window.location.origin) ?? window.location.origin
  const envUrl = import.meta.env.VITE_CLAXEDO_SERVER_URL as string | undefined
  if (envUrl?.trim()) return envUrl.trim().replace(/\/+$/, "")
  // In desktop mode, claxedo-server runs on a dynamic port and the URL is
  // set via configureApiRuntime() during init. Fall back to it before the
  // hardcoded default so PTY/events/pages calls reach the right server.
  if (cfg.base) return cfg.base
  return "http://127.0.0.1:3001"
}

/**
 * Get the default base URL for API calls.
 * On desktop, reads the sidecar URL set during init.
 */
export function getDefaultBaseUrl(): string {
  // Demo mode: use current origin so MSW service worker intercepts all requests
  if (isDemoMode()) return window.location.origin

  if (cfg.base) return cfg.base

  // Desktop: sidecar URL is set during init
  const serverUrl = (window as any).__OPENCODE__?.serverUrl as string | undefined
  if (serverUrl) return normalized(serverUrl) ?? serverUrl

  const backendUrl = normalized(import.meta.env.VITE_OPENCODE_BACKEND_URL as string | undefined)
  if (backendUrl) return backendUrl

  if (typeof window !== "undefined") {
    const host = window.location.hostname
    const local = host === "localhost" || host === "127.0.0.1"
    if (local && window.location.port === "4444") {
      return `http://${host}:4096`
    }
  }

  return normalized(window.location.origin) ?? window.location.origin
}

/**
 * Make an authenticated fetch request.
 * Prefers cloud bearer auth and falls back to configured desktop basic auth.
 */
export async function authFetch(
  input: string | URL | Request,
  init?: RequestInit
): Promise<Response> {
  const token = await getAuthToken();

  const setAuth = (headers: Headers) => {
    if (headers.has("Authorization")) return
    if (token) {
      headers.set("Authorization", `Bearer ${token}`);
      return
    }
    if (!cfg.password) return
    headers.set("Authorization", `Basic ${btoa(`opencode:${cfg.password}`)}`);
  }

  // Handle Request object (SDK passes Request objects directly)
  if (input instanceof Request) {
    const existingHeaders = new Headers(input.headers);
    setAuth(existingHeaders);
    // Create a new Request with updated headers
    return fetch(new Request(input, { ...init, headers: existingHeaders }));
  }

  // Handle (url, options) style
  const headers = new Headers(init?.headers);
  setAuth(headers);

  // Ensure Content-Type is set for JSON requests
  if (init?.body && typeof init.body === "string" && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  return fetch(input, {
    ...init,
    headers,
  });
}

/**
 * API client with common methods
 */
export const api = {
  /**
   * GET request with auth
   */
  async get<T = any>(url: string): Promise<T> {
    const res = await authFetch(url);
    if (!res.ok) {
      const err = await res.text();
      throw new Error(err || `Request failed: ${res.status}`);
    }
    return res.json();
  },

  /**
   * POST request with auth
   */
  async post<T = any>(url: string, body?: any): Promise<T> {
    const res = await authFetch(url, {
      method: "POST",
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(err || `Request failed: ${res.status}`);
    }
    return res.json();
  },

  /**
   * PUT request with auth
   */
  async put<T = any>(url: string, body?: any): Promise<T> {
    const res = await authFetch(url, {
      method: "PUT",
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(err || `Request failed: ${res.status}`);
    }
    return res.json();
  },

  /**
   * PATCH request with auth
   */
  async patch<T = any>(url: string, body?: any): Promise<T> {
    const res = await authFetch(url, {
      method: "PATCH",
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(err || `Request failed: ${res.status}`);
    }
    return res.json();
  },

  /**
   * DELETE request with auth
   */
  async delete<T = any>(url: string): Promise<T> {
    const res = await authFetch(url, {
      method: "DELETE",
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(err || `Request failed: ${res.status}`);
    }
    return res.json();
  },
};
