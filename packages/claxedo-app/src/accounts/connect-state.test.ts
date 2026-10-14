/// <reference types="bun" />
import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createConnectState } from "./connect-state"

test("connect form: editing the pasted value or the code drops the refusal the previous value earned, and only that", () => {
  createRoot((dispose) => {
    const state = createConnectState()
    state.pickMethod(1)
    state.fail(new Error("This is an Anthropic API key. Add it under API Key."))
    expect(state.store).toMatchObject({ state: "error", error: "This is an Anthropic API key. Add it under API Key.", methodIndex: 1 })
    state.setValue("sk-ant-oat01-x")
    expect([state.store.value, state.store.error, state.store.state, state.store.methodIndex]).toEqual(["sk-ant-oat01-x", undefined, undefined, 1])
    state.fail(new Error("refused again"))
    state.setCode("abc")
    expect([state.store.code, state.store.value, state.store.error, state.store.state]).toEqual(["abc", "sk-ant-oat01-x", undefined, undefined])
    dispose()
  })
})
