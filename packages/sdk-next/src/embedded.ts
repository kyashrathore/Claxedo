/// <reference path="./opencode-node-embed.d.ts" />

export type ApplicationToolRegistration = Readonly<{
  description: string
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  execute(
    input: unknown,
    context: Readonly<{
      sessionID: string
      agent: string
      assistantMessageID: string
      toolCallID: string
    }>,
  ): Promise<unknown>
}>

export type EmbeddedModule = typeof import("opencode/node-embed")

export type EmbeddedHost = Readonly<{
  fetch(request: Request): Promise<Response> | Response
  dispose(): Promise<void>
}>

export async function createEmbeddedHost(options: {
  load?: () => Promise<EmbeddedModule>
  applicationTools?: () => Promise<Readonly<Record<string, ApplicationToolRegistration>>>
} = {}): Promise<EmbeddedHost> {
  const module = await (options.load ?? (() => import("opencode/node-embed")))()
  const handler = module.Server.Default().app.fetch
  const disposeTools = options.applicationTools
    ? await module.ApplicationToolRuntime.register(await options.applicationTools())
    : undefined
  let disposed = false

  return {
    fetch(request) {
      if (disposed) throw new Error("The embedded OpenCode host has been disposed")
      return handler(request)
    },
    async dispose() {
      if (disposed) return
      disposed = true
      const failures = (await Promise.allSettled([
        disposeTools?.() ?? Promise.resolve(),
        module.InstanceRuntime.disposeAllInstances(),
      ])).filter((result): result is PromiseRejectedResult => result.status === "rejected")
      if (failures.length) {
        throw new AggregateError(
          failures.map((failure) => failure.reason),
          "Embedded OpenCode disposal failed",
        )
      }
    },
  }
}
