import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"

const fixture = vi.hoisted(() => ({
  opened: true,
  runnable: {} as Record<string, boolean>,
  connected: {} as Record<string, string[]>,
  machineProviders: 0,
}))

vi.mock("@/features/onboarding/app-ports", () => ({
  MachineAccountsProvider: (props: { children?: unknown }) => {
    fixture.machineProviders += 1
    return props.children
  },
  useMachineAccounts: () => ({
    opened: () => fixture.opened,
    runnable: (check: { id: string }) => fixture.runnable[check.id] ?? false,
  }),
  AgentHarnessAccounts: (props: { harness: { id: string } }) => <div data-harness-row={props.harness.id} />,
  HarnessProvidersSection: (props: { harness: string }) => <div data-providers-section={props.harness} />,
  useProviders: (harness: string) => ({
    connected: () => (fixture.connected[harness] ?? []).map((id) => ({ id, name: id })),
  }),
}))

const { AiStep } = await import("./ai-step")

function mount(localExecution: boolean) {
  const ready: boolean[] = []
  render(() => <AiStep localExecution={localExecution} onReady={(value) => ready.push(value)} />)
  return ready
}

const harnessRows = () => [...document.querySelectorAll("[data-harness-row]")].map((node) => node.getAttribute("data-harness-row"))
const sections = () => [...document.querySelectorAll("[data-providers-section]")].map((node) => node.getAttribute("data-providers-section"))
const choices = () => [...document.querySelectorAll("[data-harness-choice]")].map((node) => node.getAttribute("data-harness-choice"))

afterEach(() => {
  fixture.opened = true
  fixture.runnable = {}
  fixture.connected = {}
  fixture.machineProviders = 0
  cleanup()
})

describe("AiStep on the hosted plane", () => {
  test("draws the Models page's Pi provider list alone, with no machine to scan and nothing else to choose", () => {
    const ready = mount(false)
    expect(sections()).toEqual(["pi"])
    expect(harnessRows()).toEqual([])
    expect(choices()).toEqual([])
    expect(fixture.machineProviders).toBe(0)
    expect(ready.at(-1)).toBe(false)
  })

  test("is ready once a Pi provider is connected", () => {
    fixture.connected = { pi: ["anthropic"] }
    expect(mount(false).at(-1)).toBe(true)
  })
})

describe("AiStep on a desktop", () => {
  test("one loader stands for the whole scan, then every harness on this machine has its row", () => {
    fixture.opened = false
    mount(true)
    expect(document.querySelector('[data-slot="onboarding-ai-scanning"]')).toBeTruthy()
    expect(harnessRows()).toEqual([])
    expect(fixture.machineProviders).toBe(1)
    cleanup()

    fixture.opened = true
    mount(true)
    expect(document.querySelector('[data-slot="onboarding-ai-scanning"]')).toBeNull()
    expect(harnessRows()).toEqual(["claude", "codex", "cursor"])
  })

  test("the catalog harnesses are offered as a choice, and the chosen one's provider list opens in place", () => {
    mount(true)
    expect(choices()).toEqual(["pi", "opencode"])
    expect(sections()).toEqual([])

    fireEvent.click(screen.getByRole("button", { name: "Pi" }))
    expect(sections()).toEqual(["pi"])
    expect(screen.getByRole("button", { name: "Pi" }).getAttribute("aria-pressed")).toBe("true")

    fireEvent.click(screen.getByRole("button", { name: "OpenCode" }))
    expect(sections()).toEqual(["opencode"])
    expect(screen.getByRole("button", { name: "Pi" }).getAttribute("aria-pressed")).toBe("false")

    fireEvent.click(screen.getByRole("button", { name: "OpenCode" }))
    expect(sections()).toEqual([])
  })

  test("is ready when a harness can run or a catalog provider is connected, opened or not", () => {
    expect(mount(true).at(-1)).toBe(false)
    cleanup()

    fixture.runnable = { codex: true }
    expect(mount(true).at(-1)).toBe(true)
    cleanup()

    fixture.runnable = {}
    fixture.connected = { opencode: ["anthropic"] }
    const ready = mount(true)
    expect(sections()).toEqual([])
    expect(ready.at(-1)).toBe(true)
  })
})
