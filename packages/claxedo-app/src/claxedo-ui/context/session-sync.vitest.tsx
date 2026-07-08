import { cleanup, render } from "@solidjs/testing-library"
import { createEffect } from "solid-js"
import { afterEach, describe, expect, test, vi } from "vitest"
import { SessionSyncProvider, useSessionSyncOptional } from "./session-sync"

describe("SessionSync", () => {
  afterEach(() => cleanup())

  test("provider passes the sync callback through", () => {
    const syncSession = vi.fn()
    render(() => (
      <SessionSyncProvider syncSession={syncSession}>
        <Probe sessionID="ses_1" />
      </SessionSyncProvider>
    ))

    expect(syncSession).toHaveBeenCalledWith("ses_1")
  })

  test("optional hook returns undefined outside the provider", () => {
    let value: ReturnType<typeof useSessionSyncOptional> | "unset" = "unset"
    render(() => {
      value = useSessionSyncOptional()
      return <div />
    })

    expect(value).toBeUndefined()
  })
})

function Probe(props: { sessionID: string }) {
  const sessionSync = useSessionSyncOptional()
  createEffect(() => sessionSync?.syncSession?.(props.sessionID))
  return <div />
}
