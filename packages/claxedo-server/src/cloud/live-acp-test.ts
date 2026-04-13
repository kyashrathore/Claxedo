/**
 * Live ACP smoke test for remote sandboxes.
 *
 * Coverage:
 *   1. Acquire a real sandbox
 *   2. Deploy workspace-runtime
 *   3. Apply outbound network policy
 *   4. Verify allowed host works and blocked host fails
 *   5. Run ACP hello-world prompts for each configured runner
 *
 * Usage:
 *   SANDBOX_PROVIDER=modal node --import tsx src/cloud/live-acp-test.ts
 *   SANDBOX_PROVIDER=vercel ACP_RUNNERS=claude-acp,codex-acp node --import tsx src/cloud/live-acp-test.ts
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
import { ensureSnapshot, RUNTIME_DIR, WORKSPACE_DIR } from "./sandbox/image"
import type { SandboxHandle } from "./sandbox/handle"
import type { SandboxProviderID } from "./types"
import { DaytonaSandboxHandle } from "./sandbox/daytona"
import { createModalSandbox } from "./sandbox/modal"
import { createVercelSandbox } from "./sandbox/vercel"
import { createCloudflareSandbox } from "./sandbox/cloudflare"
import { sandboxAuthManaged } from "./sandbox"
import { formatDaytonaAllowList, resolveSandboxNetworkPolicy, type PolicyEntry, type SandboxNetworkPolicy } from "../network/resolve"
import { syncLocalCredentials } from "../credentials/sync"
import { resolveAllSecrets } from "../credentials/registry"

const provider = (process.env.SANDBOX_PROVIDER || "daytona") as SandboxProviderID
const runners = (process.env.ACP_RUNNERS || "claude-acp,codex-acp,cursor-acp")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean) as Array<"claude-acp" | "codex-acp" | "cursor-acp">

const preset = {
  "claude-acp": "anthropic",
  "codex-acp": "openai",
  "cursor-acp": "openai",
} as const

const host = {
  "claude-acp": "https://api.anthropic.com",
  "codex-acp": "https://api.openai.com",
  "cursor-acp": "https://api.openai.com",
} as const

const bin = {
  "claude-acp": `command -v claude-agent-acp || test -x ${RUNTIME_DIR}/node_modules/.bin/claude-agent-acp && echo ${RUNTIME_DIR}/node_modules/.bin/claude-agent-acp`,
  "codex-acp": `command -v codex-acp || test -x ${RUNTIME_DIR}/node_modules/.bin/codex-acp && echo ${RUNTIME_DIR}/node_modules/.bin/codex-acp`,
  "cursor-acp": "command -v agent || command -v cursor-agent",
} as const

const hdr = {
  "Content-Type": "application/json",
  "x-opencode-directory": WORKSPACE_DIR,
  "X-Daytona-Skip-Preview-Warning": "true",
}

let pass = 0
let fail = 0
let skip = 0

function ok(label: string) {
  pass++
  console.log(`  \u2713 ${label}`)
}

function bad(label: string, err: unknown) {
  fail++
  console.log(`  \u2717 ${label}: ${err instanceof Error ? err.message : String(err)}`)
}

function omit(label: string, why: string) {
  skip++
  console.log(`  - ${label}: ${why}`)
}

async function probe(sandbox: SandboxHandle, url: string) {
  const js = `const signal = AbortSignal.timeout(10000); fetch(${JSON.stringify(url)}, { signal }).then((res) => { console.log("ok:" + res.status); process.exit(0) }).catch((err) => { console.log("err:" + (err && err.message ? err.message : String(err))); process.exit(7) })`
  const cmd = `node -e '${js}' ; echo __EXIT__$?`
  const out = (await sandbox.executeCommand(cmd, 20)).result ?? ""
  const hit = out.match(/__EXIT__(\d+)/)
  return {
    code: hit ? Number(hit[1]) : 1,
    out: out.replace(/__EXIT__\d+\s*$/, "").trim(),
  }
}

function text(body: any) {
  if (!Array.isArray(body?.parts)) return ""
  return body.parts
    .map((part: any) => typeof part?.text === "string" ? part.text : "")
    .join("")
    .trim()
}

function data(input: string | undefined) {
  if (!input) return
  try {
    const value = JSON.parse(input) as Record<string, unknown>
    return value && typeof value === "object" ? value : undefined
  } catch {}
}

async function createDaytona(net?: SandboxNetworkPolicy) {
  const auth = await sandboxAuthManaged("daytona")
  if (!auth?.api_key) throw new Error("Managed daytona credential is required")
  const daytona = new Daytona({ apiKey: auth.api_key })
  const snapshot = await ensureSnapshot(daytona)
  ok(`snapshot ready: ${snapshot}`)
  const sandbox = await daytona.create({
    snapshot,
    labels: { app: "claxedo", pool: "live-acp" },
    autoStopInterval: 15,
    ...(net?.mode === "restricted"
      ? {
          networkBlockAll: true,
          ...(net.cidrs.length ? { networkAllowList: formatDaytonaAllowList(net.cidrs) } : {}),
        }
      : {}),
  })
  if (sandbox.state !== SandboxState.STARTED) await sandbox.waitUntilStarted(120)
  ok(`sandbox created: id=${sandbox.id}`)
  return {
    handle: new DaytonaSandboxHandle(sandbox),
    cleanup: async () => {
      await daytona.delete(sandbox)
    },
  }
}

async function createModal(net?: SandboxNetworkPolicy) {
  const auth = await sandboxAuthManaged("modal")
  if (!auth?.token_id || !auth?.token_secret) {
    throw new Error("Managed modal credential is required")
  }
  const handle = await createModalSandbox({
    tokenId: auth.token_id,
    tokenSecret: auth.token_secret,
    name: `live-acp-${Date.now()}`,
    net,
  })
  ok(`sandbox created: id=${handle.id}`)
  return {
    handle,
    cleanup: async () => {
      await handle.destroy()
    },
  }
}

async function createVercel(net?: SandboxNetworkPolicy) {
  const auth = await sandboxAuthManaged("vercel")
  if (!auth?.access_token) {
    throw new Error("Managed vercel credential is required")
  }
  const handle = await createVercelSandbox({
    net,
    token: auth.access_token,
    teamId: auth.team_id,
    projectId: auth.project_id,
  })
  ok(`sandbox created: id=${handle.id}`)
  return {
    handle,
    cleanup: async () => {
      await handle.destroy()
    },
  }
}

async function createCloudflare(net?: SandboxNetworkPolicy) {
  const auth = await sandboxAuthManaged("cloudflare")
  if (!auth?.api_token || !auth?.worker_url) {
    throw new Error("Managed cloudflare credential is required")
  }
  const handle = await createCloudflareSandbox({
    sandboxId: `live-acp-${Date.now()}`,
    workerUrl: auth.worker_url,
    apiToken: auth.api_token,
    net,
  })
  await handle.start()
  ok(`sandbox created: id=${handle.id}`)
  return {
    handle,
    cleanup: async () => {
      await handle.destroy()
    },
  }
}

async function acquire(net?: SandboxNetworkPolicy): Promise<{
  handle: SandboxHandle
  cleanup: () => Promise<void>
}> {
  switch (provider) {
    case "daytona":
      return createDaytona(net)
    case "modal":
      return createModal(net)
    case "vercel":
      return createVercel(net)
    case "cloudflare":
      return createCloudflare(net)
  }
}

async function main() {
  console.log(`\n== Live ACP test: provider=${provider} runners=${runners.join(",")} ==`)

  const sync = await syncLocalCredentials([provider, ...runners])
  if (sync.synced.length) ok(`synced local credentials: ${sync.synced.join(", ")}`)
  if (sync.existing.length) ok(`using managed credentials: ${sync.existing.join(", ")}`)
  if (sync.failed.length) {
    for (const item of sync.failed) bad(`sync ${item.provider_id}`, item.error)
  }

  const secrets = await resolveAllSecrets()
  const active = runners.filter((item) => !!secrets[item])
  const items = [...new Set((active.length ? active : runners).map((item) => preset[item]))]
  const entries: PolicyEntry[] = items.map((target) => ({ target, kind: "group" }))
  if (provider === "modal") {
    entries.push({ target: "registry.npmjs.org", kind: "host" })
  }
  const net = provider === "daytona"
    ? undefined
    : await resolveSandboxNetworkPolicy(entries, undefined, "cidr")
  const dynamic = provider === "vercel" || provider === "cloudflare"
  const ws = `ws_live_acp_${Date.now()}`
  const { handle: sandbox, cleanup } = await acquire(dynamic || provider === "daytona" ? undefined : net)

  try {
    console.log("\n\u2500\u2500 Step 1: Deploy workspace-runtime \u2500\u2500")
    const { url } = await deployAndStart(sandbox, ws, {
      directory: WORKSPACE_DIR,
    })
    ok(`runtime URL: ${url}`)

    if (net && dynamic && sandbox.setNetworkPolicy) {
      await sandbox.setNetworkPolicy(net)
      ok("network policy applied after bootstrap")
    }

    console.log("\n\u2500\u2500 Step 2: Verify outbound policy \u2500\u2500")
    const target = active[0] ?? runners[0]
    const allow = await probe(sandbox, host[target] || "https://api.openai.com")
    if (allow.code === 0) ok(`allowed host reachable: ${allow.out || "ok"}`)
    else bad("allowed host reachable", allow.out || `exit=${allow.code}`)

    const deny = await probe(sandbox, "https://example.com")
    if (deny.code !== 0) ok(`blocked host denied: ${deny.out || `exit=${deny.code}`}`)
    else bad("blocked host denied", deny.out || "expected failure")

    console.log("\n\u2500\u2500 Step 3: ACP hello world \u2500\u2500")
    for (const runner of runners) {
      const secret = secrets[runner]
      if (!secret) {
        omit(runner, `missing managed credential for ${runner}`)
        continue
      }
      const value = data(secret)
      if (
        runner === "codex-acp" &&
        value?.type === "codex_auth" &&
        value.auth_mode === "chatgpt" &&
        typeof value.OPENAI_API_KEY !== "string"
      ) {
        omit(runner, "local Codex ChatGPT subscription auth is unsupported in remote projects; use OPENAI_API_KEY or CODEX_API_KEY")
        continue
      }

      const found = await sandbox.executeCommand(`${bin[runner]} || true`, 10)
      if (!found.result?.trim()) {
        bad(`${runner} binary`, "not found in sandbox")
        continue
      }
      ok(`${runner} binary: ${found.result.trim().split("\n").pop()}`)

      const cfg = await fetch(`${url}/api/wr/config`, {
        method: "POST",
        headers: hdr,
        body: JSON.stringify({
          version: 1,
          mcp: {},
          runner: { type: runner },
          auth: { [runner]: secret },
        }),
        signal: AbortSignal.timeout(10_000),
      })
      if (!cfg.ok) {
        bad(`${runner} config`, `${cfg.status} ${await cfg.text().catch(() => "")}`)
        continue
      }
      ok(`${runner} config applied`)

      let create: Response
      try {
        create = await fetch(`${url}/session`, {
          method: "POST",
          headers: hdr,
          body: JSON.stringify({ title: `hello-${runner}` }),
          signal: AbortSignal.timeout(10_000),
        })
      } catch (err) {
        bad(`${runner} session create`, err)
        continue
      }
      if (!create.ok) {
        bad(`${runner} session create`, `${create.status} ${await create.text().catch(() => "")}`)
        continue
      }
      const session = await create.json() as { id?: string }
      if (!session.id) {
        bad(`${runner} session create`, "missing session id")
        continue
      }
      ok(`${runner} session: ${session.id}`)

      const target = `hello from ${runner}`
      let msg: Response
      try {
        msg = await fetch(`${url}/session/${encodeURIComponent(session.id)}/message`, {
          method: "POST",
          headers: hdr,
          body: JSON.stringify({
            messageID: `msg_${Date.now()}`,
            parts: [{ type: "text", text: `Reply with exactly: ${target}` }],
          }),
          signal: AbortSignal.timeout(30_000),
        })
      } catch (err) {
        bad(`${runner} hello`, err)
        continue
      }
      if (!msg.ok) {
        bad(`${runner} hello`, `${msg.status} ${await msg.text().catch(() => "")}`)
        continue
      }

      const body = await msg.json()
      const out = text(body)
      if (out.toLowerCase().includes(target.toLowerCase())) ok(`${runner} hello: ${out}`)
      else bad(`${runner} hello`, out || JSON.stringify(body).slice(0, 300))
    }
  } finally {
    console.log("\n\u2500\u2500 Step 4: Cleanup \u2500\u2500")
    await stopRemoteRuntime(sandbox, ws)
      .catch(() => undefined)
    await cleanup().catch(() => undefined)
  }

  console.log(`\n\u2500\u2500 Results: ${pass} passed, ${fail} failed, ${skip} skipped (provider: ${provider}) \u2500\u2500`)
  if (fail > 0) process.exit(1)
}

main().catch((err) => {
  console.error("\nFATAL:", err)
  process.exit(1)
})
