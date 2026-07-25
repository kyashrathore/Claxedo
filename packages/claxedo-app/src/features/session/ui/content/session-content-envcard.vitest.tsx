// Whether the session environment card mounts at all, which is a routing
// question (does this session exist yet?) rather than a card-internal one.
//
// Deliberately a SEPARATE file from `session-content.vitest.tsx`: the assertion
// needs `./session-environment-card` stubbed so the real card's provider graph
// stays out of it, and `vi.mock` is file-scoped-and-hoisted. Adding that stub to
// the sibling file would also silence whatever the real card does there, which
// is how a broken mock stops being visible.
import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { ContentMeta } from "@/features/session/app-ports"
import { SessionContent } from "./session-content"

vi.mock("@/features/session/app-ports", () => ({
  useClaxedoState: () => ({
    meta: { ids: () => [], get: () => undefined },
    layout: { openSession: vi.fn() },
  }),
  useGlobalSync: () => ({ data: { project: [] } }),
  useQueryOptions: () => ({
    projects: () => ({ queryKey: ["projects"], queryFn: () => [] }),
  }),
}))

vi.mock("../components/session-pane-scope", () => ({
  SessionPaneScope: (props: { children: unknown }) => <div>{props.children}</div>,
}))

vi.mock("@/features/session/ui/session-screen", () => ({
  default: () => <div data-testid="session-page" />,
}))

// Stands in for the real card purely so its presence is observable. The card's
// own visibility rules (panel open, pane focus, persisted collapse) are its
// business; this file only asks whether it was mounted.
vi.mock("./session-environment-card", () => ({
  SessionEnvironmentCardMount: () => <div data-testid="envcard-mounted" />,
}))

afterEach(cleanup)

const meta = (sessionId: string | undefined): ContentMeta => ({
  id: "surface-1",
  type: "session",
  scope: "workspace",
  directory: "/work/repo",
  sessionId,
  content: sessionId ? { type: "session", sessionId } : undefined,
}) as ContentMeta

const renderContent = (sessionId: string | undefined) =>
  render(() => <SessionContent meta={meta(sessionId)} ctx={{ paneId: "pane-1", isVisible: () => true }} />)

describe("SessionContent — environment card mounting", () => {
  // The reported bug: the card rode along on the new-session screen, where its
  // rail deep-links to a session's Changes/Files/Processes that do not exist yet.
  test("does not mount the card while the session is still a draft", () => {
    renderContent("new")
    expect(screen.queryByTestId("envcard-mounted")).toBeNull()
    // Guard against passing for the wrong reason: the pane itself must have
    // rendered, or "card absent" would be vacuous.
    expect(screen.getByTestId("session-content")).toBeTruthy()
  })

  // A pane can carry no id at all before the route resolves. That is the same
  // "no session behind this yet" state as `"new"` and must behave identically —
  // `!!id && id !== "new"` open-coded would be easy to get half-right.
  test("does not mount the card when the pane carries no session id", () => {
    renderContent(undefined)
    expect(screen.queryByTestId("envcard-mounted")).toBeNull()
    expect(screen.getByTestId("session-content")).toBeTruthy()
  })

  // The other half of the contract. Without this, deleting the mount entirely
  // would still pass the two tests above.
  test("mounts the card once the session is real", () => {
    renderContent("ses_real")
    expect(screen.getByTestId("envcard-mounted")).toBeTruthy()
  })
})
