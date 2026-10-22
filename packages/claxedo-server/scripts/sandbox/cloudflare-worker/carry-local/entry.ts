import type { DurableObjectState } from "@cloudflare/workers-types"
import { run, workspaceContainer, type ContainerExecOptions } from "../src/container-api"
import { RUNTIME_ENTRY } from "../src/runtime-integrity"
import { MEMORY_RUNTIME_ROOT } from "../src/runtime-process"
import type { WorkerEnv } from "../src/worker-env"
import { asWorkerRecord } from "../src/worker-json"
import { WorkspaceSandbox } from "../src/workspace-sandbox"
import { RIG_BOOT_ENV, RIG_PORT } from "./rig"

export { CredentialEgress } from "../src/credential-egress"

type RigEnv = WorkerEnv & { RIG_IMAGE: string }
type LocalContainer = { exec(argv: string[], options?: ContainerExecOptions): Promise<unknown> }

function execs(container: object): container is LocalContainer {
  return "exec" in container && typeof container.exec === "function"
}

/**
 * Local workerd's container has no `images` record, which the
 * `durable_object` scheduling policy adds, and runs unprivileged, so it cannot
 * mount the tmpfs the launch directory must be: the rig names its one image
 * and stands a plain directory in for that mount. Every other call reaches
 * local Docker as the Worker makes it.
 */
function localContainer(container: object, image: string) {
  Object.defineProperty(container, "images", { value: { runtime: image } })
  if (!execs(container)) throw new Error("The local container has no exec")
  const exec = container.exec.bind(container)
  container.exec = (argv, options) => exec(argv[2] === MEMORY_RUNTIME_ROOT ? ["mkdir", "-p", argv[4] ?? ""] : argv, options)
}

export class RigSandbox extends WorkspaceSandbox {
  constructor(ctx: DurableObjectState, env: RigEnv) {
    if (ctx.container) localContainer(ctx.container, env.RIG_IMAGE)
    super(ctx, env)
  }

  async shell(script: string) {
    return await run(workspaceContainer(this.ctx.container), ["sh", "-c", script])
  }
}

type RigStub = Pick<RigSandbox, "ensureWorkspace" | "shell" | "snapshotWorkspace" | "stopWorkspace">

function text(body: Record<string, unknown> | undefined, key: string) {
  const value = body?.[key]
  return typeof value === "string" && value ? value : undefined
}

async function answer(sandbox: RigStub, route: string, body: Record<string, unknown> | undefined) {
  if (route === "/ensure") {
    const restore = text(body, "restore")
    const minimumRuntimeVersion = text(body, "minimumRuntimeVersion")
    return await sandbox.ensureWorkspace({
      command: RUNTIME_ENTRY, env: RIG_BOOT_ENV, port: RIG_PORT, reuseRunning: true,
      ...(restore ? { restore } : {}), ...(minimumRuntimeVersion ? { minimumRuntimeVersion } : {}),
    })
  }
  if (route === "/shell") return await sandbox.shell(text(body, "script") ?? "")
  if (route === "/snapshot") return await sandbox.snapshotWorkspace()
  if (route === "/stop") return { stopped: await sandbox.stopWorkspace(0) }
  throw new Error(`no rig route ${route}`)
}

export default {
  async fetch(request: Request, env: { WORKSPACE_SANDBOX: { getByName(name: string): RigStub } }) {
    try {
      const body = asWorkerRecord(await request.json())
      return Response.json(await answer(env.WORKSPACE_SANDBOX.getByName("carry-rig"), new URL(request.url).pathname, body))
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 500 })
    }
  },
}
