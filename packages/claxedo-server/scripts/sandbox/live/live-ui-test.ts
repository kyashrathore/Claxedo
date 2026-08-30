/**
 * Live end-to-end test for the cloud workspace create flow.
 *
 * Requires a running claxedo-server with real provider auth already configured.
 *
 * Coverage:
 *   1. Call /api/workspace/create with a real repo URL
 *   2. Wait for real provision events over /api/claxedo/events
 *   3. Verify /api/workspace/resolve
 *   4. Verify /api/claxedo/bootstrap
 *   5. Delete the workspace through the server API
 *
 * Usage:
 *   node --import tsx scripts/sandbox/live/live-ui-test.ts
 *
 * Optional:
 *   CLAXEDO_SERVER_URL=http://127.0.0.1:3001 node --import tsx scripts/sandbox/live/live-ui-test.ts
 *   LIVE_REPO_URL=https://github.com/kyashrathore/formlink.git node --import tsx scripts/sandbox/live/live-ui-test.ts
 */

const base = process.env.CLAXEDO_SERVER_URL || "http://127.0.0.1:3001"
const repo = process.env.LIVE_REPO_URL || "https://github.com/kyashrathore/formlink.git"
const project = process.env.LIVE_PROJECT_ID

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

function must(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}

type Runner = {
  type?: "claude-sdk" | "codex-app-server" | "cursor-sdk" | "opencode" | "pi" | `acp:${string}`
  binary?: string | null
}

async function wait<T>(fn: () => T | Promise<T>, ms = 300_000, step = 500): Promise<T> {
  const end = Date.now() + ms
  let err: unknown
  while (Date.now() < end) {
    try {
      const value = await fn()
      if (value) return value
    } catch (cause) {
      err = cause
    }
    await new Promise((resolve) => setTimeout(resolve, step))
  }
  throw err instanceof Error ? err : new Error("timed out")
}

async function sse(url: string, pick: () => string | undefined, ms = 300_000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  const res = await fetch(url, {
    headers: { Accept: "text/event-stream" },
    signal: ctrl.signal,
  })
  if (!res.ok || !res.body) {
    clearTimeout(timer)
    throw new Error(`SSE failed: ${res.status}`)
  }
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ""

  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      buf += dec.decode(next.value, { stream: true })
      for (;;) {
        const idx = buf.indexOf("\n\n")
        if (idx === -1) break
        const block = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        const data = block
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n")
        if (!data) continue
        const event = JSON.parse(data) as {
          type?: string
          step?: string
          workspaceId?: string
          message?: string
        }
        if (event.type !== "provision") continue
        const id = pick()
        if (!id) continue
        if (event.workspaceId !== id) continue
        if (event.step === "ready" || event.step === "error") return event
      }
    }
  } finally {
    clearTimeout(timer)
    ctrl.abort()
    await reader.cancel().catch(() => undefined)
  }

  throw new Error("SSE ended before provision event")
}

async function main() {
  let ws: { workspaceId: string; directory: string; projectId: string } | undefined
  let prev: Runner | undefined

  try {
    const init = await fetch(`${base}/api/claxedo/bootstrap`)
    must(init.ok, `bootstrap failed: ${init.status}`)
    const seed = await init.json() as {
      project?: Array<{ id: string; git?: { remote?: string | null } }>
    }
    const id = project || seed.project?.find((item) => item.git?.remote === repo)?.id
    if (id) ok(`using project: ${id}`)

    const pending = sse(`${base}/api/claxedo/events`, () => ws?.workspaceId)

    const res = await fetch(`${base}/api/workspace/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(id ? { projectId: id } : { repoUrl: repo }),
        workspaceName: `live-${Date.now().toString(36)}`,
      }),
    })
    must(res.ok, `workspace create failed: ${res.status}`)
    ws = await res.json() as { workspaceId: string; directory: string; projectId: string }
    ok(`workspace created: ${ws.workspaceId}`)

    const event = await pending
    if (event.step === "error") throw new Error(event.message ?? "provision failed")
    must(event.step === "ready", `unexpected provision step: ${event.step}`)
    ok(`workspace provisioned: ${event.step}`)

    const resolved = await wait(async () => {
      const res = await fetch(
        `${base}/api/workspace/resolve?workspaceId=${encodeURIComponent(ws!.workspaceId)}`,
      )
      if (!res.ok) return
      const body = await res.json() as { status?: string; kind?: string; sandboxId?: string | null }
      if (body.status !== "ready") return
      return body
    })
    must(resolved, "resolve did not return ready workspace")
    must(resolved.kind === "cloud", "resolve did not return cloud workspace")
    must(resolved.sandboxId, "resolve did not return sandbox id")
    ok(`workspace resolved with sandbox ${resolved.sandboxId}`)

    const boot = await wait(async () => {
      const res = await fetch(`${base}/api/claxedo/bootstrap`)
      if (!res.ok) return
      return await res.json() as {
        healthy?: boolean
        project?: Array<{ id: string; workspaces?: Record<string, { status?: string }> }>
      }
    })
    must(boot, "bootstrap did not return a body")
    must(boot.healthy, "bootstrap not healthy")
    const item = ws
    must(item, "workspace missing")
    const hit = boot.project?.find((entry) => entry.id === item.projectId)
    must(hit, "bootstrap missing project")
    must(hit.workspaces?.[item.directory]?.status === "ready", "bootstrap missing ready workspace")
    ok("bootstrap returned ready workspace")

    const runnerRes = await fetch(`${base}/api/claxedo/agent-config/harness`)
    must(runnerRes.ok, `runner status failed: ${runnerRes.status}`)
    prev = await runnerRes.json() as Runner
    must(prev.type, "runner status missing type")
    ok(`saved previous runner: ${prev.type}`)

    const switchRes = await fetch(`${base}/api/claxedo/agent-config/harness`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "opencode" }),
    })
    must(switchRes.ok, `runner switch failed: ${switchRes.status}`)
    ok("switched runner to opencode")

    const live = await wait(async () => {
      const res = await fetch(`${base}/api/claxedo/agent-config/harness?directory=${encodeURIComponent(item.directory)}`)
      if (!res.ok) return
      const body = await res.json() as {
        type?: string
        activeType?: string
        status?: string
      }
      if (body.activeType !== "opencode") return
      if (body.status !== "ready") return
      return body
    }, 30_000)
    must(live, "workspace runner did not switch to opencode")
    ok("workspace runner is opencode")

    const health = await wait(async () => {
      const res = await fetch(`${base}/api/wr/health?directory=${encodeURIComponent(item.directory)}`)
      if (!res.ok) return
      const body = await res.json() as { agentType?: string; status?: string }
      if (body.agentType !== "opencode") return
      if (body.status !== "ready") return
      return body
    }, 30_000)
    must(health, "workspace runtime health did not report opencode")
    ok("workspace runtime health reports opencode")

    const sessionRes = await fetch(`${base}/session?directory=${encodeURIComponent(item.directory)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "live-ui-opencode" }),
      signal: AbortSignal.timeout(20_000),
    })
    must(sessionRes.ok, `session create failed: ${sessionRes.status}`)
    const session = await sessionRes.json() as { id?: string }
    must(session.id, "session create missing id")
    ok(`session created: ${session.id}`)

    const cfgRes = await fetch(`${base}/config/providers?directory=${encodeURIComponent(item.directory)}&runner=opencode`, {
      signal: AbortSignal.timeout(10_000),
    })
    must(cfgRes.ok, `provider config failed: ${cfgRes.status}`)
    const cfg = await cfgRes.json() as { default?: Record<string, string> }
    const modelID = cfg.default?.opencode || "big-pickle"
    ok(`using opencode model: ${modelID}`)

    const sessionCfgRes = await fetch(`${base}/session/${encodeURIComponent(session.id)}/config?directory=${encodeURIComponent(item.directory)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        runner: { type: "opencode" },
        model: { providerID: "opencode", modelID },
        agent: "build",
      }),
      signal: AbortSignal.timeout(10_000),
    })
    must(sessionCfgRes.ok, `session config failed: ${sessionCfgRes.status}`)
    ok("session configured for opencode model")

    const target = "hello from opencode live ui test"
    const msgRes = await fetch(`${base}/session/${encodeURIComponent(session.id)}/message?directory=${encodeURIComponent(item.directory)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messageID: `msg_${Date.now()}`,
        agent: "build",
        model: { providerID: "opencode", modelID },
        parts: [{ type: "text", text: `Reply with exactly: ${target}` }],
      }),
      signal: AbortSignal.timeout(60_000),
    })
    must(msgRes.ok, `session message failed: ${msgRes.status}`)
    const msg = await msgRes.json() as { info?: { error?: { data?: { message?: string } } }; parts?: Array<{ text?: string }> }
    const text = (msg.parts ?? []).map((part) => part.text ?? "").join("").trim()
    if (!text.toLowerCase().includes(target)) {
      throw new Error(msg.info?.error?.data?.message || text || "session message returned no text")
    }
    ok(`session replied: ${text}`)
  } finally {
    if (prev?.type) {
      await fetch(`${base}/api/claxedo/agent-config/harness`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: prev.type,
          ...(prev.binary ? { binary: prev.binary } : {}),
        }),
      }).catch(() => undefined)
    }
    if (ws) {
      const res = await fetch(`${base}/api/workspace/${encodeURIComponent(ws.workspaceId)}`, {
        method: "DELETE",
      }).catch(() => undefined)
      if (res?.ok) ok(`workspace deleted: ${ws.workspaceId}`)
    }
  }

  console.log(`\nPASS ${pass} | FAIL ${fail}`)
}

await main().catch((err) => {
  bad("live ui flow", err)
  console.log(`\nPASS ${pass} | FAIL ${fail}`)
  process.exitCode = 1
})

export {}
