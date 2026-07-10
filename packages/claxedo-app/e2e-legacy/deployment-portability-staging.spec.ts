import { expect, test } from "@playwright/test"

const REQUIRED_ENV = [
  "CLAXEDO_APP_URL",
  "CLAXEDO_CENTRAL_URL",
  "CLAXEDO_SMOKE_BEARER_TOKEN",
  "CLAXEDO_SMOKE_WORKSPACE_ID",
] as const

type ReadyConnection = {
  access: "cloud" | "user-hosted"
  backing: "local-worktree" | "cloud-vm"
  workspaceId: string
  homeRegion: string
  role: "owner" | "admin" | "editor" | "viewer"
  relayUrl: string
  runtimeAccessToken: string
  tokenExpiresAt: number
}

function clean(value: string | undefined) {
  return value?.trim() || undefined
}

function missingEnv() {
  return REQUIRED_ENV.filter((key) => !clean(process.env[key]))
}

function object(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function readyConnection(value: unknown): ReadyConnection | undefined {
  const input = object(value)
  if (!input) return undefined
  if ((input.access === "cloud" || input.access === "user-hosted")
    && (input.backing === "local-worktree" || input.backing === "cloud-vm")
    && typeof input.workspaceId === "string"
    && typeof input.homeRegion === "string"
    && (input.role === "owner" || input.role === "admin" || input.role === "editor" || input.role === "viewer")
    && typeof input.relayUrl === "string"
    && typeof input.runtimeAccessToken === "string"
    && typeof input.tokenExpiresAt === "number") {
    return {
      access: input.access,
      backing: input.backing,
      workspaceId: input.workspaceId,
      homeRegion: input.homeRegion,
      role: input.role,
      relayUrl: input.relayUrl,
      runtimeAccessToken: input.runtimeAccessToken,
      tokenExpiresAt: input.tokenExpiresAt,
    }
  }
  return undefined
}

function normalizedBase(input: string) {
  return input.endsWith("/") ? input : `${input}/`
}

// Same normalized join as the smoke scripts: preserves any path prefix on the
// central or relay base URL instead of letting an absolute pathname replace it.
function route(base: string, pathname: string) {
  return new URL(pathname.replace(/^\/+/, ""), normalizedBase(base)).toString()
}

function marker() {
  return `claxedo-browser-proof-${Date.now().toString(36)}`
}

test.describe("deployment portability staging browser proof", () => {
  test("opens staged app and reaches runtime through returned relay metadata", async ({ page }) => {
    test.skip(missingEnv().length > 0, `Missing ${missingEnv().join(", ")}`)

    const failed: string[] = []
    page.on("requestfailed", (request) => {
      const failure = `${request.method()} ${request.url()} ${request.failure()?.errorText ?? ""}`.trim()
      if (!failure.endsWith(" net::ERR_ABORTED")) failed.push(failure)
    })

    await page.goto(clean(process.env.CLAXEDO_BROWSER_PROOF_ROUTE) ?? "/")
    await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })

    // Each test.step title below maps 1:1 to a browser-proof manifest subcheck
    // name (browser.<title>); the proof script derives subcheck status from the
    // Playwright JSON report instead of assuming success.
    const connection = await test.step("signed_connection", async () => {
      const connectionResponse = await page.evaluate(async (input) => {
        const res = await fetch(input.url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${input.token}`,
            "content-type": "application/json",
          },
        })
        return {
          ok: res.ok,
          status: res.status,
          body: await res.json().catch(() => undefined),
        }
      }, {
        url: route(
          clean(process.env.CLAXEDO_CENTRAL_URL)!,
          `/api/workspace/${encodeURIComponent(clean(process.env.CLAXEDO_SMOKE_WORKSPACE_ID)!)}/connection`,
        ),
        token: clean(process.env.CLAXEDO_SMOKE_BEARER_TOKEN)!,
      })

      expect(connectionResponse.ok).toBe(true)
      expect(connectionResponse.status).toBeGreaterThanOrEqual(200)
      expect(connectionResponse.status).toBeLessThan(300)

      const ready = readyConnection(connectionResponse.body)
      expect(ready).toBeTruthy()
      expect(ready?.workspaceId).toBe(clean(process.env.CLAXEDO_SMOKE_WORKSPACE_ID))
      expect(ready?.tokenExpiresAt).toBeGreaterThan(Date.now())
      return ready!
    })

    await test.step("runtime_health", async () => {
      const runtimeHealth = await page.evaluate(async (input) => {
        const res = await fetch(input.url, {
          headers: { authorization: `Bearer ${input.runtimeAccessToken}` },
        })
        return { ok: res.ok, status: res.status }
      }, {
        url: route(
          connection.relayUrl,
          `/workspaces/${encodeURIComponent(connection.workspaceId)}/api/wr/health`,
        ),
        runtimeAccessToken: connection.runtimeAccessToken,
      })

      expect(runtimeHealth.ok).toBe(true)
      expect(runtimeHealth.status).toBeGreaterThanOrEqual(200)
      expect(runtimeHealth.status).toBeLessThan(300)
    })

    await test.step("file_list", async () => {
      const fileList = await page.evaluate(async (input) => {
        const res = await fetch(input.url, {
          headers: { authorization: `Bearer ${input.runtimeAccessToken}` },
        })
        return {
          ok: res.ok,
          status: res.status,
          body: await res.json().catch(() => undefined),
        }
      }, {
        url: route(
          connection.relayUrl,
          `/workspaces/${encodeURIComponent(connection.workspaceId)}/file`,
        ),
        runtimeAccessToken: connection.runtimeAccessToken,
      })

      expect(fileList.ok).toBe(true)
      expect(fileList.status).toBeGreaterThanOrEqual(200)
      expect(fileList.status).toBeLessThan(300)
      expect(Array.isArray(fileList.body)).toBe(true)
    })

    await test.step("pty_echo", async () => {
      const echoMarker = marker()
      const ptyEcho = await page.evaluate(async (input) => {
        const base = input.relayUrl.endsWith("/") ? input.relayUrl : `${input.relayUrl}/`
        const pty = await fetch(new URL(`workspaces/${encodeURIComponent(input.workspaceId)}/api/claxedo/pty`, base), {
          method: "POST",
          headers: {
            authorization: `Bearer ${input.runtimeAccessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ command: "/bin/sh", cwd: "." }),
        })
        const body = await pty.json().catch(() => undefined) as unknown
        const ptyId = body && typeof body === "object" && "id" in body && typeof body.id === "string" ? body.id : undefined
        if (!pty.ok || !ptyId) return { ok: false, stage: "create", status: pty.status }
        let ws: WebSocket | undefined
        try {
          const url = new URL(
            `workspaces/${encodeURIComponent(input.workspaceId)}/api/claxedo/pty/${encodeURIComponent(ptyId)}/connect?cursor=0`,
            base,
          ).toString().replace(/^http/, "ws")
          return await new Promise<{ ok: boolean; stage: string; status?: number }>((resolve) => {
            const timer = setTimeout(() => {
              try { ws?.close() } catch {}
              resolve({ ok: false, stage: "echo" })
            }, 30_000)
            ws = new WebSocket(url, [`claxedo-rat.${input.runtimeAccessToken}`])
            ws.onopen = () => {
              // The marker is shell-CONSTRUCTED from two halves, so the full
              // marker never appears in the typed line; plain input echo
              // cannot satisfy this check.
              ws?.send(`printf '%s%s\\n' '${input.markerHead}' '${input.markerTail}'\n`)
            }
            ws.onmessage = (event) => {
              if (typeof event.data !== "string" || !event.data.includes(input.marker)) return
              clearTimeout(timer)
              try { ws?.close() } catch {}
              resolve({ ok: true, stage: "echo" })
            }
            ws.onerror = () => {
              clearTimeout(timer)
              resolve({ ok: false, stage: "websocket" })
            }
            ws.onclose = () => {
              clearTimeout(timer)
              resolve({ ok: false, stage: "websocket" })
            }
          })
        } finally {
          await fetch(new URL(`workspaces/${encodeURIComponent(input.workspaceId)}/api/claxedo/pty/${encodeURIComponent(ptyId)}`, base), {
            method: "DELETE",
            headers: { authorization: `Bearer ${input.runtimeAccessToken}` },
          }).catch(() => undefined)
        }
      }, {
        relayUrl: connection.relayUrl,
        workspaceId: connection.workspaceId,
        runtimeAccessToken: connection.runtimeAccessToken,
        marker: echoMarker,
        markerHead: echoMarker.slice(0, Math.ceil(echoMarker.length / 2)),
        markerTail: echoMarker.slice(Math.ceil(echoMarker.length / 2)),
      })

      expect(ptyEcho).toEqual({ ok: true, stage: "echo" })
    })

    await test.step("reload_recovery", async () => {
      await page.reload()
      await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
      expect(failed).toEqual([])
    })
  })
})
