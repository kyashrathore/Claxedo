/**
 * Authenticated API client using Clerk tokens
 */
import { getAuthToken } from "./auth-client";

/**
 * Returns true when the app is running in demo/preview mode.
 * Triggered by `?demo` query parameter in the URL.
 * Cached — URL params don't change during the page lifecycle.
 */
function flag(cacheKey: string, query: string) {
  if (typeof window === "undefined") return false
  const known = (window as any)[cacheKey]
  if (typeof known === "boolean") {
    return known
  }
  const next = new URLSearchParams(window.location.search).has(query)
  ;(window as any)[cacheKey] = next
  return next
}

export function isDemoMode(): boolean {
  return flag("__CLAXEDO_DEMO__", "demo")
}

export function isEmbedMode(): boolean {
  return flag("__CLAXEDO_EMBED__", "embed")
}

function normalized(url: string | undefined): string | undefined {
  const trimmed = url?.trim()
  if (!trimmed) return
  return trimmed.replace(/\/+$/, "")
}

/**
 * Get the default base URL for API calls.
 * On desktop, reads the sidecar URL set during init.
 */
export function getDefaultBaseUrl(): string {
  // Demo mode: use current origin so MSW service worker intercepts all requests
  if (isDemoMode()) return window.location.origin

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
 * Make an authenticated fetch request with Clerk JWT token.
 * Supports both (url, options) and (Request) calling conventions.
 */
export async function authFetch(
  input: string | URL | Request,
  init?: RequestInit
): Promise<Response> {
  if (isDemoMode()) {
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input)
    if (url.includes("/api/pages")) {
      console.log("[demo-authFetch] pages request:", init?.method ?? "GET", url)
    }
  }
  const token = await getAuthToken();

  // On desktop, fall back to Basic auth with the sidecar password
  const serverPassword = (window as any).__OPENCODE__?.serverPassword as string | undefined

  const activeDirectory = (window as any).__OPENCODE__?.activeDirectory as string | undefined

  const setAuth = (headers: Headers) => {
    if (token) {
      headers.set("Authorization", `Bearer ${token}`);
    } else if (serverPassword) {
      headers.set("Authorization", `Basic ${btoa(`opencode:${serverPassword}`)}`);
    }
    if (activeDirectory && !headers.has("x-opencode-directory")) {
      headers.set("x-opencode-directory", activeDirectory);
    }
  }

  // Handle Request object (SDK passes Request objects directly)
  if (input instanceof Request) {
    const existingHeaders = new Headers(input.headers);
    setAuth(existingHeaders);
    // Create a new Request with updated headers
    return fetch(new Request(input, { headers: existingHeaders }));
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
