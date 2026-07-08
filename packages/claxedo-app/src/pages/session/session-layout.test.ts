import { beforeEach, describe, expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"

let paneParams:
  | {
      directory: () => string
      sessionId: () => string | undefined
    }
  | undefined
let layoutKeys: unknown[] = []

function layoutKey(key: unknown) {
  if (typeof key !== "function") return key
  return key()
}

mock.module("@claxedo/claxedo-ui/context/session-params", () => ({
  useSessionParams: () => {
    if (paneParams) return paneParams
    throw new Error("outside workbench")
  },
}))

mock.module("@claxedo/utils/encode", () => ({
  base64Decode: (value: string) => value.replace(/^encoded:/, ""),
  base64Encode: (value: string) => `encoded:${value}`,
  checksum: (value: string) => value || undefined,
  hash: async (value: string) => value,
  sampledChecksum: (value: string) => value || undefined,
}))

mock.module("@/context/layout", () => ({
  getAvatarColors: () => ({
    background: "var(--surface-info-base)",
    foreground: "var(--text-base)",
  }),
  useLayout: () => ({
    tabs: (key: unknown) => {
      layoutKeys.push(layoutKey(key))
      return () => []
    },
    view: (key: unknown) => {
      layoutKeys.push(layoutKey(key))
      return () => ({})
    },
  }),
}))

describe("upstream contract", async () => {
  const { useSessionKey } = await import("@claxedo/pages/session/session-layout")

  beforeEach(() => {
    paneParams = undefined
    layoutKeys = []
  })

  test("INTENTIONAL DIVERGENCE: session identity is read from Workbench pane params", () => {
    paneParams = {
      directory: () => "/repo/pane",
      sessionId: () => "pane-session",
    }

    createRoot((dispose) => {
      const result = useSessionKey()

      expect("dir" in result.params).toBe(false)
      expect(result.params.id).toBe("pane-session")
      expect(result.directory()).toBe("/repo/pane")
      expect(result.sessionHref("session-b")).toBe("/s/session-b")
      expect(result.sessionKey()).toBe("workspace:%2Frepo%2Fpane:session:pane-session")
      dispose()
    })
  })
})

describe("Claxedo behavior", async () => {
  const { useSessionLayout } = await import("@claxedo/pages/session/session-layout")

  beforeEach(() => {
    paneParams = {
      directory: () => "/repo/pane-a",
      sessionId: () => "session-a",
    }
    layoutKeys = []
  })

  test("pane directory/session pairs produce distinct layout keys", () => {
    createRoot((dispose) => {
      const result = useSessionLayout()
      expect(result.sessionKey()).toBe("workspace:%2Frepo%2Fpane-a:session:session-a")
      result.tabs()
      result.view()
      expect(layoutKeys).toEqual([
        "workspace:%2Frepo%2Fpane-a:session:session-a",
        "workspace:%2Frepo%2Fpane-a:session:session-a",
      ])
      dispose()
    })

    paneParams = {
      directory: () => "/repo/pane-b",
      sessionId: () => "session-b",
    }
    layoutKeys = []

    createRoot((dispose) => {
      const result = useSessionLayout()
      expect(result.sessionKey()).toBe("workspace:%2Frepo%2Fpane-b:session:session-b")

      result.tabs()
      result.view()
      expect(layoutKeys).toEqual([
        "workspace:%2Frepo%2Fpane-b:session:session-b",
        "workspace:%2Frepo%2Fpane-b:session:session-b",
      ])
      dispose()
    })
  })
})
