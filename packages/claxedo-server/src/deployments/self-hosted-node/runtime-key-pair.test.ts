import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, expect, test } from "vitest"
import { ensureSelfHostedRuntimeKeyPair } from "./start"

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

test("first start creates private signing files and restart reuses the pair", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "selfhost-runtime-key-"))
  directories.push(directory)
  const env: NodeJS.ProcessEnv = { CLAXEDO_DATA_DIR: directory }
  ensureSelfHostedRuntimeKeyPair(env)
  const first = {
    privatePem: env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM,
    publicPem: env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM,
  }
  const state = path.join(directory, "state")
  const files = readdirSync(state)
  expect(files).toHaveLength(2)
  for (const file of files) {
    expect(statSync(path.join(state, file)).mode & 0o077).toBe(0)
    expect(readFileSync(path.join(state, file), "utf8")).toContain("-----BEGIN")
  }
  const restarted: NodeJS.ProcessEnv = { CLAXEDO_DATA_DIR: directory }
  ensureSelfHostedRuntimeKeyPair(restarted)
  expect(restarted.CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM).toBe(first.privatePem)
  expect(restarted.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM).toBe(first.publicPem)
})

test("an incomplete pair refuses startup", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "selfhost-runtime-key-"))
  directories.push(directory)
  const env: NodeJS.ProcessEnv = { CLAXEDO_DATA_DIR: directory }
  ensureSelfHostedRuntimeKeyPair(env)
  unlinkSync(path.join(directory, "state", "runtime-access-token-public.pem"))
  expect(() => ensureSelfHostedRuntimeKeyPair({ CLAXEDO_DATA_DIR: directory })).toThrow("incomplete")
})

test("an in-memory database cannot become the key directory", () => {
  expect(() => ensureSelfHostedRuntimeKeyPair({ CLAXEDO_DATA_DIR: ":memory:" })).toThrow("persistent state directory")
})
