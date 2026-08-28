import { WORKGRAPH_SERVICE_CRONS } from "./constants"
import {
  WorkGraphServiceLifecycleError,
  readWorkGraphServiceLifecycle,
  type WorkGraphServiceLifecycleInput,
} from "./service"

async function mayRun(input: WorkGraphServiceLifecycleInput) {
  return (await readWorkGraphServiceLifecycle(input))?.state === "enabled"
}

function runtimeUnavailable(surface: string) {
  return new WorkGraphServiceLifecycleError(
    "runtime_unavailable",
    `${surface} cannot run until the WorkGraph D1 runtime is installed`,
  )
}

abstract class WorkGraphDarkDurableObjectRuntime {
  constructor(private readonly input: WorkGraphServiceLifecycleInput) {}

  protected abstract readonly surface: string

  async fetch(request: Request) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/nudge") {
      return new Response("Not Found", { status: 404 })
    }
    if (!(await mayRun(this.input))) {
      return Response.json({ error: { code: "service_disabled" } }, { status: 409 })
    }
    throw runtimeUnavailable(this.surface)
  }

  async alarm() {
    if (!(await mayRun(this.input))) return
    throw runtimeUnavailable(this.surface)
  }
}

export class WorkGraphSettlerRuntime extends WorkGraphDarkDurableObjectRuntime {
  protected readonly surface = "WorkGraph settlement"
}

export class WorkGraphWakeLaneRuntime extends WorkGraphDarkDurableObjectRuntime {
  protected readonly surface = "WorkGraph wake processing"
}

export async function runWorkGraphServiceScheduled(cron: string, input: WorkGraphServiceLifecycleInput) {
  if (!(WORKGRAPH_SERVICE_CRONS as readonly string[]).includes(cron)) {
    throw new WorkGraphServiceLifecycleError("invalid_request", `unknown WorkGraph cron: ${cron}`)
  }
  if (!(await mayRun(input))) return
  throw runtimeUnavailable(`WorkGraph ${cron} cron`)
}
