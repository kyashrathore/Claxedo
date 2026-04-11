import { ModalClient, type Sandbox, type ContainerProcess, type App } from "modal"
import type { SandboxHandle } from "./sandbox-handle"
import { Log } from "../log"
import { RUNTIME_PORT, SANDBOX_IMAGE } from "./sandbox-image"
import type { SandboxNetworkPolicy } from "../network/resolve"

const log = Log.create({ service: "sandbox-modal" })

let cachedClient: ModalClient | undefined
let cachedApp: App | undefined

/**
 * Wraps the official Modal SDK Sandbox into the provider-agnostic SandboxHandle.
 */
export class ModalSandboxHandle implements SandboxHandle {
  private runtimeProc: ContainerProcess<string> | undefined

  constructor(
    private readonly inner: Sandbox,
    private readonly client: ModalClient,
  ) {}

  get id(): string {
    return this.inner.sandboxId
  }

  async executeCommand(cmd: string, timeout?: number): Promise<{ result: string }> {
    const proc = await this.inner.exec(["bash", "-c", cmd], {
      timeoutMs: timeout ? timeout * 1000 : undefined,
    })
    await proc.wait()
    const stdout = await proc.stdout.readText()
    return { result: stdout }
  }

  async uploadFile(content: Buffer, remotePath: string): Promise<void> {
    const dir = remotePath.substring(0, remotePath.lastIndexOf("/"))
    if (dir) {
      const p = await this.inner.exec(["mkdir", "-p", dir])
      await p.wait()
    }
    const file = await this.inner.open(remotePath, "w")
    await file.write(content)
    await file.close()
  }

  async createSession(_sessionId: string): Promise<void> {}

  async executeSessionCommand(
    _sessionId: string,
    opts: { command: string; runAsync?: boolean },
  ): Promise<void> {
    const proc = await this.inner.exec(["bash", "-c", opts.command])
    if (opts.runAsync) {
      this.runtimeProc = proc
      return
    }
    await proc.wait()
  }

  async deleteSession(_sessionId: string): Promise<void> {
    this.runtimeProc = undefined
    try {
      const proc = await this.inner.exec(["bash", "-c", "pkill -f 'workspace-runtime' || true"])
      await proc.wait()
    } catch {}
  }

  async getServiceUrl(port: number): Promise<string> {
    const tunnels = await this.inner.tunnels(30_000)
    const tunnel = tunnels[port]
    if (!tunnel) throw new Error(`No tunnel found for port ${port}`)
    return tunnel.url
  }

  async refreshActivity(): Promise<void> {}

  async start(): Promise<void> {}

  async stop(): Promise<void> {
    await this.inner.terminate()
  }

  async destroy(): Promise<void> {
    await this.inner.terminate()
  }

  async setLabels(labels: Record<string, string>): Promise<void> {
    await this.inner.setTags(labels)
  }
}

/**
 * Create a new Modal sandbox using the shared Docker image from the registry.
 */
export async function createModalSandbox(opts: {
  tokenId: string
  tokenSecret: string
  name?: string
  net?: SandboxNetworkPolicy
}): Promise<ModalSandboxHandle> {
  if (!cachedClient) {
    cachedClient = new ModalClient({
      tokenId: opts.tokenId,
      tokenSecret: opts.tokenSecret,
    })
  }
  const client = cachedClient

  if (!cachedApp) {
    cachedApp = await client.apps.fromName("claxedo", { createIfMissing: true })
  }

  const image = await client.images.fromRegistry(SANDBOX_IMAGE)

  const sandbox = await client.sandboxes.create(cachedApp, image, {
    timeoutMs: 30 * 60 * 1000,
    env: { SHELL: "/bin/bash" },
    encryptedPorts: [RUNTIME_PORT],
    ...(opts.net?.mode === "restricted"
      ? opts.net.cidrs.length > 0
        ? { cidrAllowlist: opts.net.cidrs }
        : { blockNetwork: true }
      : {}),
  })

  log.info("Created Modal sandbox", { sandboxId: sandbox.sandboxId, image: SANDBOX_IMAGE })
  return new ModalSandboxHandle(sandbox, client)
}
