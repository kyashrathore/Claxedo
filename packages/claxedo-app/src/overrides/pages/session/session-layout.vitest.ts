import { describe, expect, test, vi, beforeEach } from "vitest"
import { createRoot } from "solid-js"

// ---------------------------------------------------------------------------
// Mocks — must be defined before importing the module under test
// ---------------------------------------------------------------------------

let mockSessionParams: { sessionId: () => string | undefined; directory: () => string } | undefined
let mockClaxedoLayout: { groupTabs: (id: string) => { active: () => any } } | undefined
let mockGroupId: string | undefined

vi.mock("@claxedo/claxedo-ui/context/session-params", () => ({
  useSessionParams: () => {
    if (!mockSessionParams) throw new Error("not in split mode")
    return mockSessionParams
  },
}))

vi.mock("@claxedo/claxedo-ui/context/claxedo-layout", () => ({
  useClaxedoLayout: () => {
    if (!mockClaxedoLayout) throw new Error("not in claxedo mode")
    return mockClaxedoLayout
  },
}))

vi.mock("@claxedo/claxedo-ui/context/group-id", () => ({
  useGroupId: () => mockGroupId,
}))

vi.mock("@opencode-ai/util/encode", () => ({
  base64Encode: (v: string) => `b64:${v}`,
}))

vi.mock("@/context/layout", () => ({
  useLayout: () => ({
    tabs: () => [],
    view: () => ({}),
  }),
}))

import { useSessionKey } from "./session-layout"

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockSessionParams = undefined
  mockClaxedoLayout = undefined
  mockGroupId = undefined
})

describe("useSessionKey — session ID resolution (regression: empty sessionID in split mode)", () => {
  test("returns sessionId from useSessionParams when available", () => {
    mockSessionParams = {
      sessionId: () => "ses_from_params",
      directory: () => "/projects/foo",
    }

    createRoot((dispose) => {
      const { params } = useSessionKey()
      expect(params.id).toBe("ses_from_params")
      expect(params.dir).toBe("b64:/projects/foo")
      dispose()
    })
  })

  test("falls back to claxedoLayout group tab when sessionParams unavailable", () => {
    mockClaxedoLayout = {
      groupTabs: (id: string) => ({
        active: () => ({
          directory: "/projects/bar",
          sessionId: "ses_from_group",
        }),
      }),
    }
    mockGroupId = "group-1"

    createRoot((dispose) => {
      const { params } = useSessionKey()
      expect(params.id).toBe("ses_from_group")
      expect(params.dir).toBe("b64:/projects/bar")
      dispose()
    })
  })

  test("returns undefined when no context is available (no split, no group)", () => {
    // All contexts throw/return undefined — this is the route-level case
    createRoot((dispose) => {
      const { params } = useSessionKey()
      expect(params.id).toBeUndefined()
      expect(params.dir).toBeUndefined()
      dispose()
    })
  })

  test("sessionParams takes priority over fallbackGroup", () => {
    mockSessionParams = {
      sessionId: () => "ses_from_params",
      directory: () => "/projects/foo",
    }
    mockClaxedoLayout = {
      groupTabs: () => ({
        active: () => ({
          directory: "/projects/bar",
          sessionId: "ses_from_group",
        }),
      }),
    }
    mockGroupId = "group-1"

    createRoot((dispose) => {
      const { params } = useSessionKey()
      expect(params.id).toBe("ses_from_params")
      expect(params.dir).toBe("b64:/projects/foo")
      dispose()
    })
  })

  test("returns undefined id when group has no active tab", () => {
    mockClaxedoLayout = {
      groupTabs: () => ({
        active: () => undefined,
      }),
    }
    mockGroupId = "group-1"

    createRoot((dispose) => {
      const { params } = useSessionKey()
      expect(params.id).toBeUndefined()
      dispose()
    })
  })

  test("returns undefined id when claxedoLayout exists but no groupId", () => {
    mockClaxedoLayout = {
      groupTabs: () => ({
        active: () => ({
          directory: "/projects/bar",
          sessionId: "ses_from_group",
        }),
      }),
    }
    // mockGroupId remains undefined

    createRoot((dispose) => {
      const { params } = useSessionKey()
      expect(params.id).toBeUndefined()
      dispose()
    })
  })

  test("sessionKey combines dir and id", () => {
    mockSessionParams = {
      sessionId: () => "ses_123",
      directory: () => "/projects/foo",
    }

    createRoot((dispose) => {
      const { sessionKey } = useSessionKey()
      expect(sessionKey()).toBe("b64:/projects/foo/ses_123")
      dispose()
    })
  })

  test("sessionKey omits id suffix when no session", () => {
    mockSessionParams = {
      sessionId: () => undefined,
      directory: () => "/projects/foo",
    }

    createRoot((dispose) => {
      const { sessionKey } = useSessionKey()
      expect(sessionKey()).toBe("b64:/projects/foo")
      dispose()
    })
  })

  test("REGRESSION: params.id must never be empty string", () => {
    // The original bug: useParams() returned {} in split mode, so params.id
    // was undefined but SessionTurn received "" via `sessionID ?? ""`.
    // Our override must return undefined (not "") so callers can detect "no session".
    createRoot((dispose) => {
      const { params } = useSessionKey()
      expect(params.id).not.toBe("")
      dispose()
    })
  })
})
