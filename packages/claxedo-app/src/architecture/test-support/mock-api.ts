/**
 * Shared `bun.mock.module` fixture for `../api.ts`.
 *
 * API client suites (persist.test.ts and friends) used to hand-copy a full mock of every export of
 * `./api` — and their own comments documented a real hazard: Bun's module
 * cache is process-wide across a `bun test` run, so one file's
 * `mock.module("./api", ...)` (or `mock.module("../api", ...)`,
 * or `mock.module("@/platform/api/api", ...)` — all specifier forms
 * resolve to the same absolute file and therefore the same cache slot) can
 * leak into another file and silently swap out its behavior for whatever
 * the last-registered copy implemented. `persist.test.ts` carries a
 * paragraph explaining exactly this.
 *
 * This fixture kills the hazard at the root: there is now exactly one
 * implementation of the mocked module's pure surface (isDemoMode,
 * isDemoPath, isEmbedMode, isHostedAppHostname, fixDir, normalizeUrl) for
 * every caller to share, so "which copy won the race" no longer matters —
 * they're all the same copy. The pure functions are DELIBERATELY
 * re-implemented here rather than `import`-ed live from `../api.ts`: this
 * file loads before any test file's `mock.module` call runs, so an eager
 * `import * as RealApi from "../api"` could itself be served a stale mock
 * from a module that mocked `./api` earlier in the same process, silently
 * reintroducing the exact bug this fixture exists to remove.
 * `mock-api.test.ts` pins these copies against the real module (imported
 * via the same cache-busting-query technique api.test.ts uses) so any
 * future drift in `../api.ts` is caught here instead of shipping silently.
 *
 * Only `authFetch` / `api` (the true network-I/O boundary) are mocked
 * per HLD 5's "mock only true I/O boundaries" rule; everything else below
 * is either that boundary or a faithful pure-logic mirror of it.
 *
 * Usage (mock.module is called from the *.test.ts file, not from here —
 * see "Why createMockApi doesn't call mock.module itself" below):
 *   import { mock } from "bun:test"
 *   import { createMockApi } from "../architecture/test-support/mock-api"
 *   const fixture = createMockApi({ baseUrl: "http://test.local" })
 *   mock.module("./api", () => fixture.module)
 *   const { documentsApi } = await import("@/features/documents/data/documents-api")
 *   beforeEach(() => fixture.reset())
 *   // ...
 *   expect(fixture.calls).toEqual([{ url: "http://test.local/documents", init: undefined }])
 *
 * For scenarios that need response routing keyed off the request (e.g. a
 * mock that returns different bodies per pathname), pass a full
 * `authFetch` override in `overrides` — `fixture.calls`/`setResponse` are
 * simply unused in that case, the rest of the module (getClaxedoServerUrl,
 * isDemoMode, ...) is still shared.
 *
 * Why createMockApi doesn't call mock.module itself: tsconfig.json's
 * `include` covers src/**\/*.ts but excludes src/**\/*.test.ts, so this
 * file (not name-matched *.test.ts) is part of the checked app build and
 * cannot import "bun:test" — only *.test.ts files carry that type
 * dependency. Call `mock.module(specifier, () => fixture.module)` from
 * your *.test.ts file instead; `createMockApi` never needs bun:test.
 */

export type MockApiCall = {
  url: string
  init?: RequestInit
}

export type MockApiResponseSpec = {
  status?: number
  body?: string
  contentType?: string
}

export type ApiModuleShape = {
  configureApiRuntime: (input: { baseUrl?: string | null; password?: string | null }) => void
  resetApiRuntime: () => void
  isDemoPath: (path: string) => boolean
  isDemoMode: () => boolean
  isEmbedMode: () => boolean
  isHostedAppHostname: (hostname: string | undefined) => boolean
  fixDir: (input: string | undefined) => string | undefined
  normalizeUrl: (url: string | undefined) => string | undefined
  getClaxedoServerUrl: () => string
  getConfiguredClaxedoServerUrl: () => string | undefined
  getDefaultBaseUrl: () => string
  authFetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  /** Mirrors the real reader's unbound state: a mock has no bearer source. */
  apiBearerToken: (options?: { skipCache?: boolean }) => Promise<string | null>
  api: {
    get<T = unknown>(url: string): Promise<T>
    post<T = unknown>(url: string, body?: unknown): Promise<T>
    put<T = unknown>(url: string, body?: unknown): Promise<T>
    patch<T = unknown>(url: string, body?: unknown): Promise<T>
    delete<T = unknown>(url: string): Promise<T>
  }
}

export type MockApiOverrides = Partial<ApiModuleShape> & {
  /**
   * Convenience: sets getClaxedoServerUrl/getConfiguredClaxedoServerUrl/
   * getDefaultBaseUrl all to this fixed value, matching how every current
   * consumer pins a "http://test.local"-style base for URL assertions.
   * Ignored for any of the three getters passed explicitly in `overrides`.
   */
  baseUrl?: string
}

export type MockApiFixture = {
  /** Every call that went through the default (non-overridden) authFetch. */
  calls: MockApiCall[]
  /** Pass this as the return value of a `mock.module(specifier, () => ...)` factory. */
  module: ApiModuleShape
  /** Replace the response used for every subsequent call, until reset() or the next setResponse(). */
  setResponse: (next: MockApiResponseSpec | Response) => void
  /** Shorthand for setResponse({ status, body }) with a JSON content type. */
  fail: (status: number, body?: string) => void
  /** Clears recorded calls and restores the default 200 {} response. */
  reset: () => void
}

// Mirrors ../api.ts's isDemoPath exactly — see file header for why this is
// a deliberate copy rather than a live import.
function isDemoPath(path: string): boolean {
  return path === "/demo" || path.startsWith("/demo/")
}

function isDemoMode(): boolean {
  if (typeof window === "undefined") return false
  return isDemoPath(window.location.pathname)
}

function isEmbedMode(): boolean {
  if (typeof window === "undefined") return false
  return new URLSearchParams(window.location.search).has("embed")
}

function isHostedAppHostname(hostname: string | undefined): boolean {
  const host = hostname?.toLowerCase()
  return host === "claxedo.com" || host?.endsWith(".claxedo.com") === true
}

function fixDir(input: string | undefined): string | undefined {
  const txt = input?.trim()
  if (!txt) return undefined
  if (txt.startsWith("/")) return txt
  const hit = ["/Users/", "/private/", "/Volumes/", "/home/"]
    .map((item) => txt.indexOf(item))
    .filter((item) => item >= 0)
    .sort((a, b) => a - b)[0]
  if (hit !== undefined) return txt.slice(hit)
  if (/^(Users|private|Volumes|home)\//.test(txt)) return `/${txt}`
  return txt
}

function normalizeUrl(url: string | undefined): string | undefined {
  const trimmed = url?.trim()
  if (!trimmed) return undefined
  return trimmed.replace(/\/+$/, "")
}

const DEFAULT_RESPONSE: MockApiResponseSpec = {
  status: 200,
  body: "{}",
  contentType: "application/json",
}

function toResponse(spec: MockApiResponseSpec | Response): Response {
  if (spec instanceof Response) return spec.clone()
  return new Response(spec.body ?? "{}", {
    status: spec.status ?? 200,
    headers: { "Content-Type": spec.contentType ?? "application/json" },
  })
}

/**
 * Builds a fresh, isolated mock of `../api.ts`'s full export surface.
 * Does NOT register it with `mock.module` — pass `fixture.module` to your
 * own `mock.module(specifier, () => ...)` call (see file header), or use
 * `mockApiRegistration` below for the common case.
 */
export function createMockApi(overrides: MockApiOverrides = {}): MockApiFixture {
  const calls: MockApiCall[] = []
  let response: MockApiResponseSpec | Response = DEFAULT_RESPONSE

  const defaultAuthFetch: ApiModuleShape["authFetch"] = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    calls.push({ url, init })
    return toResponse(response)
  }

  const authFetch = overrides.authFetch ?? defaultAuthFetch

  const getClaxedoServerUrl =
    overrides.getClaxedoServerUrl ?? (overrides.baseUrl !== undefined ? () => overrides.baseUrl as string : () => "http://test.local")
  const getConfiguredClaxedoServerUrl =
    overrides.getConfiguredClaxedoServerUrl ?? (overrides.baseUrl !== undefined ? () => overrides.baseUrl : () => undefined)
  const getDefaultBaseUrl =
    overrides.getDefaultBaseUrl ?? (overrides.baseUrl !== undefined ? () => overrides.baseUrl as string : () => "http://test.local")

  function apiUrl(url: string): string {
    if (!url.startsWith("/")) return url
    return new URL(url, getClaxedoServerUrl()).toString()
  }

  function jsonBody(body: unknown): string | undefined {
    return body === undefined ? undefined : JSON.stringify(body)
  }

  async function jsonRequest<T = unknown>(url: string, init?: RequestInit): Promise<T> {
    const res = await authFetch(apiUrl(url), init)
    if (!res.ok) {
      const err = await res.text()
      throw new Error(err || `Request failed: ${res.status}`)
    }
    return res.json()
  }

  const defaultApi: ApiModuleShape["api"] = {
    get: (url) => jsonRequest(url),
    post: (url, body) => jsonRequest(url, { method: "POST", body: jsonBody(body) }),
    put: (url, body) => jsonRequest(url, { method: "PUT", body: jsonBody(body) }),
    patch: (url, body) => jsonRequest(url, { method: "PATCH", body: jsonBody(body) }),
    delete: (url) => jsonRequest(url, { method: "DELETE" }),
  }

  const module: ApiModuleShape = {
    configureApiRuntime: overrides.configureApiRuntime ?? (() => undefined),
    resetApiRuntime: overrides.resetApiRuntime ?? (() => undefined),
    isDemoPath: overrides.isDemoPath ?? isDemoPath,
    isDemoMode: overrides.isDemoMode ?? isDemoMode,
    isEmbedMode: overrides.isEmbedMode ?? isEmbedMode,
    isHostedAppHostname: overrides.isHostedAppHostname ?? isHostedAppHostname,
    fixDir: overrides.fixDir ?? fixDir,
    normalizeUrl: overrides.normalizeUrl ?? normalizeUrl,
    getClaxedoServerUrl,
    getConfiguredClaxedoServerUrl,
    getDefaultBaseUrl,
    authFetch,
    apiBearerToken: overrides.apiBearerToken ?? (async () => null),
    api: overrides.api ?? defaultApi,
  }

  return {
    calls,
    module,
    setResponse(next) {
      response = next
    },
    fail(status, body = "Request failed") {
      response = { status, body, contentType: "application/json" }
    },
    reset() {
      calls.length = 0
      response = DEFAULT_RESPONSE
    },
  }
}

/**
 * Convenience for the common case: build a fixture and hand back both it
 * and the `mock.module` args to register it with. Caller still owns the
 * actual `mock.module(...)` call (see file header) since that requires
 * importing `mock` from "bun:test", which this file deliberately does not.
 * `specifier` should be "@/platform/api/api" in new call sites — that
 * alias resolves, via tsconfig paths, to the same absolute file as `./api`
 * from utils/ or `../../utils/api` from a nested directory, so registering
 * it covers every current caller regardless of which directory their test
 * file lives in.
 *
 * Usage:
 *   const { fixture, register } = mockApiRegistration({ baseUrl: "http://test.local" })
 *   mock.module(...register)
 */
export function mockApiRegistration(
  overrides: MockApiOverrides = {},
  specifier = "@/platform/api/api",
): { fixture: MockApiFixture; register: [string, () => ApiModuleShape] } {
  const fixture = createMockApi(overrides)
  return { fixture, register: [specifier, () => fixture.module] }
}
