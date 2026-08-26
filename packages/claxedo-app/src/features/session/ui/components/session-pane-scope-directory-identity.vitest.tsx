/**
 * Pins the invariant that `SessionPaneScope` hands ONE directory string to both
 * halves of a session pane: the string `sessionParams.directory()` returns is
 * the same string that reaches `DirectoryScope`, and therefore `sdk.directory`.
 *
 * Why that identity has to hold rather than merely happening to hold:
 *
 * - `sessionParams.directory()` is what `session-screen.tsx` memoizes as
 *   `routeDirectory` and re-exports as `dir` (`const dir = routeDirectory`).
 *   `dir()` is what mounts `SessionConversationOwner` and what the composer
 *   receives as `sessionDirectory`.
 * - The pane's own directory is what `DirectoryScope` spends: it keys
 *   `sdk.createClient({ directory })`, the SDK/prefetch scope keys, and the
 *   `directorySessionCacheQueryOptions` / `sessionLoadMetaKey` lookups that
 *   decide which cached session list the pane is allowed to read.
 *
 * So if the two ever diverge, nothing throws — the pane mounts the conversation
 * registry and the composer in one directory scope while the transport, the
 * prefetch key and the session cache all live in another. Messages would be
 * written to and read from a scope the SDK client never talks to.
 *
 * This is the invariant that made `const dir = routeDirectory` correct when
 * d21dfbd8 removed the `resolveSessionDirectory` re-derivation: because the two
 * values are the same by construction, re-deriving one could only ever mint a
 * SECOND scope, never repair a wrong one. That commit deleted the helper's
 * tests along with the helper, leaving the invariant implicit; this file is what
 * now holds it, so a future change to `SessionPaneScope`'s directory plumbing
 * fails here instead of silently splitting the pane in two.
 */
import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"
import { SessionPaneScope } from "./session-pane-scope"
import { useSessionParams } from "@/features/session/providers/session-params"

const calls = vi.hoisted(() => ({
  directoryScopeDirectory: undefined as string | undefined,
}))

vi.mock("@/features/session/app-ports", () => ({
  DirectoryScope: (props: { directory: string; children: unknown }) => {
    calls.directoryScopeDirectory = props.directory
    return <div data-testid="directory-scope" data-directory={props.directory}>{props.children}</div>
  },
  isWorkspaceReady: () => true,
  PaneIdProvider: (props: { children: unknown }) => <>{props.children}</>,
  useGlobalSDK: () => ({ url: "http://localhost:4096" }),
  useShellQueryOptions: () => ({
    projects: () => ({ queryKey: ["projects"], queryFn: async () => [] }),
  }),
  useWorkspaceScopeRegistryOptional: () => undefined,
  WorkspaceGate: (props: { children: unknown }) => <>{props.children}</>,
}))

vi.mock("../../data/sync/directory-session-cache", () => ({
  useDirectorySessionCacheActions: () => ({ refresh: vi.fn() }),
}))

vi.mock("@/platform/runtime/platform-provider", () => ({
  usePlatform: () => ({ fetch }),
}))

vi.mock("@tanstack/solid-query", () => ({
  useQuery: () => ({ data: [] }),
}))

// Stands in for what `session-screen.tsx` reads:
// `const routeDirectory = createMemo(() => sessionParams.directory())`.
function RouteDirectoryProbe() {
  const sessionParams = useSessionParams()
  return <div data-testid="route-directory" data-value={sessionParams.directory()} />
}

afterEach(() => {
  calls.directoryScopeDirectory = undefined
  cleanup()
})

describe("SessionPaneScope directory identity", () => {
  for (const directory of ["/work/repo", "ws_cloud", "workspace:ws_cloud", "/workspace"]) {
    test(`routeDirectory and sdk.directory are the same value for ${JSON.stringify(directory)}`, () => {
      render(() => (
        <SessionPaneScope directory={directory} sessionId={() => "ses_1"} paneId={() => "pane-1"}>
          <RouteDirectoryProbe />
        </SessionPaneScope>
      ))

      // sessionParams.directory() — session-screen's `routeDirectory`, now also its `dir`.
      expect(screen.getByTestId("route-directory")).toHaveAttribute("data-value", directory)
      // DirectoryScope's `directory` — becomes WorkspaceSDKProvider's dir, i.e. `sdk.directory`.
      expect(calls.directoryScopeDirectory).toBe(directory)
    })
  }

  // The directoryless Pi case, where `session-content.tsx` resolves the pane
  // directory to `""`. This is the case most likely to tempt a future
  // re-derivation, because `""` looks like a missing value that ought to be
  // filled in from `sessionRef.cwd` or the inventory. It must not be:
  // `SessionPaneScope` keys its gate on `workspaceKey()`, which falls back to
  // the sessionRef's id, so the pane mounts and BOTH sides see the same `""`.
  // Substituting a "better" directory on one side is exactly the split this
  // file exists to catch.
  test("directoryless central session still shares the empty directory", () => {
    render(() => (
      <SessionPaneScope
        directory=""
        sessionRef={() => ({ sessionId: "ses_pi", host: "central", harness: { id: "pi" }, toolSandbox: { kind: "virtual" } })}
        paneId={() => "pane-1"}
      >
        <RouteDirectoryProbe />
      </SessionPaneScope>
    ))

    expect(screen.getByTestId("route-directory")).toHaveAttribute("data-value", "")
    expect(calls.directoryScopeDirectory).toBe("")
  })
})
