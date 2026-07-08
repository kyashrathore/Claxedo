import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { emptyClaxedoState } from "../persistence"
import { createMetadataSlice } from "../metadata"

describe("state/metadata", () => {
  test("notifies observers after metadata changes", () => {
    const [state, setState] = createStore(emptyClaxedoState())
    const observed: string[][] = []
    const meta = createMetadataSlice({
      state,
      setState,
      onChange: (metas) => observed.push(metas.map((item) => item.id)),
    })

    meta.upsert({
      id: "session_1",
      type: "session",
      scope: "directory",
      directory: "/work",
      sessionId: "ses_1",
      content: {
        type: "session",
        directory: "/work",
        sessionId: "ses_1",
        title: "Session",
      },
    })
    meta.patch("session_1", { directory: "/worktree" })
    meta.remove("session_1")

    expect(observed).toEqual([
      [],
      ["session_1"],
      ["session_1"],
      [],
    ])
  })

  test("ids accessor reflects dynamic metadata keys", () => {
    createRoot((dispose) => {
      const [state, setState] = createStore(emptyClaxedoState())
      const meta = createMetadataSlice({ state, setState })

      expect(meta.ids()).toEqual([])

      meta.upsert({
        id: "session_1",
        type: "session",
        scope: "directory",
        directory: "/work",
        sessionId: "new",
        content: {
          type: "session",
          directory: "/work",
          sessionId: "new",
          title: "New Session",
        },
      })

      expect(meta.ids()).toEqual(["session_1"])

      meta.remove("session_1")

      expect(meta.ids()).toEqual([])
      dispose()
    })
  })
})
