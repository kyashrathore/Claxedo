import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { buildSafeEnv, isSecretShapedEnvName, prefixedEnvAllowed } from "./env"

// Everything buildSafeEnv returns is handed to an agent-driven child process
// (PTY, /exec, managed processes), and in embedded mode the workspace runtime
// shares a process with the control plane — so `process.env` there carries the
// control plane's own secrets. A prompt-injected agent running `env` is the
// threat model, not a hypothetical one.
//
// The repo-scanning test below is the point of this file: it re-derives the
// secret set from source on every run, so adding a new CLAXEDO_*_TOKEN
// somewhere fails HERE rather than silently becoming readable by agents. That
// is the property a hand-maintained deny list cannot have.

const repoRoot = path.resolve(import.meta.dirname, "../../../..")
const SECRET_SUFFIXED = /\b(?:CLAXEDO|OPENCODE)_[A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|CREDENTIALS?|PEM)\b/g

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
  for (const dir of ["packages"]) {
    const root = path.join(repoRoot, dir)
    if (!fs.existsSync(root)) continue
    for (const file of sourceFiles(root)) {
      for (const match of fs.readFileSync(file, "utf8").matchAll(SECRET_SUFFIXED)) names.add(match[0])
    }
  }
  return [...names].sort()
}

describe("agent-facing env never carries prefixed secrets", () => {
  test("every secret-suffixed CLAXEDO_/OPENCODE_ name in the repo is unreachable", () => {
    const names = secretNamesInRepo()
    // Sanity: if the scan finds nothing the assertion below is vacuous.
    expect(names.length).toBeGreaterThan(20)

    const env = Object.fromEntries(names.map((name) => [name, "leaked-value"]))
    const safe = buildSafeEnv(env, { platform: "linux", customPrefix: "CLAXEDO" })
    expect(Object.keys(safe)).toEqual([])
  })

  test("the specific keys-to-the-kingdom names are denied", () => {
    // Called out individually so a regression names the actual consequence.
    for (const name of [
      "CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM", // mints Runtime Access Tokens
      "CLAXEDO_CLI_TOKEN_PRIVATE_KEY_PEM",
      "CLAXEDO_RELAY_HOST_SIGNING_KEY_PEM", // mints Relay Host Tokens
      "CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN", // control-plane machine principal
      "CLAXEDO_CREDENTIALS_TOKEN",
      "CLAXEDO_RELAY_RESOLVER_TOKEN",
      "CLAXEDO_EMBEDDED_AUTH_SECRET",
      "CLAXEDO_POLAR_WEBHOOK_SECRET",
      "CLAXEDO_LOCAL_DOCUMENT_BROKER_TOKEN",
      "OPENCODE_API_KEY",
      "OPENCODE_CONSOLE_TOKEN",
      "OPENCODE_SERVER_PASSWORD",
      "OPENCODE_AUTH_CONTENT",
    ]) {
      expect(prefixedEnvAllowed(name), `${name} must not reach an agent-driven child`).toBe(false)
    }
  })

  test("a newly invented CLAXEDO_ secret is denied without any code change", () => {
    // The deny-by-default property: nobody has to remember to add this.
    expect(prefixedEnvAllowed("CLAXEDO_SOME_FUTURE_TOKEN")).toBe(false)
    expect(prefixedEnvAllowed("CLAXEDO_TOTALLY_NEW_VAR")).toBe(false)
  })

  test("CLAXEDO_ACCESS_TOKEN / CLAXEDO_DEV_TOKEN stay out despite the CLI reading them", () => {
    // Deliberate: the CLI treats these as an override over stored credentials in
    // ~/.claxedo, which a PTY can still reach via HOME. A user who wants the
    // override exports it from their own shell rc; the box's ambient token must
    // not be ambient to the agent.
    expect(prefixedEnvAllowed("CLAXEDO_ACCESS_TOKEN")).toBe(false)
    expect(prefixedEnvAllowed("CLAXEDO_DEV_TOKEN")).toBe(false)
  })
})

describe("agent-facing env keeps what children actually need", () => {
  test("operational CLAXEDO_ vars still pass", () => {
    const env = {
      CLAXEDO_SERVER_URL: "http://127.0.0.1:3001",
      CLAXEDO_WORKSPACE_ID: "ws_1",
      CLAXEDO_SESSION_ID: "ses_1",
      CLAXEDO_MCP_READ_ONLY: "1",
      CLAXEDO_DESKTOP_URL: "http://127.0.0.1:51234",
    }
    expect(buildSafeEnv(env, { platform: "linux", customPrefix: "CLAXEDO" })).toEqual(env)
  })

  test("OPENCODE_ engine feature flags still pass", () => {
    // ~80 of these exist; deny-by-default here would break the engine, which is
    // why only OPENCODE_ keeps prefix passthrough.
    const env = {
      OPENCODE_EXPERIMENTAL_PLAN_MODE: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_LOG_LEVEL: "debug",
      OPENCODE_CONFIG_DIR: "/tmp/cfg",
    }
    expect(buildSafeEnv(env, { platform: "linux", customPrefix: "CLAXEDO" })).toEqual(env)
  })

  test("shell essentials are unaffected", () => {
    const env = { PATH: "/usr/bin", HOME: "/home/u", TERM: "xterm-256color" }
    expect(buildSafeEnv(env, { platform: "linux" })).toEqual(env)
  })

  test("denial is case-insensitive on Windows", () => {
    const safe = buildSafeEnv(
      { claxedo_control_plane_service_token: "leaked", CLAXEDO_SERVER_URL: "http://x" },
      { platform: "win32", customPrefix: "CLAXEDO" },
    )
    expect(safe).toEqual({ CLAXEDO_SERVER_URL: "http://x" })
  })
})

describe("ambient vs explicit env", () => {
  const secret = { CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN: "leaked" }

  test("ambient is the default, so a forgotten option fails closed", () => {
    expect(buildSafeEnv(secret, { platform: "linux", customPrefix: "CLAXEDO" })).toEqual({})
    expect(buildSafeEnv(secret, { platform: "linux", customPrefix: "CLAXEDO", source: "ambient" })).toEqual({})
  })

  test("explicit env passes through", () => {
    // Whoever wrote the value already has it, so echoing it back teaches them
    // nothing — and filtering here would break operator-configured process env.
    expect(buildSafeEnv(secret, { platform: "linux", customPrefix: "CLAXEDO", source: "explicit" })).toEqual(secret)
  })

  test("explicit env is still subject to the hard deny list", () => {
    const safe = buildSafeEnv(
      { NODE_OPTIONS: "--require /evil", CLAXEDO_ALLOWED: "yes" },
      { platform: "linux", customPrefix: "CLAXEDO", source: "explicit" },
    )
    expect(safe).toEqual({ CLAXEDO_ALLOWED: "yes" })
  })
})

describe("isSecretShapedEnvName", () => {
  test("matches the suffixes that name a secret", () => {
    for (const name of ["X_TOKEN", "X_SECRET", "X_KEY", "X_PASSWORD", "X_CREDENTIAL", "X_CREDENTIALS", "X_PEM"]) {
      expect(isSecretShapedEnvName(name)).toBe(true)
    }
  })

  test("does not match ordinary config names", () => {
    // MONKEY/TURNKEY are the reason the suffix is anchored on "_": an unanchored
    // /KEY$/ denies them, which is how this test caught the first draft.
    for (const name of ["CLAXEDO_SERVER_URL", "OPENCODE_LOG_LEVEL", "X_MONKEY", "CLAXEDO_TURNKEY"]) {
      expect(isSecretShapedEnvName(name)).toBe(false)
    }
  })
})
