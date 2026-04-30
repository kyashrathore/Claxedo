/**
 * Live Codex ACP auth verifier for cloud workspaces.
 *
 * Coverage:
 *   1. Acquire a real Daytona sandbox
 *   2. Deploy workspace-runtime
 *   3. Apply a managed Codex credential through both auth lanes:
 *      - auth["codex-acp"]
 *      - auth["openai"]
 *   4. Verify config options, session creation, and first reply work
 *
 * Usage:
 *   node --import tsx src/cloud/live-codex-auth-test.ts
 *   SLOT_MODE=openai node --import tsx src/cloud/live-codex-auth-test.ts
 */

import fs from "node:fs"
import path from "node:path"

function loadEnvFile(file: string) {
  if (!fs.existsSync(file)) return
  for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
    const txt = line.trim()
    if (!txt || txt.startsWith("#")) continue
    const idx = txt.indexOf("=")
    if (idx === -1) continue
    const key = txt.slice(0, idx)
    let value = txt.slice(idx + 1)
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (!process.env[key]) process.env[key] = value
  }
}

loadEnvFile(path.resolve(import.meta.dirname, "../../.env"))
loadEnvFile(path.resolve(import.meta.dirname, "../../../../.env.local"))

import { Daytona, SandboxState } from "@daytonaio/sdk"
import { deployAndStart, stopRemoteRuntime } from "./sandbox/runtime"
import { ensureSnapshot, WORKSPACE_DIR } from "./sandbox/image"
import { DaytonaSandboxHandle } from "./sandbox/daytona"
import { sandboxAuthManaged } from "./sandbox"
import { syncLocalCredentials } from "../credentials/sync"
import { resolveSecret } from "../credentials/registry"

const hdr = {
  "Content-Type": "application/json",
  "x-opencode-directory": WORKSPACE_DIR,
  "X-Daytona-Skip-Preview-Warning": "true",
}

const slotMode = process.env.SLOT_MODE || "both"
const forceRuntimeInstall = process.env.FORCE_RUNTIME_INSTALL === "1"

function ok(label: string, extra?: unknown) {
  console.log(`  ✓ ${label}${extra ? ` ${JSON.stringify(extra)}` : ""}`)
}

function fail(label: string, extra?: unknown): never {
  throw new Error(`${label}${extra ? ` ${JSON.stringify(extra)}` : ""}`)
}

function summary(secret: string) {
  try {
    const value = JSON.parse(secret) as Record<string, unknown>
    return {
      type: value.type ?? null,
      auth_mode: value.auth_mode ?? null,
      has_openai_key: typeof value.OPENAI_API_KEY === "string",
      has_tokens: !!value.tokens,
      has_oauth: !!value.oauth,
    }
  } catch {
    return {
      type: "raw",
      has_openai_key: typeof secret === "string" && secret.startsWith("sk-"),
      has_tokens: false,
      has_oauth: false,
    }
  }
}

function text(body: any) {
  if (!Array.isArray(body?.parts)) return ""
  return body.parts
    .map((part: any) => typeof part?.text === "string" ? part.text : "")
    .join("")
    .trim()
}

function pickModelId(options: unknown[]) {
  const model = options.find((item) =>
    !!item
    && typeof item === "object"
    && (item as { category?: unknown }).category === "model"
    && (item as { type?: unknown }).type === "select",
  ) as {
    currentValue?: unknown
    selectOptions?: Array<{ id?: string }>
    options?: Array<{ value?: string }>
  } | undefined
  if (typeof model?.currentValue === "string" && model.currentValue) return model.currentValue
  const select = model?.selectOptions?.find((item) => typeof item.id === "string" && item.id)
  if (select?.id) return select.id
  const fallback = model?.options?.find((item) => typeof item.value === "string" && item.value)
  return fallback?.value
}

async function createSandbox() {
  const auth = await sandboxAuthManaged("daytona")
  if (!auth?.api_key) throw new Error("Managed Daytona credential is required")
  const daytona = new Daytona({ apiKey: auth.api_key })
  const snapshot = await ensureSnapshot(daytona)
  ok("snapshot ready", { snapshot })
  const sandbox = await daytona.create({
    snapshot,
    labels: { app: "claxedo", pool: "live-codex-auth" },
    autoStopInterval: 15,
  })
  if (sandbox.state !== SandboxState.STARTED) await sandbox.waitUntilStarted(120)
  ok("sandbox created", { id: sandbox.id })
  return {
    sandbox: new DaytonaSandboxHandle(sandbox),
    cleanup: async () => {
      await daytona.delete(sandbox)
    },
  }
}

async function verifyLane(url: string, secret: string, lane: "codex-acp" | "openai") {
  console.log(`\n── Verify lane: ${lane} ──`)
  const auth = { [lane]: secret }
  const cfg = await fetch(`${url}/api/wr/config`, {
    method: "POST",
    headers: hdr,
    body: JSON.stringify({
      version: 1,
      mcp: {},
      runner: { type: "codex-acp" },
      auth,
    }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!cfg.ok) fail("config apply failed", { lane, status: cfg.status, body: await cfg.text().catch(() => "") })
  ok("config applied", { lane })

  const options = await fetch(`${url}/api/wr/acp-config-options?directory=${encodeURIComponent(WORKSPACE_DIR)}`, {
    headers: { Accept: "application/json", "x-opencode-directory": WORKSPACE_DIR },
    signal: AbortSignal.timeout(15_000),
  })
  if (!options.ok) fail("config options failed", { lane, status: options.status, body: await options.text().catch(() => "") })
  const optionBody = await options.json() as unknown[]
  ok("config options probed", { lane, count: optionBody.length })
  const modelId = pickModelId(optionBody)
  if (!modelId) fail("missing model option", { lane, options: optionBody })
  ok("model selected", { lane, modelId })

  const create = await fetch(`${url}/session`, {
    method: "POST",
    headers: hdr,
    body: JSON.stringify({ title: `live-codex-${lane}` }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!create.ok) fail("session create failed", { lane, status: create.status, body: await create.text().catch(() => "") })
  const session = await create.json() as { id?: string }
  if (!session.id) fail("session create missing id", { lane })
  ok("session created", { lane, session: session.id })

  const config = await fetch(`${url}/session/${encodeURIComponent(session.id)}/config`, {
    method: "PATCH",
    headers: hdr,
    body: JSON.stringify({
      runner: { type: "codex-acp", model: modelId },
      model: { providerID: "codex-acp", modelID: modelId },
      agent: "build",
    }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!config.ok) fail("session config failed", { lane, status: config.status, body: await config.text().catch(() => "") })
  ok("session config applied", { lane, modelId })

  const target = `hello from ${lane}`
  const msg = await fetch(`${url}/session/${encodeURIComponent(session.id)}/message`, {
    method: "POST",
    headers: hdr,
    body: JSON.stringify({
      messageID: `msg_${Date.now()}_${lane}`,
      model: { providerID: "codex-acp", modelID: modelId },
      parts: [{ type: "text", text: `Reply with exactly: ${target}` }],
    }),
    signal: AbortSignal.timeout(45_000),
  })
  if (!msg.ok) fail("message failed", { lane, status: msg.status, body: await msg.text().catch(() => "") })
  const body = await msg.json()
  const out = text(body)
  if (!out.toLowerCase().includes(target.toLowerCase())) {
    fail("unexpected response", { lane, out: out || JSON.stringify(body).slice(0, 300) })
  }
  ok("message succeeded", { lane, out })
}

async function main() {
  console.log(`\n== Live Codex ACP auth test: slotMode=${slotMode} ==`)
  const sync = await syncLocalCredentials(["codex-acp"])
  if (sync.synced.length) ok("synced credentials", { synced: sync.synced })
  if (sync.existing.length) ok("using managed credentials", { existing: sync.existing })
  if (sync.failed.length) fail("credential sync failed", sync.failed)

  const secret = await resolveSecret("codex-acp")
  if (!secret) fail("missing managed codex-acp credential")
  ok("resolved codex-acp credential", summary(secret))

  const { sandbox, cleanup } = await createSandbox()
  const workspaceId = `ws_live_codex_${Date.now()}`

  try {
    console.log("\n── Deploy runtime ──")
    if (forceRuntimeInstall) {
      await sandbox.executeCommand("rm -rf /opt/workspace-runtime").catch(() => undefined)
      ok("cleared preinstalled runtime", { forceRuntimeInstall })
    }
    const { url } = await deployAndStart(sandbox, workspaceId, {
      directory: WORKSPACE_DIR,
    })
    ok("runtime ready", { url })

    if (slotMode === "both" || slotMode === "codex-acp") {
      await verifyLane(url, secret, "codex-acp")
    }
    if (slotMode === "both" || slotMode === "openai") {
      await verifyLane(url, secret, "openai")
    }
  } finally {
    console.log("\n── Cleanup ──")
    await stopRemoteRuntime(sandbox, workspaceId).catch(() => undefined)
    await cleanup().catch(() => undefined)
  }
}

main().catch((err) => {
  console.error("\nFATAL:", err)
  process.exit(1)
})
