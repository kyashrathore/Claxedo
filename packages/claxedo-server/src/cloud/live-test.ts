/**
 * Live integration test for cloud workspace runtime.
 *
 * Exercises the real code paths against a live sandbox provider:
 *   1. Acquire sandbox (dispatches to correct provider)
 *   2. Verify sandbox environment (node, git, shell)
 *   3. Clone a repo into the sandbox
 *   4. Install workspace-runtime from npm (if not in snapshot)
 *   5. Start workspace-runtime, wait for health
 *   6. Hit runtime endpoints via service URL (health, session create, session list)
 *   7. Cleanup
 *
 * Supported providers: daytona, modal, vercel, cloudflare
 *
 * Reads credentials from .env file in packages/claxedo-server/.env
 *
 * Usage:
 *   # Daytona (default)
 *   node --import tsx src/cloud/live-test.ts
 *
 *   # Modal
 *   SANDBOX_PROVIDER=modal node --import tsx src/cloud/live-test.ts
 *
 *   # Vercel (requires `vercel link` first)
 *   SANDBOX_PROVIDER=vercel node --import tsx src/cloud/live-test.ts
 *
 *   # Cloudflare
 *   SANDBOX_PROVIDER=cloudflare node --import tsx src/cloud/live-test.ts
 */

// Load .env files
import fs from "node:fs"
import path from "node:path"
function loadEnvFile(p: string) {
  if (!fs.existsSync(p)) return
  for (const line of fs.readFileSync(p, "utf-8").split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const eq = trimmed.indexOf("=")
    if (eq === -1) continue
    const key = trimmed.slice(0, eq)
    let val = trimmed.slice(eq + 1)
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (!process.env[key]) process.env[key] = val
  }
}
loadEnvFile(path.resolve(import.meta.dirname, "../../.env"))
// Vercel CLI writes OIDC token to .env.local at repo root
loadEnvFile(path.resolve(import.meta.dirname, "../../../../.env.local"))

import { Daytona, SandboxState } from "@daytonaio/sdk"
import { ensureSnapshot, RUNTIME_PORT, RUNTIME_DIR, WORKSPACE_DIR } from "./sandbox-image"
import { deployAndStart, stopRemoteRuntime } from "./sandbox-runtime"
import type { SandboxHandle } from "./sandbox-handle"
import type { SandboxProviderID } from "./types"
import { DaytonaSandboxHandle } from "./sandbox-daytona"
import { createVercelSandbox } from "./sandbox-vercel"
import { createCloudflareSandbox } from "./sandbox-cloudflare"

const PROVIDER = (process.env.SANDBOX_PROVIDER || "daytona") as SandboxProviderID
const TEST_REPO = "https://github.com/kyashrathore/formlink.git"
const TEST_WORKSPACE_ID = "ws_live_test"

let pass = 0
let fail = 0

function ok(label: string) {
  pass++
  console.log(`  \u2713 ${label}`)
}

function bad(label: string, err: unknown) {
  fail++
  console.log(`  \u2717 ${label}: ${err instanceof Error ? err.message : String(err)}`)
}

const DAYTONA_HEADER = "X-Daytona-Skip-Preview-Warning"

// ── Provider-specific sandbox creation ────────────────────────────────────

async function createDaytonaSandbox(): Promise<{ handle: SandboxHandle; cleanup: () => Promise<void> }> {
  const apiKey = process.env.DAYTONA_API_KEY
  if (!apiKey) throw new Error("DAYTONA_API_KEY is required")

  const daytona = new Daytona({ apiKey })
  const snapshotName = await ensureSnapshot(daytona)
  ok(`snapshot ready: ${snapshotName}`)

  const sandbox = await daytona.create({
    snapshot: snapshotName,
    labels: { app: "claxedo", pool: "live-test" },
    autoStopInterval: 15,
  })
  ok(`sandbox created: id=${sandbox.id}`)

  if (sandbox.state !== SandboxState.STARTED) {
    await sandbox.waitUntilStarted(120)
  }
  ok(`sandbox started: state=${sandbox.state}`)

  return {
    handle: new DaytonaSandboxHandle(sandbox),
    cleanup: async () => {
      await daytona.delete(sandbox)
    },
  }
}

async function createModalSandboxHandle(): Promise<{ handle: SandboxHandle; cleanup: () => Promise<void> }> {
  const tokenId = process.env.MODAL_TOKEN_ID
  const tokenSecret = process.env.MODAL_TOKEN_SECRET
  if (!tokenId || !tokenSecret) throw new Error("MODAL_TOKEN_ID and MODAL_TOKEN_SECRET are required")

  const { createModalSandbox } = await import("./sandbox-modal")
  const handle = await createModalSandbox({ tokenId, tokenSecret, name: `live-test-${Date.now()}` })
  ok(`sandbox created: id=${handle.id}`)

  return {
    handle,
    cleanup: async () => {
      await handle.destroy()
    },
  }
}

async function createVercelSandboxHandle(): Promise<{ handle: SandboxHandle; cleanup: () => Promise<void> }> {
  if (!process.env.VERCEL_TOKEN && !process.env.VERCEL_OIDC_TOKEN) throw new Error("VERCEL_TOKEN or VERCEL_OIDC_TOKEN is required (run `vercel link && vercel env pull`)")

  const handle = await createVercelSandbox()
  ok(`sandbox created: id=${handle.id}`)

  return {
    handle,
    cleanup: async () => {
      await handle.destroy()
    },
  }
}

async function createCloudflareSandboxHandle(): Promise<{ handle: SandboxHandle; cleanup: () => Promise<void> }> {
  const apiToken = process.env.CLOUDFLARE_API_TOKEN
  const workerUrl = process.env.CLOUDFLARE_SANDBOX_WORKER_URL
  if (!apiToken || !workerUrl) throw new Error("CLOUDFLARE_API_TOKEN and CLOUDFLARE_SANDBOX_WORKER_URL are required")

  const sandboxId = `live-test-${Date.now()}`
  const handle = await createCloudflareSandbox({ sandboxId, workerUrl, apiToken })
  ok(`sandbox handle created: id=${handle.id}`)

  // Trigger lazy start
  await handle.start()
  ok("sandbox started (lazy init)")

  return {
    handle,
    cleanup: async () => {
      await handle.destroy()
    },
  }
}

async function acquireSandbox(): Promise<{ handle: SandboxHandle; cleanup: () => Promise<void> }> {
  switch (PROVIDER) {
    case "daytona":
      return createDaytonaSandbox()
    case "modal":
      return createModalSandboxHandle()
    case "vercel":
      return createVercelSandboxHandle()
    case "cloudflare":
      return createCloudflareSandboxHandle()
    default:
      throw new Error(`Unsupported provider for live test: ${PROVIDER}`)
  }
}

// ── Main test flow ────────────────────────────────────────────────────────

async function main() {
  console.log(`\n== Live test: provider=${PROVIDER} ==`)

  // ── Step 1: Create sandbox ────────────────────────────────────────────
  console.log("\n\u2500\u2500 Step 1: Acquire sandbox \u2500\u2500")
  const { handle: sandbox, cleanup } = await acquireSandbox()

  try {
    // ── Step 2: Verify sandbox environment ──────────────────────────────
    console.log("\n\u2500\u2500 Step 2: Verify sandbox environment \u2500\u2500")
    const checks: [string, RegExp][] = [
      ["node --version", /^v2[0-9]/],
      ["git --version", /git version/],
      ["echo $SHELL", /bash|sh/],
      ["pwd", /\//],
    ]

    // Daytona has extra checks for snapshot-installed deps
    if (PROVIDER === "daytona") {
      checks.push(
        ["python3 --version", /Python 3/],
        ["g++ --version | head -1", /g\+\+/],
        ["which opencode", /opencode/],
        [`test -d ${RUNTIME_DIR}/node_modules/better-sqlite3 && echo ok`, /ok/],
        [`test -d ${RUNTIME_DIR}/node_modules/node-pty && echo ok`, /ok/],
      )
    }

    for (const [cmd, expected] of checks) {
      try {
        const r = await sandbox.executeCommand(cmd)
        const out = r.result?.trim() ?? ""
        if (expected.test(out)) {
          ok(`${cmd} \u2192 ${out}`)
        } else {
          bad(`${cmd}`, `out="${out}" did not match ${expected}`)
        }
      } catch (err) {
        bad(`${cmd}`, err)
      }
    }

    // ── Step 3: Clone repo + deploy runtime (real code path) ────────────
    console.log("\n\u2500\u2500 Step 3: Clone repo + deploy workspace-runtime \u2500\u2500")
    const t0 = Date.now()
    const { url } = await deployAndStart(sandbox, TEST_WORKSPACE_ID, {
      directory: WORKSPACE_DIR,
      repoUrl: TEST_REPO,
    })
    const deployMs = Date.now() - t0
    ok(`deployAndStart completed in ${deployMs}ms`)
    ok(`runtime URL: ${url}`)

    // ── Step 4: Hit runtime health via service URL ──────────────────────
    console.log("\n\u2500\u2500 Step 4: Runtime health via service URL \u2500\u2500")
    let healthOk = false
    for (let i = 0; i < 5; i++) {
      try {
        const healthRes = await fetch(`${url}/api/wr/health`, {
          signal: AbortSignal.timeout(10_000),
        })
        const text = await healthRes.text()
        if (healthRes.ok && text && text.includes("ok")) {
          ok(`health check: ${text.slice(0, 300)}`)
          healthOk = true
          break
        }
        if (i === 4) bad("health check", `status=${healthRes.status} body=${text.slice(0, 200)}`)
      } catch (err) {
        if (i === 4) bad("health check fetch", err)
      }
      await new Promise((r) => setTimeout(r, 2000))
    }
    if (!healthOk && false) { /* already reported via bad() */ }

    // Verify repo was cloned
    const gitCheck = await sandbox.executeCommand(
      `test -d ${WORKSPACE_DIR}/.git && echo ok || echo missing`,
    )
    if (gitCheck.result?.trim() === "ok") {
      ok("repo cloned into /workspace")
    } else {
      bad("repo clone", "no .git directory found")
    }

    // Verify workspace-runtime was installed from npm
    const runtimeCheck = await sandbox.executeCommand(
      `test -f ${RUNTIME_DIR}/node_modules/@claxedo/workspace-runtime/dist/main.mjs && echo ok || echo missing`,
    )
    if (runtimeCheck.result?.trim() === "ok") {
      ok("workspace-runtime installed from npm")
    } else {
      bad("workspace-runtime install", "bin not found")
    }

    // ── Step 5: Create + use a session via runtime ──────────────────────
    console.log("\n\u2500\u2500 Step 5: Session via workspace-runtime \u2500\u2500")
    try {
      const createRes = await fetch(`${url}/session`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [DAYTONA_HEADER]: "true",
          "x-opencode-directory": WORKSPACE_DIR,
        },
        body: JSON.stringify({
          directory: WORKSPACE_DIR,
        }),
        signal: AbortSignal.timeout(15_000),
      })
      if (createRes.ok) {
        const session = await createRes.json()
        ok(`session created: id=${session.id ?? session.sessionID ?? JSON.stringify(session).slice(0, 100)}`)

        // List sessions
        const listRes = await fetch(`${url}/session?directory=${encodeURIComponent(WORKSPACE_DIR)}&roots=true`, {
          headers: { [DAYTONA_HEADER]: "true" },
          signal: AbortSignal.timeout(10_000),
        })
        if (listRes.ok) {
          const sessions = await listRes.json()
          const count = Array.isArray(sessions) ? sessions.length : Object.keys(sessions).length
          ok(`session list: ${count} session(s) \u2014 ${JSON.stringify(sessions).slice(0, 200)}`)
        } else {
          bad("session list", `status=${listRes.status} ${await listRes.text().catch(() => "")}`)
        }
      } else {
        const errText = await createRes.text().catch(() => "")
        bad("session create", `status=${createRes.status} ${errText.slice(0, 200)}`)
      }
    } catch (err) {
      bad("session endpoints", err)
    }

    // ── Step 6: Stop runtime ────────────────────────────────────────────
    console.log("\n\u2500\u2500 Step 6: Cleanup \u2500\u2500")
    await stopRemoteRuntime(sandbox, TEST_WORKSPACE_ID)
    ok("runtime stopped")

  } finally {
    // Always clean up the sandbox
    await cleanup()
    ok("sandbox deleted")
  }

  // ── Summary ────────────────────────────────────────────────────────────
  console.log(`\n\u2500\u2500 Results: ${pass} passed, ${fail} failed (provider: ${PROVIDER}) \u2500\u2500`)
  if (fail > 0) process.exit(1)
}

main().catch((err) => {
  console.error("\nFATAL:", err)
  process.exit(1)
})
