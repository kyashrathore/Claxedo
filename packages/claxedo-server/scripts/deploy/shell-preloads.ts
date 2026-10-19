import { resolveHostedOperation } from "@claxedo/account-contract"

/**
 * The reads a signed-in browser app makes before it can draw, named so the
 * shell's response can carry them as `Link: rel=preload` and they leave while
 * `main.js` downloads instead of after it evaluates. The browser hands each
 * preloaded response to the app's own later fetch, so nothing is read twice:
 * the app fetches every one of these with `credentials: "include"`, which only a
 * `crossorigin=use-credentials` preload matches (Chromium refuses the match and
 * fetches again on any other credentials mode).
 *
 * The rail reads the first page of each project's sessions: five rows, newest
 * human turn first, settled sessions hidden. The e2e flow 12-boot-reads holds
 * this list against the app's real boot, so a read the app drops or reshapes
 * fails there.
 */
const SESSION_READ = "/api/auth/get-session"
const AGENT_CONNECTIONS_READ = "/api/claxedo/agent-config/connections"
const RAIL_SESSION_PAGE = { limit: 5, sort: "human_turn_desc", settled: "active" }

const WORKSPACE_ROUTE = /^\/w\/([^/]+)(?:\/|$)/

function hostedRead(operation: string, input?: Record<string, unknown>) {
  return resolveHostedOperation(operation, input).path
}

/** The reads every signed route makes, in the order the app issues them. */
function signedReads(): string[] {
  return [
    SESSION_READ,
    hostedRead("session.shared.list"),
    hostedRead("workspace.list.provisioner"),
    hostedRead("machines.list"),
    AGENT_CONNECTIONS_READ,
    hostedRead("session.pages", RAIL_SESSION_PAGE),
  ]
}

/** The reads the shell at `pathname` makes once signed in: a workspace route also reads its relay connection. */
export function shellPreloadPaths(pathname: string): string[] {
  const workspace = WORKSPACE_ROUTE.exec(pathname)?.[1]
  if (workspace === undefined) return signedReads()
  return [...signedReads(), hostedRead("workspace.connection.read", { id: decodeURIComponent(workspace) })]
}

/** The `Link` header value that preloads the shell's reads as the app's fetches will ask for them. */
export function shellPreloadLinks(pathname: string): string {
  return shellPreloadPaths(pathname).map((path) => `<${path}>; rel=preload; as=fetch; crossorigin=use-credentials`).join(", ")
}
