import { fileURLToPath } from "node:url"
import path from "node:path"

type SmokeResult = {
  name: string
  ok: boolean
  message: string
}

function clean(value: string | undefined) {
  return value?.trim() || undefined
}

function route(base: string, pathname: string) {
  const normalized = base.endsWith("/") ? base : `${base}/`
  return new URL(pathname.replace(/^\/+/, ""), normalized).toString()
}

function runtimeBase(env: NodeJS.ProcessEnv) {
  const direct = clean(env.CLAXEDO_RUNTIME_URL)
  if (direct) return direct
  const relay = clean(env.CLAXEDO_RELAY_URL)
  const workspace = clean(env.CLAXEDO_SMOKE_WORKSPACE_ID)
  if (relay && workspace) return route(relay, `/workspaces/${encodeURIComponent(workspace)}`)
  throw new Error("Set CLAXEDO_RUNTIME_URL or CLAXEDO_RELAY_URL plus CLAXEDO_SMOKE_WORKSPACE_ID")
}

async function probe(name: string, url: string, options?: RequestInit): Promise<SmokeResult> {
  try {
    const res = await fetch(url, { ...options, signal: AbortSignal.timeout(15_000) })
    await res.text().catch(() => "")
    return {
      name,
      ok: res.ok,
      message: `${res.status} ${res.statusText}`.trim(),
    }
  } catch (error) {
    return {
      name,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

async function ptyProbe(base: string, headers: Record<string, string> | undefined) {
  try {
    const create = await fetch(route(base, "/api/wr/pty"), {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
      },
      body: JSON.stringify({ command: "/bin/sh", cwd: "." }),
      signal: AbortSignal.timeout(15_000),
    })
    const body = await create.json().catch(() => undefined) as unknown
    const id = body && typeof body === "object" && "id" in body && typeof body.id === "string" ? body.id : undefined
    if (id) {
      await fetch(route(base, `/api/wr/pty/${encodeURIComponent(id)}`), {
        method: "DELETE",
        headers,
        signal: AbortSignal.timeout(5_000),
      }).catch(() => undefined)
    }
    return {
      name: "runtime.pty",
      ok: create.ok,
      message: `${create.status} ${create.statusText}`.trim(),
    }
  } catch (error) {
    return {
      name: "runtime.pty",
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function runtimeSmoke(env: NodeJS.ProcessEnv = process.env) {
  const base = runtimeBase(env)
  const token = clean(env.CLAXEDO_RUNTIME_ACCESS_TOKEN)
    ?? clean(env.CLAXEDO_SMOKE_RUNTIME_ACCESS_TOKEN)
  const headers = token ? { authorization: `Bearer ${token}` } : undefined
  return [
    await probe("runtime.health", route(base, "/api/wr/health"), { headers }),
    await probe("runtime.files", route(base, "/file"), { headers }),
    await ptyProbe(base, headers),
  ]
}

async function main() {
  const checks = await runtimeSmoke()
  for (const check of checks) {
    console.log(`${check.ok ? "pass" : "fail"} ${check.name}: ${check.message}`)
  }
  if (checks.some((check) => !check.ok)) process.exit(1)
  console.log("runtime smoke succeeded")
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  try {
    await main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
