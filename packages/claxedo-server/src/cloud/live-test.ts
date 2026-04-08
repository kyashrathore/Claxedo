/**
 * Live integration test for cloud workspace runtime in Daytona.
 *
 * Exercises the real code paths:
 *   1. ensureSnapshot (buildSandboxImage)
 *   2. Create sandbox from snapshot (same as pool.acquire)
 *   3. Verify image environment (node, git, python3, g++, opencode, native deps)
 *   4. Clone a repo into the sandbox
 *   5. Upload runtime.mjs (~1MB JS bundle)
 *   6. Start workspace-runtime, wait for health
 *   7. Hit runtime endpoints via preview URL (health, session create, session list)
 *   8. Cleanup
 *
 * Usage: bun run packages/claxedo-server/src/cloud/live-test.ts
 */

import { Daytona, SandboxState } from "@daytonaio/sdk"
import { ensureSnapshot, RUNTIME_PORT, RUNTIME_DIR, WORKSPACE_DIR } from "./sandbox-image"
import { deployAndStart, stopRemoteRuntime } from "./sandbox-runtime"

const API_KEY = "dtn_1c1f5796af2f67edd32107a58cfbe94f532a4d7db9d2627f80402dd9d2a18f3b"
const TEST_REPO = "https://github.com/kyashrathore/formlink.git"
const TEST_WORKSPACE_ID = "ws_live_test"

let pass = 0
let fail = 0

function ok(label: string) {
  pass++
  console.log(`  ✓ ${label}`)
}

function bad(label: string, err: unknown) {
  fail++
  console.log(`  ✗ ${label}: ${err instanceof Error ? err.message : String(err)}`)
}

const DAYTONA_HEADER = "X-Daytona-Skip-Preview-Warning"

async function main() {
  const daytona = new Daytona({ apiKey: API_KEY })

  // ── Step 1: Snapshot ──────────────────────────────────────────────────
  console.log("\n── Step 1: ensureSnapshot ──")
  const snapshotName = await ensureSnapshot(daytona)
  ok(`snapshot ready: ${snapshotName}`)

  // ── Step 2: Create sandbox from snapshot ──────────────────────────────
  console.log("\n── Step 2: Create sandbox from snapshot ──")
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

  try {
    // ── Step 3: Verify image environment ──────────────────────────────────
    console.log("\n── Step 3: Verify sandbox environment ──")
    const checks: [string, RegExp][] = [
      ["node --version", /^v22/],
      ["git --version", /git version/],
      ["python3 --version", /Python 3/],
      ["g++ --version | head -1", /g\+\+/],
      ["which opencode", /opencode/],
      ["echo $SHELL", /bash/],
      ["pwd", /\/workspace/],
      // Verify native deps are pre-installed in snapshot
      [`test -d ${RUNTIME_DIR}/node_modules/better-sqlite3 && echo ok`, /ok/],
      [`test -d ${RUNTIME_DIR}/node_modules/node-pty && echo ok`, /ok/],
    ]
    for (const [cmd, expected] of checks) {
      const r = await sandbox.process.executeCommand(cmd)
      const out = r.result?.trim() ?? ""
      if (r.exitCode === 0 && expected.test(out)) {
        ok(`${cmd} → ${out}`)
      } else {
        bad(`${cmd}`, `exit=${r.exitCode} out="${out}"`)
      }
    }

    // ── Step 4: Clone repo + deploy runtime (real code path) ────────────
    console.log("\n── Step 4: Clone repo + deploy workspace-runtime ──")
    const t0 = Date.now()
    const { url } = await deployAndStart(sandbox, TEST_WORKSPACE_ID, {
      directory: WORKSPACE_DIR,
      repoUrl: TEST_REPO,
    })
    const deployMs = Date.now() - t0
    ok(`deployAndStart completed in ${deployMs}ms`)
    ok(`runtime URL: ${url}`)

    // Verify repo was cloned
    const gitCheck = await sandbox.process.executeCommand(
      `test -d ${WORKSPACE_DIR}/.git && echo ok || echo missing`,
    )
    if (gitCheck.result?.trim() === "ok") {
      ok("repo cloned into /workspace")
    } else {
      bad("repo clone", "no .git directory found")
    }

    // Verify runtime.mjs was uploaded
    const runtimeCheck = await sandbox.process.executeCommand(
      `test -f ${RUNTIME_DIR}/runtime.mjs && echo ok || echo missing`,
    )
    if (runtimeCheck.result?.trim() === "ok") {
      ok("runtime.mjs uploaded")
    } else {
      bad("runtime.mjs upload", "file not found")
    }

    // ── Step 5: Hit runtime health via preview URL ──────────────────────
    console.log("\n── Step 5: Runtime health via preview URL ──")
    try {
      const healthRes = await fetch(`${url}/api/wr/health`, {
        signal: AbortSignal.timeout(10_000),
        headers: { [DAYTONA_HEADER]: "true" },
      })
      if (healthRes.ok) {
        const body = await healthRes.json()
        ok(`health check: ${JSON.stringify(body)}`)
      } else {
        bad("health check", `status=${healthRes.status}`)
      }
    } catch (err) {
      bad("health check fetch", err)
    }

    // ── Step 6: Create + use a session via runtime ──────────────────────
    console.log("\n── Step 6: Session via workspace-runtime ──")

    // Create a session
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
          ok(`session list: ${count} session(s) — ${JSON.stringify(sessions).slice(0, 200)}`)
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

    // ── Step 7: Stop runtime + cleanup ──────────────────────────────────
    console.log("\n── Step 7: Cleanup ──")
    await stopRemoteRuntime(sandbox, TEST_WORKSPACE_ID)
    ok("runtime stopped")

  } finally {
    // Always delete sandbox
    await daytona.delete(sandbox)
    ok("sandbox deleted")
  }

  // ── Summary ────────────────────────────────────────────────────────────
  console.log(`\n── Results: ${pass} passed, ${fail} failed ──`)
  if (fail > 0) process.exit(1)
}

main().catch((err) => {
  console.error("\nFATAL:", err)
  process.exit(1)
})
