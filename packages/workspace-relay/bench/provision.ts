#!/usr/bin/env bun
// Target provisioning for the Cloudflare-relay re-evaluation bench: spin up (and
// tear down) one Daytona sandbox and/or one Cloudflare sandbox to serve as the
// real upstream runtime the relay bridges to. Uses the product's own
// @claxedo/sandbox-manager drivers — the same code that provisions production
// sandboxes — so the bench target is a real runtime, not a bench mock.
//
// Credentials (never printed):
//   Daytona    — DAYTONA_API_KEY (Phase 1 verified it in
//                packages/claxedo-server/.env, as a Fly secret on
//                claxedo-selfhost-test, and in the local managed encrypted
//                store). The production resolution path is
//                packages/claxedo-server/src/sandbox-manager-adapters/driver-auth.ts
//                `sandboxDriverAuthManaged("daytona")`; the bench reads the same
//                key from the environment (export it, or `source
//                packages/claxedo-server/.env`, before running).
//                Optional: DAYTONA_API_URL, DAYTONA_ORGANIZATION_ID, DAYTONA_TARGET.
//   Cloudflare — CLAXEDO_SANDBOX_CLOUDFLARE_WORKER_URL + _API_TOKEN, produced by
//                deploying scripts/sandbox/cloudflare-worker (Phase 2.3 / the
//                deploy-cloudflare-sandbox-worker.yml job). Row 6 only.
//
// Snapshot (Daytona): CLAXEDO_DAYTONA_SNAPSHOT → CLAXEDO_SNAPSHOT_NAME → the
// fresh CI snapshot below → ensureSnapshot() (offline fallback, builds one).
//
//   bun bench/provision.ts --provider daytona --action create --workspace ws_reeval_1
//   bun bench/provision.ts --provider daytona --action destroy --workspace ws_reeval_1 --sandbox-id <id>
//   bun bench/provision.ts --provider cloudflare --action create --workspace ws_reeval_cf
//
// Records the sandbox id + endpoint + region to stderr and to
// bench/reports/provision-<provider>-<stamp>.json so teardown and the report
// can reference exact endpoints.

import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { createDaytonaSandboxDriver } from "@claxedo/sandbox-manager/drivers/daytona"
import { createCloudflareSandboxDriver } from "@claxedo/sandbox-manager/drivers/cloudflare"
import type { SandboxDriver, SandboxDriverEnsureInput, SandboxTarget } from "@claxedo/sandbox-manager"

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const REPORTS_DIR = join(PACKAGE_ROOT, "bench/reports")

// The fresh CI-built snapshot from the pipeline-verification run recorded in the
// plan (claxedo-sandbox-image run 29598415015). Override with
// CLAXEDO_DAYTONA_SNAPSHOT once 0.5.2 publishes and a newer image is built.
const FRESH_CI_SNAPSHOT = "claxedo-workspace-runtime-0-5-1-ae435f536c-v8"

function clean(input: string | undefined) {
  const value = input?.trim()
  return value ? value : undefined
}

function requireEnv(name: string): string {
  const value = clean(process.env[name])
  if (!value) {
    console.error(`[provision] missing required env: ${name}`)
    process.exit(2)
  }
  return value
}

function stringArg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]
  return fallback
}

function resolveDaytonaSnapshot(): string {
  const explicit = clean(process.env.CLAXEDO_DAYTONA_SNAPSHOT) ?? clean(process.env.CLAXEDO_SNAPSHOT_NAME)
  if (explicit) return explicit
  // The recorded fresh CI snapshot is the default. The offline fallback —
  // @claxedo/sandbox-manager/image `ensureSnapshot(daytona)` — BUILDS a snapshot
  // and needs a live Daytona client plus Docker/push rights, so it is a manual
  // step (rebuild via the claxedo-sandbox-image workflow after 0.5.2 publishes,
  // then set CLAXEDO_DAYTONA_SNAPSHOT), not an automatic path here.
  if (FRESH_CI_SNAPSHOT) return FRESH_CI_SNAPSHOT
  console.error(
    "[provision] no snapshot: set CLAXEDO_DAYTONA_SNAPSHOT (or rebuild via the claxedo-sandbox-image CI workflow / ensureSnapshot)",
  )
  process.exit(2)
}

function daytonaDriver(baseSnapshot: string): SandboxDriver {
  return createDaytonaSandboxDriver({
    apiKey: requireEnv("DAYTONA_API_KEY"),
    ...(clean(process.env.DAYTONA_API_URL) ? { apiUrl: clean(process.env.DAYTONA_API_URL) } : {}),
    ...(clean(process.env.DAYTONA_ORGANIZATION_ID) ? { organizationId: clean(process.env.DAYTONA_ORGANIZATION_ID) } : {}),
    ...(clean(process.env.DAYTONA_TARGET) ? { target: clean(process.env.DAYTONA_TARGET) } : {}),
    baseSnapshot,
    // Keep the bench sandbox short-lived so a crashed run cannot leak a
    // long-running sandbox: auto-stop after 30m idle, auto-delete after 60m.
    autoStopMinutes: 30,
    autoDeleteMinutes: 60,
  })
}

function cloudflareDriver(): SandboxDriver {
  return createCloudflareSandboxDriver({
    workerUrl: requireEnv("CLAXEDO_SANDBOX_CLOUDFLARE_WORKER_URL"),
    apiToken: requireEnv("CLAXEDO_SANDBOX_CLOUDFLARE_API_TOKEN"),
  })
}

function ensureInput(workspaceId: string, snapshot?: string): SandboxDriverEnsureInput {
  return {
    workspaceId,
    homeRegion: clean(process.env.DAYTONA_TARGET) ?? "us",
    epoch: Date.now(),
    labels: { "claxedo.bench": "cf-relay-reeval" },
    ...(snapshot ? { snapshot } : {}),
  }
}

async function provision(driver: SandboxDriver, input: SandboxDriverEnsureInput): Promise<SandboxTarget> {
  const deadline = Date.now() + 5 * 60_000
  for (;;) {
    const result = await driver.ensureHost(input)
    if ("url" in result) return result
    if (Date.now() > deadline) throw new Error("sandbox did not become ready within 5 minutes")
    console.error(`[provision] provisioning… retry in ${result.retryAfterMs}ms`)
    await Bun.sleep(result.retryAfterMs)
  }
}

async function writeArtifact(provider: string, payload: Record<string, unknown>) {
  await mkdir(REPORTS_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const path = join(REPORTS_DIR, `provision-${provider}-${stamp}.json`)
  await writeFile(path, JSON.stringify(payload, null, 2))
  console.error(`[provision] wrote ${path}`)
  return path
}

async function main() {
  const provider = stringArg("provider", "daytona")!
  const action = stringArg("action", "create")!
  const workspaceId = stringArg("workspace", `ws_reeval_${Date.now()}`)!

  if (provider !== "daytona" && provider !== "cloudflare") {
    console.error(`[provision] unknown --provider ${provider} (daytona|cloudflare)`)
    process.exit(2)
  }

  if (action === "create") {
    if (provider === "daytona") {
      const snapshot = resolveDaytonaSnapshot()
      console.error(`[provision] daytona snapshot=${snapshot} workspace=${workspaceId}`)
      const driver = daytonaDriver(snapshot)
      const target = await provision(driver, ensureInput(workspaceId, snapshot))
      const wsUrl = target.url.replace(/^http/, "ws")
      console.error(`[provision] READY daytona sandbox=${target.sandboxId} url=${target.url} ws=${wsUrl}`)
      await writeArtifact("daytona", { provider, action, workspaceId, snapshot, target, wsUrl })
      return
    }
    const driver = cloudflareDriver()
    const target = await provision(driver, ensureInput(workspaceId))
    const wsUrl = target.url.replace(/^http/, "ws")
    console.error(`[provision] READY cloudflare sandbox=${target.sandboxId} url=${target.url} ws=${wsUrl}`)
    await writeArtifact("cloudflare", { provider, action, workspaceId, target, wsUrl })
    return
  }

  if (action === "destroy") {
    const sandboxId = stringArg("sandbox-id")
    if (!sandboxId) {
      console.error("[provision] destroy requires --sandbox-id")
      process.exit(2)
    }
    const driver = provider === "daytona" ? daytonaDriver(resolveDaytonaSnapshot()) : cloudflareDriver()
    if (!driver.destroy) {
      console.error(`[provision] driver ${provider} has no destroy()`)
      process.exit(2)
    }
    const hostId = provider === "daytona" ? `claxedo-${workspaceId}` : `claxedo-${workspaceId}`
    await driver.destroy({ sandboxId, url: "", hostId, workspaceId })
    console.error(`[provision] DESTROYED ${provider} sandbox=${sandboxId}`)
    return
  }

  console.error(`[provision] unknown --action ${action} (create|destroy)`)
  process.exit(2)
}

main().catch((err) => {
  console.error("[provision] failed:", err)
  process.exit(1)
})
