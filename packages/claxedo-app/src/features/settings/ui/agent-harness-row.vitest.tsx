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
  tone: "success",
  status: "Working",
  selected: true,
  ...over,
})

const machineLogin = (over: Partial<AgentAccount> = {}): AgentAccount =>
  account({
    key: "machine",
    ids: [],
    label: "This computer's login",
    source: "from ~/.codex",
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

function click(key: string, action: string) {
  const button = entry(key).querySelector<HTMLElement>(`[data-action="${action}"]`)
  if (!button) throw new Error(`no ${action} on ${key}`)
  fireEvent.click(button)
}

/** The Check/Remove text that sits on the header line while there is one entry. */
function headerAction(action: string) {
  const button = document.querySelector<HTMLElement>(`[data-provider] > div [data-action="${action}"]`)
  if (!button) throw new Error(`no ${action} on the header`)
  return button
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
  test("one entry is left to the header sentence, which carries its two actions", () => {
    row()

    expect(document.querySelector('[role="radiogroup"]')).toBeNull()
    expect(entries()).toEqual([])
    expect(document.querySelector('[data-component="agent-header-status"]')?.textContent)
      .toBe("Using work@acme.com · Working")
    expect(headerAction("agent-account-check").textContent).toBe("settings.providers.agents.checkAccount")
    expect(headerAction("agent-account-remove").textContent).toBe("settings.providers.agents.removeAccount")
    expect(screen.getByRole("button", { name: "settings.providers.agents.addAnotherAccount" })).toBeTruthy()
  })

  test("the lone entry's Remove asks on the header line, then forgets every binding", () => {
    const removed: string[][] = []
    row({ accounts: [account({ ids: ["cred_1", "acp_1"] })], onRemove: (ids) => void removed.push([...ids]) })

    fireEvent.click(headerAction("agent-account-remove"))

    expect(removed).toEqual([])
    fireEvent.click(headerAction("agent-account-remove-cancel"))
    expect(document.querySelector('[data-action="agent-account-remove-confirm"]')).toBeNull()

    fireEvent.click(headerAction("agent-account-remove"))
    fireEvent.click(headerAction("agent-account-remove-confirm"))

    expect(removed).toEqual([["cred_1", "acp_1"]])
  })

  test("the machine login on its own is that one entry too, and it has nothing stored to act on", () => {
    row({ accounts: [machineLogin({ selected: true })] })

    expect(document.querySelector('[role="radiogroup"]')).toBeNull()
    expect(entries()).toEqual([])
    expect(document.querySelector('[data-action="agent-account-check"]')).toBeNull()
    expect(document.querySelector('[data-action="agent-account-remove"]')).toBeNull()
  })

  test("with two entries the actions belong to the rows, and the header carries none", () => {
    row({ accounts: [account(), machineLogin()] })

    expect(document.querySelector('[data-component="agent-header-status"]')?.parentElement
      ?.querySelector('[data-action="agent-account-remove"]')).toBeNull()
    expect(entry("cred_1").querySelector('[data-action="agent-account-remove"]')).not.toBeNull()
  })

  test("a second entry makes the choice real, so both are listed", () => {
    row({ accounts: [account(), machineLogin()] })

    expect(document.querySelector('[role="radiogroup"]')).not.toBeNull()
    expect(entries()).toEqual(["cred_1", "machine"])
    expect(entry("machine").textContent).toContain("from ~/.codex")
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

  test("an entry's two actions are text on the row, and Check names the rows it asks about", () => {
    const checked: string[][] = []
    row({ accounts: [account(), machineLogin()], onCheck: (ids) => void checked.push([...ids]) })

    expect([...entry("cred_1").querySelectorAll<HTMLElement>("button")].map((node) => node.getAttribute("data-action")))
      .toEqual(["agent-account-check", "agent-account-remove"])
    expect(entry("cred_1").querySelector('[data-action="agent-account-check"]')?.textContent)
      .toBe("settings.providers.agents.checkAccount")

    click("cred_1", "agent-account-check")

    expect(checked).toEqual([["cred_1"]])
  })

  test("nothing is stored for this computer's login yet, so it has nothing to check or forget", () => {
    row({ accounts: [account(), machineLogin()] })

    expect(entry("machine").querySelectorAll("button")).toHaveLength(0)
  })

  test("Remove asks before it forgets, and Cancel keeps the account", () => {
    const removed: string[][] = []
    row({
      accounts: [account({ key: "cred_1", ids: ["cred_1", "acp_1"] }), machineLogin()],
      onRemove: (ids) => void removed.push([...ids]),
    })

    click("cred_1", "agent-account-remove")

    expect(removed).toEqual([])
    expect(entry("cred_1").textContent).toContain("settings.providers.agents.removeAccountConfirm")

    click("cred_1", "agent-account-remove-cancel")

    expect(removed).toEqual([])
    expect(entry("cred_1").querySelector('[data-action="agent-account-remove-confirm"]')).toBeNull()

    click("cred_1", "agent-account-remove")
    click("cred_1", "agent-account-remove-confirm")

    expect(removed).toEqual([["cred_1", "acp_1"]])
  })

  test("the add link is the last thing under the harness and names whether anything is set up", () => {
    row({ accounts: [] })
    expect(screen.getByRole("button", { name: "settings.providers.agents.addFirstAccount" })).toBeTruthy()
    cleanup()

    row({ accounts: [account(), machineLogin()] })
    const add = screen.getByRole("button", { name: "settings.providers.agents.addAnotherAccount" })
    const list = document.querySelector('[data-component="agent-accounts"]')!
    expect(list.lastElementChild?.contains(add)).toBe(true)

    fireEvent.click(add)

    expect(screen.getByTestId("connect-form").dataset.credential).toBe("")
  })
})
