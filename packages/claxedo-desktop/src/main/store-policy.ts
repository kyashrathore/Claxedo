/**
 * Boundary policy for the renderer-reachable settings stores.
 *
 * `getStore` hands `name` to electron-store, whose `conf` resolves
 * `${name}.json` under its cwd with `path.resolve` — a name containing path
 * separators, a `..` segment, or a leading dot would read and write JSON
 * outside the settings directory. The renderer derives store names per
 * workspace (`claxedo.server.<host>.<sum>.workspace.<dir>.<sum>.dat` and
 * friends), so they cannot be enumerated in a fixed registry; the boundary is
 * a basename grammar instead.
 *
 * Pure module — `store.ts` constructs electron-store at import time, which is
 * impossible under `bun test`, so the checks live here.
 */

import { CLI_SIGN_IN_MODE_KEY } from "./account/cli-credential-file"
import { DEFAULT_SERVER_URL_KEY, SETTINGS_STORE, WSL_ENABLED_KEY } from "./constants"

// The longest legitimate name is a server-workspace store (~80 chars).
const STORE_NAME_MAX = 160
const STORE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

// Keys are product identifiers (`workspace:<k>`, `session:<id>:<k>`); values
// are JSON-serialized persisted state.
const STORE_KEY_MAX = 1024
const STORE_VALUE_MAX = 16 * 1024 * 1024

export function isAllowedStoreName(name: string): boolean {
  return name.length <= STORE_NAME_MAX && !name.includes("..") && STORE_NAME_PATTERN.test(name)
}

export function assertStoreName(name: unknown): asserts name is string {
  if (typeof name !== "string" || !isAllowedStoreName(name)) {
    throw new Error("invalid settings store name")
  }
}

export function assertStoreKey(key: unknown): asserts key is string {
  if (typeof key !== "string" || key.length === 0 || key.length > STORE_KEY_MAX) {
    throw new Error("invalid settings store key")
  }
}

/**
 * Settings main reads to decide what it does with the account or where it
 * connects. A renderer value reaches the default server and WSL keys only
 * through their own validating handlers, and never reaches `cliSignInMode`,
 * which can put the refresh token in a plaintext file. `store-clear` can
 * still reset all three to their defaults, which grants nothing.
 */
const MAIN_OWNED_SETTINGS_KEYS: ReadonlySet<string> = new Set([
  CLI_SIGN_IN_MODE_KEY,
  DEFAULT_SERVER_URL_KEY,
  WSL_ENABLED_KEY,
])

/**
 * The key check for the generic `store-*` channels. An omitted name opens the
 * settings store (`getStore`'s default). electron-store reads keys as
 * dot-paths with backslash escapes, so the first segment, escapes removed, is
 * what names the setting.
 */
export function assertRendererStoreKey(name: unknown, key: unknown): asserts key is string {
  assertStoreKey(key)
  if (name !== undefined && name !== SETTINGS_STORE) return
  const setting = key.replaceAll("\\", "").split(/[.[]/, 1)[0] ?? ""
  if (MAIN_OWNED_SETTINGS_KEYS.has(setting)) throw new Error("settings store key is owned by the main process")
}

export function assertStoreValue(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length > STORE_VALUE_MAX) {
    throw new Error("invalid settings store value")
  }
}
