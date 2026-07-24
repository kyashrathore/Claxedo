declare module "opencode/node-embed" {
  interface ServerApp {
    fetch(request: Request): Response | Promise<Response>
  }

  export namespace Server {
    function Default(): { app: ServerApp }
  }

  export namespace InstanceRuntime {
    function disposeAllInstances(): Promise<void>
  }

  export namespace ApplicationToolRuntime {
    type Registration = Readonly<{
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

    function register(tools: Readonly<Record<string, Registration>>): Promise<() => Promise<void>>
  }
}
