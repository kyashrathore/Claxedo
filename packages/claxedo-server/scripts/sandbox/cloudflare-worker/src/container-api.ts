export type ContainerExecOutput = { stdout: ArrayBuffer; stderr: ArrayBuffer; exitCode: number }

export type ContainerProcess = {
  readonly exitCode: Promise<number>
  output(): Promise<ContainerExecOutput>
}

export type ContainerExecOptions = {
  env?: Record<string, string>
  cwd?: string
  stdout?: "pipe" | "ignore"
  stderr?: "pipe" | "ignore"
}

export type ContainerSnapshot = { id: string; size: number; name?: string }

export type ContainerStart = {
  enableInternet: boolean
  entrypoint: readonly string[]
  instance: string
  /** The main process's environment. A snapshot start passes the image environment recorded when its source started, since a snapshot names no image to take it from. */
  env?: Record<string, string>
} & ({ image: string } | { containerSnapshot: { id: string } })

/**
 * The part of `ctx.container` this Worker drives, under the `durable_object`
 * scheduling policy. The repository's `@cloudflare/workers-types` predates
 * that policy's `images`, `image` and `instance`, so the shape is stated here.
 */
export interface WorkspaceContainer {
  readonly running: boolean
  readonly images: Record<string, string>
  start(options: ContainerStart): void
  monitor(): Promise<void>
  destroy(reason?: unknown): Promise<void>
  exec(argv: string[], options?: ContainerExecOptions): Promise<ContainerProcess>
  getTcpPort(port: number): { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> }
  setInactivityTimeout(durationMs: number): Promise<void>
  interceptOutboundHttps(host: string, binding: unknown): Promise<void>
  snapshotContainer(options: { name?: string }): Promise<ContainerSnapshot>
}

function durableObjectContainer(container: object): container is WorkspaceContainer {
  return "images" in container && "snapshotContainer" in container
}

export function workspaceContainer(container: object | undefined): WorkspaceContainer {
  if (!container || !durableObjectContainer(container)) throw new Error("The container binding is not configured with the durable_object scheduling policy")
  return container
}

const CONTAINER_OPERATION_TIMEOUT_MS = 10_000

export async function bounded<T>(operation: Promise<T>, name: string, timeoutMs = CONTAINER_OPERATION_TIMEOUT_MS) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${name} timed out after ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Runs `argv` to completion and decodes its output; `exec` inherits only `PATH` from the container, so `env` is all it gets besides. */
export async function run(container: WorkspaceContainer, argv: string[], options: Pick<ContainerExecOptions, "env" | "cwd"> = {}) {
  const output = await (await container.exec(argv, options)).output()
  const text = new TextDecoder()
  return { exitCode: output.exitCode, stdout: text.decode(output.stdout), stderr: text.decode(output.stderr) }
}
