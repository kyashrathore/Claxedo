import { describe, expect, test } from "bun:test"
import { AcpHarnessAdapter, type AcpRuntimeStore } from "../acp"
import { CodexHarnessAdapter } from "../codex"
import { fakeRuntimeStore } from "../../test-utils/fake-runtime-store"
import type { SdkRuntimeStore } from "./sdk-runtime-adapter"

function acpStore(close?: () => void): AcpRuntimeStore {
  return fakeRuntimeStore(close ? { close } : {})
}

function sdkStore(close?: () => void): SdkRuntimeStore {
  return fakeRuntimeStore(close ? { close } : {})
}

describe("adapter store lifecycle", () => {
  test("AcpHarnessAdapter closes adapter-created stores once", () => {
    let closed = 0
    const adapter = new AcpHarnessAdapter({
      binary: "fake-acp",
      harness: "test-acp",
      createStore: () => acpStore(() => {
        closed++
      }),
    })

    adapter.dispose()
    adapter.dispose()

    expect(closed).toBe(1)
  })

  test("AcpHarnessAdapter leaves caller-owned stores open", () => {
    let closed = 0
    const adapter = new AcpHarnessAdapter({
      binary: "fake-acp",
      harness: "test-acp",
      store: acpStore(() => {
        closed++
      }),
    })

    adapter.dispose()

    expect(closed).toBe(0)
  })

  test("CodexHarnessAdapter closes adapter-created stores once", () => {
    let closed = 0
    const adapter = new CodexHarnessAdapter({
      createStore: () => sdkStore(() => {
        closed++
      }),
    })

    adapter.dispose()
    adapter.dispose()

    expect(closed).toBe(1)
  })

  test("CodexHarnessAdapter leaves caller-owned stores open", () => {
    let closed = 0
    const adapter = new CodexHarnessAdapter({
      store: sdkStore(() => {
        closed++
      }),
    })

    adapter.dispose()

    expect(closed).toBe(0)
  })
})
