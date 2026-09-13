import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { ComponentProps, JSX } from "solid-js"
import { AgentHarnessRow, type AgentAccount } from "./agent-harness-row"

// Kobalte's dropdown needs a real pointer stack to open. The shim renders the
// menu's items inline so the wiring behind Check now and Remove is the thing
// under test rather than the overlay that reveals them.
vi.mock("@opencode-ai/ui/dropdown-menu", () => {
  const Root = (props: { children: JSX.Element }) => <div data-testid="account-menu">{props.children}</div>
  const Trigger = (props: Record<string, unknown> & { children: JSX.Element }) => (
    <button type="button" {...props}>{props.children}</button>
  )
  const Portal = (props: { children: JSX.Element }) => <>{props.children}</>
  const Content = (props: { children: JSX.Element }) => <div>{props.children}</div>
  const Item = (props: { children: JSX.Element; onSelect?: () => void; disabled?: boolean } & Record<string, unknown>) => (
    <button type="button" {...props} onClick={() => props.onSelect?.()}>{props.children}</button>
  )
  return { DropdownMenu: Object.assign(Root, { Trigger, Portal, Content, Item }) }
})

vi.mock("@opencode-ai/ui/provider-icon", () => ({ ProviderIcon: () => null }))

vi.mock("@/features/settings/app-ports", () => ({
  ProviderConnectForm: (props: { provider: string; credentialId?: string }) => (
    <div data-testid="connect-form" data-provider={props.provider} data-credential={props.credentialId ?? ""} />
  ),
}))

vi.mock("@/platform/i18n/provider", () => ({
  useLanguage: () => ({
    t: (key: string, vars?: Record<string, string>) => (vars ? `${key}:${Object.values(vars).join("|")}` : key),
  }),
}))

afterEach(cleanup)

const account = (over: Partial<AgentAccount> = {}): AgentAccount => ({
  key: "cred_1",
  ids: ["cred_1"],
  label: "work@acme.com",
  tone: "success",
  status: "Working",
  selected: true,
  ...over,
})

function row(extra: Partial<ComponentProps<typeof AgentHarnessRow>> = {}) {
  return render(() => (
    <AgentHarnessRow
      id="anthropic"
      name="Claude Code"
      providerId="claude-sdk"
      harness="claude"
      header={{ tone: "success", sentence: "Using work@acme.com · Working" }}
      accounts={[account()]}
      onSelect={() => undefined}
      onCheck={() => undefined}
      onRemove={() => undefined}
      {...extra}
    />
  ))
}

function entries() {
  return [...document.querySelectorAll<HTMLElement>('[data-component="agent-account"]')]
    .map((node) => node.getAttribute("data-account") ?? "")
}

function entry(key: string) {
  const found = document.querySelector<HTMLElement>(`[data-component="agent-account"][data-account="${key}"]`)
  if (!found) throw new Error(`no entry for ${key}`)
  return found
}

describe("AgentHarnessRow header", () => {
  test("says what the harness runs on in one sentence, with one dot and no action", () => {
    row()

    const header = document.querySelector('[data-component="agent-header-status"]')!
    expect(header.textContent).toBe("Using work@acme.com · Working")
    expect(header.querySelectorAll('[data-component="agent-status-dot"]')).toHaveLength(1)
    expect(header.querySelector('[data-component="agent-status-dot"]')?.getAttribute("data-tone")).toBe("success")
    expect(document.querySelector('[data-component="provider-actions"] button')).toBeNull()
  })

  test("a harness with nothing set up offers Connect and nothing else", () => {
    row({ header: { tone: "neutral", sentence: "Not set up", action: { kind: "connect" } }, accounts: [] })

    const actions = document.querySelectorAll('[data-component="provider-actions"] button')
    expect(actions).toHaveLength(1)
    expect(actions[0].textContent).toBe("common.connect")

    fireEvent.click(actions[0])

    expect(screen.getByTestId("connect-form").dataset.credential).toBe("")
  })

  test("a rejected account in use offers Reconnect, which opens the card on that same row", () => {
    row({
      header: {
        tone: "danger",
        sentence: "Old key is rejected by Anthropic. Reconnect or pick another account.",
        action: { kind: "reconnect", credentialId: "cred_1" },
      },
    })

    const actions = document.querySelectorAll('[data-component="provider-actions"] button')
    expect(actions).toHaveLength(1)
    expect(actions[0].textContent).toBe("settings.providers.agents.reconnectAccount")
    expect(document.querySelector('[data-component="agent-header-status"] [data-component="agent-status-dot"]')
      ?.getAttribute("data-tone")).toBe("danger")

    fireEvent.click(actions[0])

    expect(screen.getByTestId("connect-form").dataset.credential).toBe("cred_1")
    expect(document.querySelector('[data-component="provider-connect-card"]')?.getAttribute("data-credential"))
      .toBe("cred_1")
  })
})

describe("AgentHarnessRow accounts", () => {
  test("the checked radio is the account in use, and choosing another reports its rows", () => {
    const chosen: string[][] = []
    row({
      accounts: [
        account({ key: "cred_1", ids: ["cred_1", "acp_1"], selected: true }),
        account({ key: "cred_2", ids: ["cred_2"], label: "home@acme.com", selected: false }),
      ],
      onSelect: (item) => void chosen.push([...item.ids]),
    })

    const radios = document.querySelectorAll<HTMLInputElement>('[data-action="agent-account-select"]')
    expect([...radios].map((input) => input.checked)).toEqual([true, false])
    expect([...radios].map((input) => input.name)).toEqual(["agent-account-claude", "agent-account-claude"])

    fireEvent.click(radios[1])

    expect(chosen).toEqual([["cred_2"]])
  })

  test("this computer's login is an entry of the same list, named by where it was read from", () => {
    row({
      accounts: [
        account({ key: "cred_1", selected: true }),
        account({ key: "machine", ids: [], label: "This computer's login", source: "from ~/.codex", selected: false, machine: true }),
      ],
    })

    expect(entries()).toEqual(["cred_1", "machine"])
    expect(entry("machine").textContent).toContain("from ~/.codex")
    // Nothing is stored for it yet, so there is nothing to check or forget.
    expect(entry("machine").querySelector('[data-action="agent-account-menu"]')).toBeNull()
  })

  test("an entry carries no button at rest: its actions live behind the overflow menu", () => {
    const checked: string[][] = []
    row({ onCheck: (ids) => void checked.push([...ids]) })

    const buttons = [...entry("cred_1").querySelectorAll<HTMLElement>("button")]
      .map((node) => node.getAttribute("data-action"))
    expect(buttons.filter((action) => action !== "agent-account-menu" && action !== null)).toEqual([
      "agent-account-check",
      "agent-account-remove",
    ])

    fireEvent.click(entry("cred_1").querySelector<HTMLElement>('[data-action="agent-account-check"]')!)

    expect(checked).toEqual([["cred_1"]])
  })

  test("Remove asks before it forgets, and Cancel keeps the account", () => {
    const removed: string[][] = []
    row({
      accounts: [account({ key: "cred_1", ids: ["cred_1", "acp_1"] })],
      onRemove: (ids) => void removed.push([...ids]),
    })

    fireEvent.click(entry("cred_1").querySelector<HTMLElement>('[data-action="agent-account-remove"]')!)

    expect(removed).toEqual([])
    expect(entry("cred_1").textContent).toContain("settings.providers.agents.removeAccountConfirm")

    fireEvent.click(entry("cred_1").querySelector<HTMLElement>('[data-action="agent-account-remove-cancel"]')!)

    expect(removed).toEqual([])
    expect(entry("cred_1").querySelector('[data-action="agent-account-remove-confirm"]')).toBeNull()

    fireEvent.click(entry("cred_1").querySelector<HTMLElement>('[data-action="agent-account-remove"]')!)
    fireEvent.click(entry("cred_1").querySelector<HTMLElement>('[data-action="agent-account-remove-confirm"]')!)

    expect(removed).toEqual([["cred_1", "acp_1"]])
  })

  test("the add link is the last list entry and names whether the list is empty", () => {
    row({ accounts: [] })
    expect(screen.getByRole("button", { name: "settings.providers.agents.addFirstAccount" })).toBeTruthy()
    cleanup()

    row()
    const add = screen.getByRole("button", { name: "settings.providers.agents.addAnotherAccount" })
    const list = document.querySelector('[data-component="agent-accounts"]')!
    expect(list.lastElementChild?.contains(add)).toBe(true)

    fireEvent.click(add)

    expect(screen.getByTestId("connect-form").dataset.credential).toBe("")
  })
})
