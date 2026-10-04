import { describe, expect, test } from "bun:test"
import { liveListState } from "./list-state"

const refused = { class: "forbidden", message: "Live plugins belong to this machine's owner", retryable: false, status: 403 } as const

describe("the live plugin list", () => {
  test("a server that does not offer live plugins to this connection lists none", () => {
    expect(liveListState({ offered: false, listed: false, error: null })).toEqual({ kind: "notOffered" })
  })

  test("a refusal means the plugins are the machine owner's, not a failure to show", () => {
    expect(liveListState({ offered: true, listed: false, error: refused })).toEqual({ kind: "notOwner" })
  })

  test("any other failure is shown with its reason", () => {
    expect(liveListState({ offered: true, listed: false, error: { class: "network", message: "offline", retryable: true } })).toEqual({ kind: "failed", reason: "offline" })
  })

  test("a list that answered is listed", () => {
    expect(liveListState({ offered: true, listed: true, error: null })).toEqual({ kind: "listed" })
    expect(liveListState({ offered: true, listed: false, error: null })).toEqual({ kind: "loading" })
  })
})
