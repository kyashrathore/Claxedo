declare module "@cloudflare/sandbox" {
  export interface SandboxProcess {
    id: string
    status: "starting" | "running" | "completed" | "failed" | "killed" | "error"
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
    startProcess(command: string, options: {
      env: Record<string, string>
      processId: string
    }): Promise<SandboxProcess>
    cleanupCompletedProcesses(): Promise<number>
  }

  export const ContainerProxy: unknown
  // The package ships `Sandbox` as a Durable Object class generic over an env
  // this Worker does not supply. Declaring the process operations here — the
  // one file whose job is to state what this repo believes the untyped module
  // provides — is what lets the Worker subclass it and pass `this` straight to
  // the process helpers.
  export const Sandbox: new (...args: never[]) => SandboxOperations
  export function getSandbox(binding: unknown, id: string, options?: {
    containerTimeouts?: {
      instanceGetTimeoutMS?: number
      portReadyTimeoutMS?: number
      waitIntervalMS?: number
    }
  }): any
}
