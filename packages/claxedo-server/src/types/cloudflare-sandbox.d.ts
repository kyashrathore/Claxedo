declare module "@cloudflare/sandbox" {
  export interface SandboxProcess {
    id: string
    status: "starting" | "running" | "completed" | "failed" | "killed" | "error"
    startTime: Date
    kill(signal?: string): Promise<void>
    getStatus(): Promise<SandboxProcess["status"]>
    getLogs(): Promise<{ stdout: string; stderr: string }>
    waitForPort(port: number, options: {
      mode: "http"
      path: string
      status: { min: number; max: number }
      timeout: number
    }): Promise<void>
  }

  export interface SandboxOperations {
    listProcesses(): Promise<SandboxProcess[]>
    getProcess(id: string): Promise<SandboxProcess | null>
    startProcess(command: string, options: {
      env: Record<string, string>
      processId: string
    }): Promise<SandboxProcess>
    cleanupCompletedProcesses(): Promise<number>
    restoreBackup(backup: { id: string; dir: string }): Promise<unknown>
    createBackup(options: { dir: string; ttl: number; excludes?: string[] }): Promise<{ id: string; dir: string }>
  }

  /** The container lifecycle a subclass extends; both start paths run before the container starts. */
  export interface SandboxDurableObject {
    // `ctx.exports` holds the sandbox Worker's own entrypoints, which only the
    // Worker's generated types would otherwise name.
    readonly ctx: Omit<import("@cloudflare/workers-types").DurableObjectState, "exports"> & {
      readonly exports: {
        CredentialEgress(options: { props: { sandboxId: string } }): import("@cloudflare/workers-types").Fetcher
      }
    }
    start(...args: unknown[]): Promise<void>
    startAndWaitForPorts(...args: unknown[]): Promise<void>
    stop(): Promise<void>
    setKeepAlive(keepAlive: boolean): Promise<void>
    schedule(delaySeconds: number, callback: string): Promise<unknown>
    deleteSchedules(callback: string): void
    containerFetch(request: Request, port: number): Promise<Response>
  }

  // The package ships `Sandbox` as a Durable Object class generic over an env
  // this Worker does not supply. Declaring the process operations here — the
  // one file whose job is to state what this repo believes the untyped module
  // provides — is what lets the Worker subclass it and pass `this` straight to
  // the process helpers.
  export const Sandbox: new (ctx: import("@cloudflare/workers-types").DurableObjectState, env: unknown) => SandboxOperations & SandboxDurableObject
  export function getSandbox(binding: unknown, id: string, options?: {
    containerTimeouts?: {
      instanceGetTimeoutMS?: number
      portReadyTimeoutMS?: number
      waitIntervalMS?: number
    }
  }): any
}
