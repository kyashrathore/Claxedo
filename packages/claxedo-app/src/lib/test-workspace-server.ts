import { QueryClientProvider } from "@tanstack/solid-query"
import { createComponent, createRoot } from "solid-js"
import { createServer, placementId, ServerContext, type ServerHandle } from "@/server"

export type WorkspaceListing = Readonly<Record<string, readonly string[]>>

export type WorkspaceServer = {
  readonly server: ServerHandle
  readonly listing: (dir: string) => ReturnType<ServerHandle["queries"]["files"]["tree"]>
  readonly mount: <T>(build: () => T) => T
  readonly loaded: (dirs: readonly string[]) => Promise<void>
  readonly dispose: () => void
}

export const FIXTURE_PLACEMENT = placementId("ws_1")

const bootstrap = {
  events: { hostAggregate: false },
  deployment: { issuesSessions: false },
  project: [{ id: "proj_1", worktree: "/repo", workspaces: { [FIXTURE_PLACEMENT]: { id: FIXTURE_PLACEMENT, directory: "/repo", reachable: true } } }],
}

function listingOf(listing: WorkspaceListing, dir: string) {
  return (listing[dir] ?? []).map((name) => {
    const path = dir ? `${dir}/${name}` : name
    return { name, path, type: listing[path] ? "directory" : "file" }
  })
}

function openEvents(signal: AbortSignal | null | undefined) {
  const body = new ReadableStream<Uint8Array>({ start: (controller) => signal?.addEventListener("abort", () => controller.close()) })
  return new Response(body, { headers: { "content-type": "text/event-stream" } })
}

function mountUnder<T>(server: ServerHandle, build: () => T, roots: (() => void)[]): T {
  return createRoot((dispose) => {
    roots.push(dispose)
    let built: { readonly value: T } | undefined
    createComponent(ServerContext.Provider, {
      value: server,
      get children() {
        return createComponent(QueryClientProvider, {
          client: server.queryClient,
          get children() {
            built = { value: build() }
            return undefined
          },
        })
      },
    })
    if (!built) throw new Error("the fixture's providers did not render their children")
    return built.value
  })
}

export function createWorkspaceServer(listing: WorkspaceListing): WorkspaceServer {
  const original = globalThis.fetch
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (url.pathname === "/api/claxedo/bootstrap") return Response.json(bootstrap)
    if (url.pathname === "/api/wr/file") return Response.json(listingOf(listing, url.searchParams.get("path") ?? ""))
    if (url.pathname === "/api/cp/events") return openEvents(init?.signal)
    return Response.json({ error: { message: `unexpected ${url.pathname}` } }, { status: 404 })
  }, { preconnect: original.preconnect })
  const server = createServer({ serverUrl: "https://cp.test", auth: { kind: "none" } })
  const roots: (() => void)[] = []
  const tree = (dir: string) => server.queries.files.tree(FIXTURE_PLACEMENT, dir)
  return {
    server,
    listing: tree,
    mount: (build) => mountUnder(server, build, roots),
    loaded: async (dirs) => {
      await Promise.all(dirs.map((dir) => server.queryClient.fetchQuery(tree(dir))))
      await new Promise((resolve) => setTimeout(resolve, 0))
    },
    dispose: () => {
      for (const dispose of roots) dispose()
      server.dispose()
      globalThis.fetch = original
    },
  }
}
