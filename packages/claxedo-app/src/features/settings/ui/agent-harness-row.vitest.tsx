import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { ComponentProps } from "solid-js"
import { AgentHarnessRow, type AgentAccount } from "./agent-harness-row"

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
  selected: true,
  ...over,
})

const machineLogin = (over: Partial<AgentAccount> = {}): AgentAccount =>
  account({
    key: "machine",
    ids: [],
    label: "This computer's login",
    detail: "from ~/.codex/auth.json",
    selected: false,
    machine: true,
    ...over,
  })

function row(extra: Partial<ComponentProps<typeof AgentHarnessRow>> = {}) {
  return render(() => (
    <AgentHarnessRow
      id="anthropic"
      name="Claude Code"
      providerId="claude-sdk"
      harness="claude"
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

function click(key: string, action: string) {
  const button = entry(key).querySelector<HTMLElement>(`[data-action="${action}"]`)
  if (!button) throw new Error(`no ${action} on ${key}`)
  fireEvent.click(button)
}

describe("AgentHarnessRow header", () => {
  test("is the name and the one action no row can offer: no sentence, no dot", () => {
    row()

    const header = document.querySelector('[data-provider] > div')!
    expect(header.textContent).toBe("Claude Codesettings.providers.agents.addAccount")
    expect([...header.querySelectorAll("button")].map((button) => button.dataset.action))
      .toEqual(["agent-add-account"])
  })

  test("a harness with no account at all offers the same header button, and nests nothing under the empty list", () => {
    row({ accounts: [] })

    const actions = document.querySelectorAll('[data-component="provider-actions"] button')
    expect(actions).toHaveLength(1)
    expect(actions[0].textContent).toBe("settings.providers.agents.addAccount")
    expect(document.querySelector('[data-component="agent-accounts"] button')).toBeNull()

    fireEvent.click(actions[0])

    expect(screen.getByTestId("connect-form").dataset.credential).toBe("")
  })

  test("a harness with accounts nests no add link under the rows", () => {
    row()

    expect(document.querySelector('[data-component="agent-accounts"] [data-action="agent-add-account"]')).toBeNull()
  })
})

describe("AgentHarnessRow accounts", () => {
  test("one account is a row of its own, because the header no longer names it", () => {
    row()

    expect(entries()).toEqual(["cred_1"])
    expect(document.querySelector('[role="radiogroup"]')).not.toBeNull()
    expect(entry("cred_1").textContent).toContain("work@acme.com")
  })

  test("the checked radio is the account in use, and choosing another reports its rows", () => {
    const chosen: string[][] = []
    row({
      accounts: [
        account({ key: "cred_1", ids: ["cred_1", "acp_1"], selected: true }),
        account({ key: "cred_2", ids: ["cred_2"], label: "home@acme.com", selected: false }),
      ],
      onSelect: (item) => void chosen.push([...item.ids]),
    })

    const radios = document.querySelectorAll<HTMLInputElement>('[data-component="agent-account"] input[type="radio"]')
    expect([...radios].map((input) => input.checked)).toEqual([true, false])
    expect([...radios].map((input) => input.name)).toEqual(["agent-account-claude", "agent-account-claude"])

    fireEvent.click(radios[1])

    expect(chosen).toEqual([["cred_2"]])
  })

  test("what the label does not say goes on a second line, and nothing goes there otherwise", () => {
    row({
      accounts: [
        account({ detail: "settings.providers.live.window:Weekly|58 · settings.providers.live.checkedAt:2 h ago" }),
        account({ key: "cred_2", ids: ["cred_2"], label: "home@acme.com", selected: false }),
      ],
    })

    expect(entry("cred_1").querySelector('[data-slot="radio-list-item-description"]')?.textContent)
      .toContain("settings.providers.live.window:Weekly|58")
    expect(entry("cred_2").querySelector('[data-slot="radio-list-item-description"]')).toBeNull()
  })

  test("this computer's login is a row like any other, named by where it was read from", () => {
    row({ accounts: [account(), machineLogin()] })

    expect(entries()).toEqual(["cred_1", "machine"])
    expect(entry("machine").textContent).toContain("from ~/.codex/auth.json")
    // Nothing is stored for it yet, so there is nothing to check or forget.
    expect(entry("machine").querySelector('[data-component="agent-account-actions"]')).toBeNull()
  })

  test("an id the reader cannot match to an account is a tooltip, never a line", () => {
    row({ accounts: [account({ identity: "f050517a-3e46-4798-a274-1d3a34084f2a" })] })

    expect(entry("cred_1").textContent).not.toContain("f050517a")
    expect(entry("cred_1").getAttribute("title")).toBe("f050517a-3e46-4798-a274-1d3a34084f2a")
  })

  test("Reconnect belongs to the row the provider refused, never to the header", () => {
    row({ accounts: [account({ refused: "settings.providers.live.authFailed" })] })

    expect([...document.querySelectorAll<HTMLElement>('[data-component="provider-actions"] button')]
      .map((button) => button.dataset.action)).toEqual(["agent-add-account"])
    const reconnect = entry("cred_1").querySelector<HTMLElement>('[data-action="agent-reconnect"]')!
    expect(reconnect.textContent).toBe("settings.providers.agents.reconnectAccount")

    fireEvent.click(reconnect)

    expect(screen.getByTestId("connect-form").dataset.credential).toBe("cred_1")
    expect(document.querySelector('[data-component="provider-connect-card"]')?.getAttribute("data-credential"))
      .toBe("cred_1")
  })

  test("a refused account is a ring and a screen-reader verdict, not red words", () => {
    row({ accounts: [account({ refused: "settings.providers.live.authFailed" })] })

    expect(entry("cred_1").hasAttribute("data-invalid")).toBe(true)
    expect(entry("cred_1").querySelector('[data-component="agent-account-refusal"]')?.textContent)
      .toBe("settings.providers.live.authFailed")
    expect(entry("cred_1").getAttribute("title")).toBe("settings.providers.live.authFailed")
  })

  test("a refused row keeps both hover actions as well as its Reconnect", () => {
    row({ accounts: [account({ refused: "settings.providers.live.expired", selected: true })] })

    expect(entry("cred_1").querySelector('[data-action="agent-account-check"]')).not.toBeNull()
    expect(entry("cred_1").querySelector('[data-action="agent-account-remove"]')).not.toBeNull()
  })

  test("the two actions are hidden at rest and arrive with the pointer or the keyboard", () => {
    const checked: string[][] = []
    row({ onCheck: (ids) => void checked.push([...ids]) })

    const actions = entry("cred_1").querySelector('[data-component="agent-account-actions"]')!
    expect(actions.className).toContain("opacity-0")
    expect(actions.className).toContain("group-hover:opacity-100")
    expect(actions.className).toContain("group-focus-within:opacity-100")
    expect([...actions.querySelectorAll("button")].map((node) => node.getAttribute("aria-label")))
      .toEqual(["settings.providers.agents.checkAccount", "settings.providers.agents.removeAccount"])

    click("cred_1", "agent-account-check")

    expect(checked).toEqual([["cred_1"]])
  })

  test("Remove asks before it forgets, holds the question on screen, and Cancel keeps the account", () => {
    const removed: string[][] = []
    row({
      accounts: [account({ key: "cred_1", ids: ["cred_1", "acp_1"] })],
      onRemove: (ids) => void removed.push([...ids]),
    })

    click("cred_1", "agent-account-remove")

    expect(removed).toEqual([])
    expect(entry("cred_1").textContent).toContain("settings.providers.agents.removeAccountConfirm")
    expect(entry("cred_1").querySelector('[data-component="agent-account-actions"]')!.className)
      .not.toContain("opacity-0")

    click("cred_1", "agent-account-remove-cancel")

    expect(removed).toEqual([])
    expect(entry("cred_1").querySelector('[data-action="agent-account-remove-confirm"]')).toBeNull()

    click("cred_1", "agent-account-remove")
    click("cred_1", "agent-account-remove-confirm")

    expect(removed).toEqual([["cred_1", "acp_1"]])
  })

  test("adding an account names no row, whichever accounts are already listed", () => {
    row({ accounts: [account(), machineLogin()] })
    const add = screen.getByRole("button", { name: "settings.providers.agents.addAccount" })

    fireEvent.click(add)

    expect(screen.getByTestId("connect-form").dataset.credential).toBe("")
  })

  test("opening the connect card leaves every row where it was", () => {
    // The card mounts a lazily loaded form. A row that remounts here takes the
    // radio's checked state and the confirm in progress down with it.
    row({ accounts: [account(), machineLogin()] })
    const before = [...document.querySelectorAll('[data-component="agent-account"]')]

    fireEvent.click(document.querySelector<HTMLElement>('[data-action="agent-add-account"]')!)

    const after = [...document.querySelectorAll('[data-component="agent-account"]')]
    expect(after).toEqual(before)
    expect(screen.getByTestId("connect-form")).toBeTruthy()
  })
})
