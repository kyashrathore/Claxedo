import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  claxedoCredentialsPath,
  clearClaxedoCredentials,
  loadClaxedoCredentials,
  readClaxedoCredentials,
  storeClaxedoCredentials,
} from "./claxedo-credentials"
import { expectedOwnerOnlyDescription, ownerOnlyDescription, widenWindowsPath } from "./private-file.test-support"

const dirs: string[] = []

async function tempFile() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-credentials-"))
  dirs.push(dir)
  return path.join(dir, "state", "credentials.json")
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true })
})

describe("the credential file both the CLI and the desktop write", () => {
  test("is created readable only by its owner", async () => {
    const pathname = await tempFile()

    await storeClaxedoCredentials({ controlPlaneUrl: "https://api.test", accessToken: "token-1" }, pathname)

    expect(ownerOnlyDescription(pathname)).toBe(expectedOwnerOnlyDescription())
    // The file carries the protection on both platforms. Only POSIX also gets
    // it on the directory, because Windows directory permissions belong to
    // whoever owns that part of the filesystem, not to this writer.
    if (process.platform !== "win32") {
      expect((await fs.stat(path.dirname(pathname))).mode & 0o777).toBe(0o700)
    }
  })

  test("narrows a file that already existed and was readable by anyone", async () => {
    const pathname = await tempFile()
    await fs.mkdir(path.dirname(pathname), { recursive: true })
    await fs.writeFile(pathname, "{}", { mode: 0o644 })
    if (process.platform === "win32") widenWindowsPath(pathname)

    await storeClaxedoCredentials({ accessToken: "token-1" }, pathname)

    expect(ownerOnlyDescription(pathname)).toBe(expectedOwnerOnlyDescription())
  })

  test("round-trips what a writer stored, refresh token and all", async () => {
    const pathname = await tempFile()
    const stored = {
      controlPlaneUrl: "https://api.test",
      accessToken: "token-1",
      refreshToken: "refresh-1",
      tokenType: "Bearer",
      expiresAt: 1_800_000_000_000,
      identity: "device-code",
    }

    await storeClaxedoCredentials(stored, pathname)

    await expect(loadClaxedoCredentials(pathname)).resolves.toEqual(stored)
  })

  test("a credential written without a refresh token carries none", async () => {
    const pathname = await tempFile()

    await storeClaxedoCredentials({ controlPlaneUrl: "https://api.test", accessToken: "token-1" }, pathname)

    const loaded = await loadClaxedoCredentials(pathname)
    expect(loaded).toEqual({ controlPlaneUrl: "https://api.test", accessToken: "token-1" })
    expect(loaded && "refreshToken" in loaded).toBe(false)
  })

  test("reads a signed-out, absent or unparseable file as no credential", async () => {
    const pathname = await tempFile()

    await expect(loadClaxedoCredentials(pathname)).resolves.toBeUndefined()

    await clearClaxedoCredentials(pathname)
    await expect(loadClaxedoCredentials(pathname)).resolves.toBeUndefined()

    await fs.writeFile(pathname, "{not json")
    await expect(loadClaxedoCredentials(pathname)).resolves.toBeUndefined()
  })

  test("accepts the snake_case spelling a token endpoint answers with", () => {
    expect(readClaxedoCredentials({ access_token: "token-1", refresh_token: "refresh-1", token_type: "Bearer" }))
      .toEqual({ accessToken: "token-1", refreshToken: "refresh-1", tokenType: "Bearer" })
  })

  test("resolves the path from CLAXEDO_HOME, else the user's home", () => {
    expect(claxedoCredentialsPath({ CLAXEDO_HOME: "/tmp/claxedo-home" } as NodeJS.ProcessEnv))
      .toBe(path.join("/tmp/claxedo-home", "credentials.json"))
    expect(claxedoCredentialsPath({} as NodeJS.ProcessEnv))
      .toBe(path.join(os.homedir(), ".claxedo", "credentials.json"))
  })
})
