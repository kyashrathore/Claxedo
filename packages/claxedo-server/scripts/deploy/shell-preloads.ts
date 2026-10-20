import { hostedOperationTable } from "@claxedo/account-contract"

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
 *
 * A workspace route's relay connection is not among them. That read mints a
 * token against the person's sixty-a-minute budget for the workspace, and the
 * app mints none when the tab's own last load or a sibling tab already holds
 * a usable link (the app's relay.ts heldLinks: sessionStorage and a
 * BroadcastChannel per principal). The edge sees only the cookie, so a preload
 * would spend a mint on every reload and every new tab, and the browser issues
 * it whether or not the app ever fetches; flows 13 and 51 forbid both.
 */
const SESSION_READ = "/api/auth/get-session"
const AGENT_CONNECTIONS_READ = "/api/claxedo/agent-config/connections"
const RAIL_SESSION_PAGE = { limit: 5, sort: "human_turn_desc", settled: "active" }
const CORE_OPERATIONS = hostedOperationTable()

function hostedRead(operation: string, input?: Record<string, unknown>) {
  return CORE_OPERATIONS.resolve(operation, input).path
}

/** The reads every signed route makes, in the order the app issues them. */
export function shellPreloadPaths(): string[] {
  return [
    SESSION_READ,
    hostedRead("session.shared.list"),
    hostedRead("workspace.list.provisioner"),
    hostedRead("machines.list"),
    AGENT_CONNECTIONS_READ,
    hostedRead("session.pages", RAIL_SESSION_PAGE),
  ]
}

/** The `Link` header value that preloads the shell's reads as the app's fetches will ask for them. */
export function shellPreloadLinks(): string {
  return shellPreloadPaths().map((path) => `<${path}>; rel=preload; as=fetch; crossorigin=use-credentials`).join(", ")
}
