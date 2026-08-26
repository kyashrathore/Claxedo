/**
 * The user-extension loader — the renderer half of user-extendable UI.
 *
 * `@claxedo/local-server` lists validated manifests from
 * `~/.claxedo/extensions/<name>/claxedo-extension.json` and serves each
 * extension's files (see `local-server/src/extensions/user-extension-routes.ts`).
 * This module fetches that list, imports each entry module over HTTP, and calls
 * its exported `activate(api)` with the frozen v1 API. Views land in
 * `user-extension-views.ts`, which the workbench host surface and command
 * palette read reactively.
 *
 * Boundaries that matter:
 * - Never on the boot path. The only production caller is an idle callback
 *   scheduled after boot settles, and the import is a runtime `import()` of a
 *   server URL (`@vite-ignore`), so nothing here can grow the eager graph.
 * - Local product only. The caller gates on the loopback transport, and the
 *   server refuses the routes outright on hosted/signed deployments.
 * - One broken extension cannot take the rest down: each activation is
 *   isolated, and a throwing `activate` rolls back the views it registered.
 */

import {
  registerUserExtensionView,
  removeUserExtensionViews,
  type UserExtensionView,
  type UserExtensionViewContext,
} from "./user-extension-views"

export type { UserExtensionView, UserExtensionViewContext }

/** `localStorage["claxedo.user-extensions"] = "off"` disables loading entirely. */
export const USER_EXTENSIONS_KILL_SWITCH = "claxedo.user-extensions"

/** An extension must finish importing and activating before the loader moves on. */
export const USER_EXTENSION_ACTIVATION_TIMEOUT_MS = 10_000

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
const VIEW_ID_PATTERN = /^[\w-]{1,64}$/

export type UserExtensionManifest = {
  name: string
  version: string
  apiVersion: 1
  entryPath: string
  displayName?: string
  description?: string
}

/** What `activate` receives. Frozen, so an extension cannot rewrite it for the next one. */
export type UserExtensionApi = {
  apiVersion: 1
  extension: { name: string; version: string; baseUrl: string }
  registerView(view: {
    id: string
    title: string
    mount: (container: HTMLElement, context: UserExtensionViewContext) => (() => void) | void
  }): void
}

export type UserExtensionModule = {
  activate?: (api: UserExtensionApi) => void | Promise<void>
}

export type UserExtensionLoadResult = {
  loaded: Array<{ name: string; version: string; views: number }>
  failed: Array<{ name: string; error: string }>
}

/** Narrower than `typeof fetch` on purpose: the loader only ever GETs a URL string. */
export type UserExtensionFetcher = (url: string) => Promise<Response>

type LoadOptions = {
  baseUrl: string
  fetcher?: UserExtensionFetcher
  importModule?: (url: string) => Promise<UserExtensionModule>
  activationTimeoutMs?: number
}

export function userExtensionsDisabled(): boolean {
  try {
    return globalThis.localStorage?.getItem(USER_EXTENSIONS_KILL_SWITCH) === "off"
  } catch {
    return false
  }
}

function manifestFromListing(input: unknown): UserExtensionManifest | undefined {
  if (!input || typeof input !== "object") return
  const item = input as Record<string, unknown>
  if (typeof item.name !== "string" || !NAME_PATTERN.test(item.name)) return
  if (typeof item.version !== "string" || !item.version) return
  if (item.apiVersion !== 1) return
  if (typeof item.entryPath !== "string" || !item.entryPath.startsWith("/api/claxedo/extensions/")) return
  return {
    name: item.name,
    version: item.version,
    apiVersion: 1,
    entryPath: item.entryPath,
    ...(typeof item.displayName === "string" ? { displayName: item.displayName } : {}),
    ...(typeof item.description === "string" ? { description: item.description } : {}),
  }
}

type ExtensionActivationAuthority = {
  api: UserExtensionApi
  assertActive(): void
  revoke(): void
}

/**
 * Owns every host capability granted to one activation.
 *
 * A timed-out promise cannot be cancelled in JavaScript. Revoking this
 * authority is the stronger boundary: it rolls back views already registered
 * and makes every later `registerView` call from the abandoned activation
 * fail, so the promise may keep executing but can no longer mutate the host.
 */
function extensionActivationAuthority(
  manifest: UserExtensionManifest,
  baseUrl: string,
  registered: string[],
): ExtensionActivationAuthority {
  let active = true
  const assertActive = () => {
    if (!active) throw new Error(`Extension "${manifest.name}" activation is no longer active`)
  }
  const api: UserExtensionApi = Object.freeze({
    apiVersion: 1 as const,
    extension: Object.freeze({ name: manifest.name, version: manifest.version, baseUrl }),
    registerView(view) {
      assertActive()
      if (typeof view?.id !== "string" || !VIEW_ID_PATTERN.test(view.id)) {
        throw new Error(`registerView: id must match ${VIEW_ID_PATTERN}`)
      }
      if (typeof view.title !== "string" || !view.title.trim()) {
        throw new Error("registerView: title is required")
      }
      if (typeof view.mount !== "function") {
        throw new Error("registerView: mount must be a function")
      }
      const id = `${manifest.name}.${view.id}`
      registerUserExtensionView({
        id,
        title: view.title,
        extension: { name: manifest.name, version: manifest.version },
        mount: view.mount,
      })
      registered.push(id)
    },
  })
  return {
    api,
    assertActive,
    revoke() {
      if (!active) return
      active = false
      removeUserExtensionViews(manifest.name)
    },
  }
}

function beforeDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
  description: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      // Revoke synchronously in the timer callback, before the loader's catch
      // continuation can start the next manifest.
      onTimeout()
      reject(new Error(`${description} timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    void operation.then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        resolve(value)
      },
      (error) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        reject(error)
      },
    )
  })
}

async function activateExtension(manifest: UserExtensionManifest, options: Required<LoadOptions>) {
  const registered: string[] = []
  const entryUrl = new URL(manifest.entryPath, options.baseUrl).href
  const authority = extensionActivationAuthority(manifest, options.baseUrl, registered)
  try {
    const attempt = (async () => {
      const module = await options.importModule(entryUrl)
      // An import that completes after the deadline must not receive the API.
      authority.assertActive()
      if (typeof module?.activate !== "function") {
        throw new Error("entry module does not export an activate(api) function")
      }
      await module.activate(authority.api)
      authority.assertActive()
      return { name: manifest.name, version: manifest.version, views: registered.length }
    })()
    return await beforeDeadline(
      attempt,
      options.activationTimeoutMs,
      authority.revoke,
      `Extension "${manifest.name}" activation`,
    )
  } catch (error) {
    // Roll back whatever the failed activation managed to register — a
    // half-activated extension is harder to reason about than an absent one.
    authority.revoke()
    throw error
  }
}

export async function loadUserExtensions(options: LoadOptions): Promise<UserExtensionLoadResult> {
  const resolved: Required<LoadOptions> = {
    baseUrl: options.baseUrl,
    fetcher: options.fetcher ?? ((url) => globalThis.fetch(url)),
    importModule: options.importModule ?? ((url) => import(/* @vite-ignore */ url) as Promise<UserExtensionModule>),
    activationTimeoutMs: options.activationTimeoutMs ?? USER_EXTENSION_ACTIVATION_TIMEOUT_MS,
  }
  const response = await resolved.fetcher(new URL("/api/claxedo/extensions", resolved.baseUrl).href)
  if (!response.ok) throw new Error(`extension listing failed with ${response.status}`)
  const body = (await response.json()) as { extensions?: unknown[] }
  const manifests = (body.extensions ?? []).flatMap((item) => {
    const manifest = manifestFromListing(item)
    return manifest ? [manifest] : []
  })

  const result: UserExtensionLoadResult = { loaded: [], failed: [] }
  for (const manifest of manifests) {
    try {
      result.loaded.push(await activateExtension(manifest, resolved))
    } catch (error) {
      result.failed.push({ name: manifest.name, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return result
}

let loadStarted = false

/**
 * Loads user extensions once boot settles. Same idle shape as
 * `scheduleMarkdownPrewarm`: requestIdleCallback keeps it strictly off the
 * boot critical path, environments without it (test DOMs) skip loading, and
 * the returned disposer suits `onCleanup`. A listing failure re-arms the
 * once-flag so a later call can retry; activation failures do not, because
 * re-running a broken extension's module would double its side effects.
 */
export function scheduleUserExtensionLoad(baseUrl: string): () => void {
  if (typeof requestIdleCallback !== "function") return () => {}
  if (loadStarted || userExtensionsDisabled()) return () => {}
  loadStarted = true
  const idle = requestIdleCallback(() => {
    loadUserExtensions({ baseUrl })
      .then((result) => {
        for (const failure of result.failed) {
          console.warn(`[user-extensions] ${failure.name} failed to activate: ${failure.error}`)
        }
      })
      .catch((error) => {
        loadStarted = false
        console.warn(`[user-extensions] listing failed: ${error instanceof Error ? error.message : String(error)}`)
      })
  })
  return () => cancelIdleCallback(idle)
}
