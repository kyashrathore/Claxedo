import type { SandboxHandle } from "./sandbox-handle"
import { Log } from "../log"
import type { SandboxNetworkPolicy } from "../network/resolve"

const log = Log.create({ service: "sandbox-cloudflare" })

/**
 * Talks to a user-deployed Cloudflare Worker that wraps @cloudflare/sandbox.
 *
 * Cloudflare Sandbox runs inside Workers using Durable Object bindings —
 * it can't be called directly from a Node.js server. Instead, users deploy
 * a thin Worker that exposes the sandbox operations over HTTP, and this
 * adapter calls that Worker.
 *
 * STATUS: Experimental — requires:
 *   1. Deploy the proxy Worker (see cloudflare-worker/README.md)
 *   2. A custom domain with wildcard DNS (*.sandbox.yourdomain.com)
 *   3. Cloudflare Advanced Certificate Manager ($10/mo) for wildcard SSL
 *   Without (2) and (3), exposePort/getServiceUrl will fail because
 *   .workers.dev domains don't support the wildcard subdomains needed
 *   for port proxying.
 *
 * Expected Worker API contract:
 *   POST /sandbox/:id/exec         { command, env?, cwd?, timeout? }  → { stdout, stderr, exitCode, success }
 *   POST /sandbox/:id/write-file   { path, content, encoding? }       → {}
 *   POST /sandbox/:id/mkdir        { path, recursive? }               → {}
 *   POST /sandbox/:id/start-process { command }                       → { processId }
 *   POST /sandbox/:id/kill-process  { processId?, signal? }           → {}
 *   POST /sandbox/:id/expose-port   { port, hostname }                → { url }
 *   POST /sandbox/:id/network       { enableInternet, allowedHosts }  → {}
 *   DELETE /sandbox/:id                                               → {}
 */
export class CloudflareSandboxHandle implements SandboxHandle {
  private processId: string | undefined

  constructor(
    public readonly id: string,
    private readonly workerUrl: string,
    private readonly apiToken: string,
  ) {}

  private url(path: string): string {
    const base = this.workerUrl.replace(/\/+$/, "")
    return `${base}/sandbox/${this.id}${path}`
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiToken}`,
      "Content-Type": "application/json",
    }
  }

  private async post<T = unknown>(path: string, body: unknown): Promise<T> {
    const res = await fetch(this.url(path), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300_000),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      throw new Error(`Cloudflare sandbox ${path} failed: ${res.status} ${text}`)
    }
    return res.json() as Promise<T>
  }

  async executeCommand(cmd: string, timeout?: number): Promise<{ result: string }> {
    const res = await this.post<{ stdout: string; stderr: string; exitCode: number }>("/exec", {
      command: cmd,
      timeout: timeout ? timeout * 1000 : undefined,
    })
    return { result: res.stdout ?? "" }
  }

  async uploadFile(content: Buffer, remotePath: string): Promise<void> {
    // Ensure parent directory exists
    const dir = remotePath.substring(0, remotePath.lastIndexOf("/"))
    if (dir) {
      await this.post("/mkdir", { path: dir, recursive: true }).catch(() => {})
    }
    await this.post("/write-file", {
      path: remotePath,
      content: content.toString("base64"),
      encoding: "base64",
    })
  }

  async createSession(_sessionId: string): Promise<void> {
    // Cloudflare uses startProcess for long-running commands
  }

  async executeSessionCommand(
    _sessionId: string,
    opts: { command: string; runAsync?: boolean },
  ): Promise<void> {
    if (opts.runAsync) {
      const res = await this.post<{ processId: string }>("/start-process", {
        command: opts.command,
      })
      this.processId = res.processId
      return
    }
    await this.post("/exec", { command: opts.command })
  }

  async deleteSession(_sessionId: string): Promise<void> {
    if (this.processId) {
      await this.post("/kill-process", {
        processId: this.processId,
        signal: "SIGTERM",
      }).catch(() => {})
      this.processId = undefined
    }
  }

  async getServiceUrl(port: number): Promise<string> {
    const hostname = new URL(this.workerUrl).hostname
    const res = await this.post<{ url: string }>("/expose-port", { port, hostname })
    return res.url
  }

  async refreshActivity(): Promise<void> {
    // Cloudflare sandbox containers auto-sleep after inactivity.
    // Any operation keeps them alive, so exec a lightweight command.
    await this.post("/exec", { command: "true", timeout: 5000 }).catch(() => {})
  }

  async start(): Promise<void> {
    // Cloudflare sandboxes start lazily on first operation — no explicit start needed.
    // Execute a no-op command to trigger container startup.
    await this.post("/exec", { command: "true" })
  }

  async stop(): Promise<void> {
    // Cloudflare sandbox containers sleep automatically on inactivity.
    // There's no explicit stop — use destroy() to fully terminate.
  }

  async destroy(): Promise<void> {
    const res = await fetch(this.url(""), {
      method: "DELETE",
      headers: this.headers(),
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok && res.status !== 404) {
      log.warn("Failed to destroy Cloudflare sandbox", {
        sandboxId: this.id,
        status: res.status,
      })
    }
  }

  async setLabels(_labels: Record<string, string>): Promise<void> {
    // Cloudflare sandbox doesn't support labels
  }

  async setNetworkPolicy(net?: SandboxNetworkPolicy): Promise<void> {
    await this.post("/network", {
      enableInternet: !net || net.mode === "allow-all",
      allowedHosts: net?.mode === "restricted" ? net.hosts : [],
      deniedHosts: [],
    })
  }
}

/**
 * Create a CloudflareSandboxHandle that will lazily start on first operation.
 */
export async function createCloudflareSandbox(opts: {
  sandboxId: string
  workerUrl: string
  apiToken: string
  net?: SandboxNetworkPolicy
}): Promise<CloudflareSandboxHandle> {
  log.info("Creating Cloudflare sandbox handle", { sandboxId: opts.sandboxId })
  const handle = new CloudflareSandboxHandle(opts.sandboxId, opts.workerUrl, opts.apiToken)
  if (opts.net) {
    await handle.setNetworkPolicy(opts.net)
  }
  return handle
}
