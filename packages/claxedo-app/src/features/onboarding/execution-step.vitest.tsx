import { createSignal } from "solid-js"
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"
import { ExecutionStep, type ExecutionChoice } from "./execution-step"

function mount(input: { localExecution: boolean; cloudAvailable: boolean; choice?: ExecutionChoice }) {
  const ready: boolean[] = []
  const [choice, setChoice] = createSignal<ExecutionChoice>(input.choice ?? (input.localExecution ? "local" : "cloud"))
  const [cloudAvailable, setCloudAvailable] = createSignal(input.cloudAvailable)
  render(() => (
    <ExecutionStep
      localExecution={input.localExecution}
      cloudAvailable={cloudAvailable()}
      choice={choice()}
      onChoice={setChoice}
      onReady={(value) => ready.push(value)}
    />
  ))
  return { ready, setCloudAvailable }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("ExecutionStep", () => {
  test("unsigned desktop offers local work and connected machines without a cloud option", () => {
    const { ready } = mount({ localExecution: true, cloudAvailable: false })
    expect(screen.getByRole("radio", { name: /Just this machine/ })).toHaveAttribute("aria-checked", "true")
    expect(screen.queryByRole("radio", { name: /A cloud sandbox/ })).toBeNull()
    expect(ready.at(-1)).toBe(true)
  })

  test("signed cloud needs no driver key or driver request", () => {
    const fetch = vi.spyOn(globalThis, "fetch")
    const { ready } = mount({ localExecution: true, cloudAvailable: true })
    fireEvent.click(screen.getByRole("radio", { name: /A cloud sandbox/ }))
    expect(ready.at(-1)).toBe(true)
    expect(screen.getByText(/connected control plane provides the sandbox/)).toBeTruthy()
    expect(screen.queryByLabelText("API key")).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  test("signing out withdraws cloud and makes an existing cloud choice unready", () => {
    const { ready, setCloudAvailable } = mount({ localExecution: true, cloudAvailable: true, choice: "cloud" })
    setCloudAvailable(false)
    expect(screen.queryByRole("radio", { name: /A cloud sandbox/ })).toBeNull()
    expect(ready.at(-1)).toBe(false)
  })

  test("the machine row shows both commands and keeps local Finish available", () => {
    const { ready } = mount({ localExecution: true, cloudAvailable: false, choice: "connected" })
    expect(screen.getByDisplayValue("claxedo host invite --name build-box --root ~/code")).toBeTruthy()
    expect(screen.getByDisplayValue("claxedo connect --token-file ./invite.txt --install-service")).toBeTruthy()
    expect(ready.at(-1)).toBe(true)
  })

  test("the signed hosted plane offers cloud and cannot finish on a connected machine", () => {
    const { ready } = mount({ localExecution: false, cloudAvailable: true })
    expect(screen.queryByRole("radio", { name: /Just this machine/ })).toBeNull()
    expect(ready.at(-1)).toBe(true)
    fireEvent.click(screen.getByRole("radio", { name: /Another machine/ }))
    expect(ready.at(-1)).toBe(false)
    expect(screen.getByText(/Nothing can send this repository to a machine you connect yet/)).toBeTruthy()
  })
})
