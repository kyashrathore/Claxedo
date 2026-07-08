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

async function jsonProbe(name: string, url: string, options?: RequestInit): Promise<SmokeResult> {
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

export async function centralSmoke(env: NodeJS.ProcessEnv = process.env) {
  const centralUrl = clean(env.CLAXEDO_CENTRAL_URL)
  if (!centralUrl) throw new Error("CLAXEDO_CENTRAL_URL is required")

  const checks = [
    await jsonProbe("central.health", route(centralUrl, "/global/health")),
    await jsonProbe("central.config", route(centralUrl, "/global/config")),
  ]

  const token = clean(env.CLAXEDO_SMOKE_BEARER_TOKEN)
  const workspaceId = clean(env.CLAXEDO_SMOKE_WORKSPACE_ID)
  if (token && workspaceId) {
    checks.push(await jsonProbe(
      "central.signed_connection",
      route(centralUrl, `/api/workspace/${encodeURIComponent(workspaceId)}/connection`),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
      },
    ))
  }

  return checks
}

async function main() {
  const checks = await centralSmoke()
  for (const check of checks) {
    console.log(`${check.ok ? "pass" : "fail"} ${check.name}: ${check.message}`)
  }
  if (checks.some((check) => !check.ok)) process.exit(1)
  console.log("central smoke succeeded")
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  try {
    await main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
