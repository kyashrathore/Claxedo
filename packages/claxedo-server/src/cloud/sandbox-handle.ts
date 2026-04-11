/**
 * Provider-agnostic sandbox interface.
 *
 * All provider adapters (Daytona, Vercel, Cloudflare) implement this
 * so that sandbox-runtime.ts and workspace-supervisor.ts can work
 * with any sandbox provider without coupling to a specific SDK.
 */

import type { SandboxNetworkPolicy } from "../network/resolve"

export interface SandboxHandle {
  /** Unique sandbox identifier from the provider. */
  readonly id: string

  /** Execute a command in the sandbox and return stdout. */
  executeCommand(cmd: string, timeout?: number): Promise<{ result: string }>

  /** Upload a file into the sandbox filesystem. */
  uploadFile(content: Buffer, remotePath: string): Promise<void>

  /** Create a named process session (for long-running processes). */
  createSession(sessionId: string): Promise<void>

  /** Run a command in an existing session (optionally async/detached). */
  executeSessionCommand(
    sessionId: string,
    opts: { command: string; runAsync?: boolean },
  ): Promise<void>

  /** Destroy a process session. */
  deleteSession(sessionId: string): Promise<void>

  /** Get a publicly-accessible URL for a port running in the sandbox. */
  getServiceUrl(port: number): Promise<string>

  /** Heartbeat — tell the provider this sandbox is still in use. */
  refreshActivity(): Promise<void>

  /** Start a stopped sandbox. */
  start(): Promise<void>

  /** Stop the sandbox (preserves state for later restart). */
  stop(): Promise<void>

  /** Permanently destroy the sandbox and release all resources. */
  destroy(): Promise<void>

  /** Set provider-specific labels/tags on the sandbox. */
  setLabels(labels: Record<string, string>): Promise<void>

  /** Update outbound network access rules when the provider supports it. */
  setNetworkPolicy?(policy?: SandboxNetworkPolicy): Promise<void>
}
