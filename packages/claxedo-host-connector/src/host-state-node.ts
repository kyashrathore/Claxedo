import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"

import type { HostStateFs } from "./host-state"

function isMissing(error: unknown) {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT"
}

const REPLACE_TIMEOUT_MS = 2_000
const REPLACE_POLL_MS = 25
const SHARING_VIOLATION = new Set(["EPERM", "EACCES", "EBUSY"])

/**
 * On Windows the rename fails with EPERM while a reader has the target open,
 * under Node and Bun readers alike; a status read holds the state file for one
 * read, so a bounded wait turns the collision into a pause. Past the wait the
 * error is the store's, which removes its staging file.
 */
async function renameReplacing(temp: string, file: string): Promise<void> {
  const deadline = Date.now() + REPLACE_TIMEOUT_MS
  for (;;) {
    try {
      return await rename(temp, file)
    } catch (error) {
      const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined
      if (typeof code !== "string" || !SHARING_VIOLATION.has(code) || Date.now() >= deadline) throw error
      await new Promise((resolve) => setTimeout(resolve, REPLACE_POLL_MS))
    }
  }
}

/**
 * The one `node:fs` adapter for `createHostStateStore`, on its own export so
 * the desktop's Host Connector child — which must stay Web-Crypto-only — never
 * pulls it in by importing `./host-state`.
 */
export function nodeHostStateFs(): HostStateFs {
  return {
    readFile: async (path) => {
      try {
        return await readFile(path, "utf8")
      } catch (error) {
        if (isMissing(error)) return null
        throw error
      }
    },
    writeFile: async (path, text, options) => {
      await writeFile(path, text, { encoding: "utf8", mode: options.mode, flag: "wx" })
    },
    rename: renameReplacing,
    mkdir: async (path, options) => {
      await mkdir(path, options)
    },
    unlink: async (path) => {
      try {
        await unlink(path)
      } catch (error) {
        if (!isMissing(error)) throw error
      }
    },
  }
}
