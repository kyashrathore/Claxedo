import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { harnessEnvAllowed, harnessSpawnEnv } from "./spawn-env"

// Every harness child (claude, codex, acp, pi, cursor) is spawned with env
// derived from process.env, and in embedded mode that env IS the control
// plane's env — a prompt-injected agent running `env` is the threat model,
// not a hypothetical one.
//
// The repo-scanning test below is the point of this file: it re-derives the
// secret set from source on every run, so adding a new CLAXEDO_*_TOKEN or
// WORKSPACE_RUNTIME_*_TOKEN somewhere fails HERE rather than silently
// becoming readable by agents.

const repoRoot = path.resolve(import.meta.dirname, "../../../../..")
const SECRET_SUFFIXED = /\b(?:CLAXEDO|WORKSPACE_RUNTIME)_[A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|CREDENTIALS?|PEM)\b/g

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) sourceFiles(full, out)
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) out.push(full)
  }
  return out
}

function secretNamesInRepo(): string[] {
  const names = new Set<string>()
  const root = path.join(repoRoot, "packages")
  if (!fs.existsSync(root)) return []
  for (const file of sourceFiles(root)) {
    for (const match of fs.readFileSync(file, "utf8").matchAll(SECRET_SUFFIXED)) names.add(match[0])
  }
  return [...names].sort()
}

describe("harness spawn env never carries internal secrets", () => {
  test("every secret-suffixed CLAXEDO_/WORKSPACE_RUNTIME_ name in the repo is unreachable", () => {
    const names = secretNamesInRepo()
    // Sanity: if the scan finds nothing the assertion below is vacuous.
    expect(names.length).toBeGreaterThan(20)

    const env = Object.fromEntries(names.map((name) => [name, "leaked-value"]))
    expect(Object.keys(harnessSpawnEnv(env))).toEqual([])
  })

  test("the specific keys-to-the-kingdom names are denied", () => {
    // Called out individually so a regression names the actual consequence.
    for (const name of [
      "WORKSPACE_RUNTIME_TRUSTED_DIRECT_TOKEN", // full runtime access on every route
      "WORKSPACE_RUNTIME_CONFIG_TOKEN",
      "CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM", // mints Runtime Access Tokens
      "CLAXEDO_CLI_TOKEN_PRIVATE_KEY_PEM",
      "CLAXEDO_RELAY_HOST_SIGNING_KEY_PEM", // mints Relay Host Tokens
      "CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN", // control-plane machine principal
      "CLAXEDO_CREDENTIALS_TOKEN",
      "CLAXEDO_RELAY_RESOLVER_TOKEN",
      "CLAXEDO_EMBEDDED_AUTH_SECRET",
      "CLAXEDO_POLAR_WEBHOOK_SECRET",
      "CLAXEDO_LOCAL_DOCUMENT_BROKER_TOKEN",
      "CLAXEDO_ACCESS_TOKEN",
      "CLAXEDO_DEV_TOKEN",
      "CLAXEDO_CONTROL_PLANE_URL", // child has no need to name the control plane
      "CLAXEDO_CONTROL_PLANE_JWKS_URL",
    ]) {
      expect(harnessEnvAllowed(name), `${name} must not reach a harness child`).toBe(false)
    }
  })

  test("a newly invented internal secret is denied without any code change", () => {
    expect(harnessEnvAllowed("CLAXEDO_SOME_FUTURE_TOKEN")).toBe(false)
    expect(harnessEnvAllowed("CLAXEDO_TOTALLY_NEW_VAR")).toBe(false)
    expect(harnessEnvAllowed("WORKSPACE_RUNTIME_NEW_TOKEN")).toBe(false)
  })

  test("deliberately agent-scoped grants still pass", () => {
    const env = {
      WORKSPACE_RUNTIME_OWNER_GRANT: "grant",
      WORKSPACE_RUNTIME_TASKS_CAPABILITY: "cap",
      CLAXEDO_SERVER_URL: "http://127.0.0.1:3001",
      CLAXEDO_WORKSPACE_ID: "ws_1",
      CLAXEDO_SESSION_ID: "ses_1",
    }
    expect(harnessSpawnEnv(env)).toEqual(env)
  })

  test("non-internal names are untouched, including provider keys", () => {
    // Provider credentials are injected deliberately by auth materialization;
    // filtering them here is the harness's own provider withholding, not ours.
    const env = { PATH: "/usr/bin", ANTHROPIC_API_KEY: "provider-injected", FOO_SECRET: "operator-env" }
    expect(harnessSpawnEnv(env)).toEqual(env)
  })

  test("denial is case-insensitive", () => {
    const safe = harnessSpawnEnv({ claxedo_control_plane_service_token: "leaked", CLAXEDO_SERVER_URL: "http://x" })
    expect(safe).toEqual({ CLAXEDO_SERVER_URL: "http://x" })
  })

  test("undefined values are dropped", () => {
    expect(harnessSpawnEnv({ KEEP: "v", DROP: undefined })).toEqual({ KEEP: "v" })
  })
})
