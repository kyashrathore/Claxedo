import type { Sandbox } from "@daytonaio/sdk"
import type { SandboxHandle } from "./sandbox-handle"

/**
 * Wraps a Daytona SDK Sandbox into the provider-agnostic SandboxHandle.
 */
export class DaytonaSandboxHandle implements SandboxHandle {
  constructor(public readonly inner: Sandbox) {}

  get id(): string {
    return this.inner.id
  }

  async executeCommand(cmd: string, timeout?: number): Promise<{ result: string }> {
    const res = await this.inner.process.executeCommand(cmd, undefined, undefined, timeout)
    return { result: res.result ?? "" }
  }

  async uploadFile(content: Buffer, remotePath: string): Promise<void> {
    await this.inner.fs.uploadFile(content, remotePath)
  }

  async createSession(sessionId: string): Promise<void> {
    await this.inner.process.createSession(sessionId)
  }

  async executeSessionCommand(
    sessionId: string,
    opts: { command: string; runAsync?: boolean },
  ): Promise<void> {
    await this.inner.process.executeSessionCommand(sessionId, {
      command: opts.command,
      runAsync: opts.runAsync,
    })
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.inner.process.deleteSession(sessionId)
  }

  async getServiceUrl(port: number): Promise<string> {
    try {
      const signed = await this.inner.getSignedPreviewUrl(port, 86400)
      return signed.url
    } catch {}
    const preview = await this.inner.getPreviewLink(port)
    return preview.url
  }

  async refreshActivity(): Promise<void> {
    await this.inner.refreshActivity()
  }

  async start(): Promise<void> {
    await this.inner.start()
  }

  async stop(): Promise<void> {
    await this.inner.stop()
  }

  async destroy(): Promise<void> {
    // Daytona SDK doesn't expose destroy on Sandbox — stop is the equivalent
    await this.inner.stop()
  }

  async setLabels(labels: Record<string, string>): Promise<void> {
    await this.inner.setLabels(labels)
  }
}
