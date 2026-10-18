import { realpath, stat } from "node:fs/promises"
import path from "node:path"

import { claxedoCredentialsPath } from "@claxedo/helpers/claxedo-credentials"
import { inside } from "@claxedo/helpers/path"
import { readFileContent } from "@claxedo/workspace-runtime/file-content"
import { openInPathVerdict } from "./open-in-guard"

/**
 * What the transcript's file preview must never return, however the path is
 * spelled: the `claxedo` CLI's credential file, which can hold a refresh
 * token, with the staging files its atomic writer leaves beside it, and
 * Electron's userData directory, which holds the desktop's own credential
 * record and settings.
 */
export type PrivateLocations = {
  credentialsFile: string
  directories: readonly string[]
}

export function desktopPrivateLocations(userDataDir: string, env: NodeJS.ProcessEnv = process.env): PrivateLocations {
  return { credentialsFile: claxedoCredentialsPath(env), directories: [userDataDir] }
}

export async function readLocalFileContent(
  target: string,
  privateLocations: PrivateLocations,
  platform: NodeJS.Platform = process.platform,
) {
  const verdict = openInPathVerdict(target, platform)
  if (!verdict.allowed) throw new Error(verdict.reason)
  // The resolved path is both what is checked and what is read, so a symlink
  // (or a symlinked parent) cannot name a public path and read a private one.
  const resolved = await resolvedLocation(target)
  if (await isPrivate(resolved, privateLocations, platform)) throw new Error("path is private to the desktop")
  return readFileContent(resolved)
}

async function isPrivate(resolved: string, locations: PrivateLocations, platform: NodeJS.Platform) {
  // The default filesystems on Windows and macOS are case-insensitive, so two
  // spellings that differ only in case name the same file there.
  const sameCase = platform === "win32" || platform === "darwin" ? (value: string) => value.toLowerCase() : (value: string) => value
  const candidate = sameCase(resolved)
  const directories = await Promise.all(locations.directories.map(resolvedLocation))
  if (directories.some((directory) => inside(sameCase(directory), candidate))) return true

  const credentials = await resolvedLocation(locations.credentialsFile)
  if (candidate === sameCase(credentials)) return true
  const name = sameCase(path.basename(locations.credentialsFile))
  const credentialsDirectory = sameCase(await resolvedLocation(path.dirname(locations.credentialsFile)))
  if (path.dirname(candidate) === credentialsDirectory) {
    const base = path.basename(candidate)
    if (base === name || base.startsWith(`.${name}.`)) return true
  }
  // A hard link shares no path with the file it names.
  const [read, held] = await Promise.all([stat(resolved).catch(() => undefined), stat(credentials).catch(() => undefined)])
  return read !== undefined && held !== undefined && read.dev === held.dev && read.ino === held.ino && read.ino !== 0
}

async function resolvedLocation(location: string) {
  return realpath(location).catch(() => path.resolve(location))
}
