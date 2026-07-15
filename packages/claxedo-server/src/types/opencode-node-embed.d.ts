// Hand-maintained type shim for the untyped Bun-built engine artifact
// (`opencode/node-embed` -> packages/opencode/dist/node/node.js). The artifact
// is produced by `bun run build:node` and has no emitted `.d.ts`, so this file
// declares the MINIMAL typed surface a host (claxedo-server) touches. Keep it in
// sync by hand with the real source shapes:
//   - Server.Default()  -> packages/opencode/src/server/server.ts (`Default`)
//   - InstanceRuntime    -> packages/opencode/src/project/instance-runtime.ts
// Only add members here as a host actually consumes them.
declare module "opencode/node-embed" {
  /** Socketless Request -> Response handler over the engine's HTTP API. */
  interface ServerApp {
    /** Handle a request directly (no listening socket). */
    fetch(request: Request): Response | Promise<Response>
    /** Convenience wrapper that builds a Request from url/init then fetch()es. */
    request(input: string | URL | Request, init?: RequestInit): Response | Promise<Response>
  }

  export namespace Server {
    /**
     * Lazy singleton: returns the in-process web handler. Per-directory
     * instances are multiplexed by the `x-opencode-directory` request header.
     */
    function Default(): { app: ServerApp }
  }

  export namespace InstanceRuntime {
    /**
     * Drain surface: disposes all loaded per-directory engine instances
     * (closes background fibers + sqlite handles). Call on host shutdown.
     */
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

    /** Register process-scoped Core tools and return their exact disposer. */
    function register(tools: Readonly<Record<string, Registration>>): Promise<() => Promise<void>>
  }
}
