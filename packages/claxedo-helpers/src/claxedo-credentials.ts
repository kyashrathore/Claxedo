import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { writePrivateFileAtomic } from "./fs"
import { asFiniteNumber, asRecordOrEmpty } from "./guards"
import { trimToUndefined } from "./string"

/**
 * The credential the `claxedo` CLI signs its requests with.
 *
 * Two processes write this file — `claxedo login` and, when the user turns it
 * on, the desktop — so the shape, the path and the 0600 mode live here rather
 * than in either of them. `refreshToken` is optional on purpose: a writer that
 * only wants the CLI to work while its own session lasts omits it, and the
 * CLI then asks the user to sign in again instead of renewing silently.
 */
export type ClaxedoCredentials = {
  controlPlaneUrl?: string
  accessToken: string
  refreshToken?: string
  tokenType?: string
  expiresAt?: number
  identity?: string
}

/** `$CLAXEDO_HOME`, else `~/.claxedo`. */
export function claxedoHome(env: NodeJS.ProcessEnv = process.env) {
  return trimToUndefined(env.CLAXEDO_HOME) ?? path.join(os.homedir(), ".claxedo")
}

export function claxedoCredentialsPath(env: NodeJS.ProcessEnv = process.env) {
  return path.join(claxedoHome(env), "credentials.json")
}

/** The credential a file holds, or undefined when it holds none — including the empty object a sign-out leaves. */
export function readClaxedoCredentials(input: unknown): ClaxedoCredentials | undefined {
  const row = asRecordOrEmpty(input)
  const accessToken = trimToUndefined(row.accessToken) ?? trimToUndefined(row.access_token)
  if (!accessToken) return undefined
  const controlPlaneUrl = trimToUndefined(row.controlPlaneUrl)
  const refreshToken = trimToUndefined(row.refreshToken) ?? trimToUndefined(row.refresh_token)
  const tokenType = trimToUndefined(row.tokenType) ?? trimToUndefined(row.token_type)
  const identity = trimToUndefined(row.identity)
  const expiresAt = asFiniteNumber(row.expiresAt)
  return {
    accessToken,
    ...(controlPlaneUrl ? { controlPlaneUrl } : {}),
    ...(refreshToken ? { refreshToken } : {}),
    ...(tokenType ? { tokenType } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(identity ? { identity } : {}),
  }
}

export async function loadClaxedoCredentials(
  pathname = claxedoCredentialsPath(),
): Promise<ClaxedoCredentials | undefined> {
  try {
    return readClaxedoCredentials(JSON.parse(await fs.readFile(pathname, "utf8")))
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined
    if (error instanceof SyntaxError) return undefined
    throw error
  }
}

/**
 * Writes the file the CLI reads, readable only by its owner.
 *
 * Replacement, not truncation, is what makes that hold for a path that already
 * had a file on it: the permissions the writer established travel with the
 * staged file, so neither a mode nor a DACL left by whatever was there before
 * survives. It is also why a symlink at this path is replaced rather than
 * written through.
 */
export async function storeClaxedoCredentials(
  value: ClaxedoCredentials | Record<string, never>,
  pathname = claxedoCredentialsPath(),
) {
  await writePrivateFileAtomic(pathname, `${JSON.stringify(value, null, 2)}\n`, { mkdir: true })
}

/** Leaves the file in place holding nothing, which `readClaxedoCredentials` reads as signed out. */
export async function clearClaxedoCredentials(pathname = claxedoCredentialsPath()) {
  await storeClaxedoCredentials({}, pathname)
}
