import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"

import type { HostStateFs } from "./host-state"

function isMissing(error: unknown) {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT"
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
    rename: async (from, to) => {
      await rename(from, to)
    },
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
