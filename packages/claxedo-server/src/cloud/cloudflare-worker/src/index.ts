/**
 * Cloudflare Worker that proxies sandbox operations over HTTP.
 *
 * Deploy: cd cloudflare-worker && npm install && wrangler deploy
 * Set secret: wrangler secret put API_TOKEN
 */
import { getSandbox } from "@cloudflare/sandbox"

// Re-export Sandbox DO class — required by wrangler
export { Sandbox } from "@cloudflare/sandbox"

interface Env {
  Sandbox: any
  API_TOKEN: string
}

function json(data: unknown, status = 200) {
  return Response.json(data, { status })
}

function auth(request: Request, env: Env): Response | null {
  const header = request.headers.get("Authorization")
  if (!header?.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401)
  if (header.slice(7) !== env.API_TOKEN) return json({ error: "forbidden" }, 403)
  return null
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const denied = auth(request, env)
    if (denied) return denied

    const url = new URL(request.url)
    const parts = url.pathname.split("/").filter(Boolean)

    if (parts[0] !== "sandbox" || !parts[1]) {
      return json({ error: "not found", usage: "/sandbox/:id/:action" }, 404)
    }

    const sandboxId = parts[1]
    const action = parts[2] || ""
    const sandbox = getSandbox(env.Sandbox, sandboxId)

    try {
      // DELETE /sandbox/:id
      if (request.method === "DELETE" && !action) {
        await sandbox.destroy()
        return json({ ok: true })
      }

      if (request.method !== "POST") {
        return json({ error: "method not allowed" }, 405)
      }

      const body = await request.json().catch(() => ({})) as Record<string, any>

      switch (action) {
        case "exec": {
          const result = await sandbox.exec(body.command, {
            env: body.env,
            cwd: body.cwd,
            timeout: body.timeout,
          })
          return json({
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
            success: result.success,
          })
        }

        case "write-file": {
          const content = body.encoding === "base64"
            ? atob(body.content)
            : body.content
          await sandbox.writeFile(body.path, content)
          return json({ ok: true })
        }

        case "mkdir": {
          await sandbox.mkdir(body.path, { recursive: body.recursive ?? true })
          return json({ ok: true })
        }

        case "start-process": {
          const proc = await sandbox.startProcess(body.command)
          return json({ processId: proc })
        }

        case "kill-process": {
          await sandbox.killProcess(body.processId, body.signal)
          return json({ ok: true })
        }

      case "expose-port": {
        const result = await sandbox.exposePort(body.port, {
          hostname: body.hostname,
        })
        return json({ url: result.url, port: result.port })
      }

        case "network": {
          if (typeof body.enableInternet === "boolean") sandbox.enableInternet = body.enableInternet
          if (Array.isArray(body.allowedHosts)) {
            sandbox.allowedHosts = body.allowedHosts
            await sandbox.setAllowedHosts(body.allowedHosts).catch(() => undefined)
        }
        if (Array.isArray(body.deniedHosts)) {
          sandbox.deniedHosts = body.deniedHosts
          await sandbox.setDeniedHosts(body.deniedHosts).catch(() => undefined)
        }
          return json({
            ok: true,
            enableInternet: sandbox.enableInternet,
            allowedHosts: sandbox.allowedHosts ?? [],
            deniedHosts: sandbox.deniedHosts ?? [],
          })
        }

        case "create-backup": {
          const backup = await sandbox.createBackup({
            dir: body.dir,
            name: body.name,
            ttl: body.ttl,
          })
          return json({ id: backup.id })
        }

        case "restore-backup": {
          await sandbox.restoreBackup(body.backup)
          return json({ ok: true })
        }

      default:
        return json({ error: `unknown action: ${action}` }, 404)
      }
    } catch (err: any) {
      return json({
        error: err.message || String(err),
        stack: err.stack,
        name: err.name,
      }, 500)
    }
  },
}
