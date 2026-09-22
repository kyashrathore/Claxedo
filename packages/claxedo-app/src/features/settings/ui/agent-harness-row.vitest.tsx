import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { ComponentProps } from "solid-js"
import { AgentHarnessRow, type AgentAccount } from "./agent-harness-row"

vi.mock("@opencode-ai/ui/provider-icon", () => ({ ProviderIcon: () => null }))
// Connecting opens a dialog now; this suite is about the row it opens from.
// Connecting opens a dialog now. The suite keeps asserting what the flow was
// opened WITH, so the mock records the element and the test mounts it.
const shownDialogs = vi.hoisted(() => [] as Array<() => unknown>)
vi.mock("@opencode-ai/ui/context/dialog", () => ({
  useDialog: () => ({
    show: (element: () => unknown) => {
      shownDialogs.push(element)
      return Promise.resolve()
    },
    close: () => {},
  }),
}))

vi.mock("@/features/settings/app-ports", () => ({
  ProviderConnectForm: (props: { provider: string; credentialId?: string }) => (
    <div data-testid="connect-form" data-provider={props.provider} data-credential={props.credentialId ?? ""} />
  ),
}))

// The dialog's own chrome belongs to the UI kit; this suite is about what the
// row opens it with.
vi.mock("@/features/settings/ui/dialog-provider-connect", () => ({
  DialogProviderConnect: (props: { provider: string; credentialId?: string }) => (
    <div data-testid="connect-form" data-provider={props.provider} data-credential={props.credentialId ?? ""} />
  ),
}))

/** Mounts the connect dialog the row just opened. */
function openedConnectDialog() {
  const element = shownDialogs.at(-1)
  if (!element) throw new Error("no dialog was shown")
  return render(() => element() as never)
}

vi.mock("@/platform/i18n/provider", () => ({
  useLanguage: () => ({
    t: (key: string, vars?: Record<string, string>) => (vars ? `${key}:${Object.values(vars).join("|")}` : key),
    locale: () => "en",
  }),
}))

afterEach(cleanup)

const account = (over: Partial<AgentAccount> = {}): AgentAccount => ({
  key: "cred_1",
  ids: ["cred_1"],
  label: "work@acme.com",
  reach: "local-and-cloud",
  selected: true,
  ...over,
})

const machineLogin = (over: Partial<AgentAccount> = {}): AgentAccount =>
  account({
    key: "machine",
    ids: [],
    label: "machine@acme.com",
    detail: "Weekly 64% used",
    reach: "local-only",
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

    openedConnectDialog()
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
        account({ detail: "settings.providers.live.window:Weekly|58 · settings.providers.live.ok" }),
        account({ key: "cred_2", ids: ["cred_2"], label: "home@acme.com", selected: false }),
      ],
    })

    expect(entry("cred_1").querySelector('[data-slot="radio-list-item-description"]')?.textContent)
      .toContain("settings.providers.live.window:Weekly|58")
    expect(entry("cred_2").querySelector('[data-slot="radio-list-item-description"]')).toBeNull()
  })

  test("this computer's login is a row like any other, and its Check asks the harness again", () => {
    const checked: string[] = []
    row({ accounts: [account(), machineLogin()], onCheck: (entry) => void checked.push(entry.key) })

    expect(entries()).toEqual(["cred_1", "machine"])
    expect(entry("machine").textContent).toContain("Weekly 64% used")
    // Nothing is stored for it, so there is a Check but nothing to forget.
    expect(entry("machine").querySelector('[data-action="agent-account-remove"]')).toBeNull()

    click("machine", "agent-account-check")

    expect(checked).toEqual(["machine"])
  })

  test("when the row was read sits in its own right-hand column, outside the sentence", () => {
    row({ accounts: [account({ detail: "Weekly 64% used", checkedAt: Date.now() - 5 * 60_000 })] })

    expect(entry("cred_1").querySelector('[data-slot="radio-list-item-description"]')?.textContent)
      .toBe("Weekly 64% used")
    const checked = entry("cred_1").querySelector('[data-component="agent-account-checked"]')!
    expect(checked.textContent).toBe("5m")
    // The age and the actions share one cell, so the cluster arrives over the
    // time rather than beside it and no row moves when the pointer does.
    expect(checked.nextElementSibling?.getAttribute("data-component")).toBe("agent-account-actions")
    // Both are revealed by hovering the row, so the `group` they answer to has
    // to be the row itself and not some span between them.
    expect(checked.closest(".group")).toBe(entry("cred_1"))
    expect(entry("cred_1").querySelector('[data-component="agent-account-actions"]')!.closest(".group"))
      .toBe(entry("cred_1"))
  })

  test("the read time is an age in one unit, and the whole sentence is its accessible name", () => {
    const at = (ms: number) => [account({ checkedAt: Date.now() - ms })]
    const shown = () => entry("cred_1").querySelector('[data-component="agent-account-checked"]')!

    row({ accounts: at(30_000) })
    expect(shown().textContent).toBe("common.justNow")
    cleanup()

    row({ accounts: at(5 * 60_000) })
    expect(shown().textContent).toBe("5m")
    cleanup()

    row({ accounts: at(5 * 3_600_000) })
    expect(shown().textContent).toBe("5h")
    expect(shown().getAttribute("aria-label")).toBe("common.lastChecked:5 hours ago")
    cleanup()

    row({ accounts: at(3 * 86_400_000) })
    expect(shown().textContent).toBe("3d")
  })

  test("a row nothing has read carries no time at all", () => {
    row()

    expect(entry("cred_1").querySelector('[data-component="agent-account-checked"]')).toBeNull()
  })

  test("what the label does not say hangs off a hint beside it, and pressing the hint chooses nothing", () => {
    const chosen: string[] = []
    row({
      accounts: [account({ selected: true }), machineLogin({ note: "Works with Cursor ACP · the SDK needs a key" })],
      onSelect: (item) => void chosen.push(item.key),
    })

    const hint = entry("machine").querySelector<HTMLElement>('[data-component="agent-account-note"] [aria-label]')!
    expect(hint.getAttribute("aria-label")).toBe("Works with Cursor ACP · the SDK needs a key")
    expect(entry("machine").querySelector('[data-slot="radio-list-item-description"]')?.textContent)
      .not.toContain("Works with Cursor ACP")

    fireEvent.click(hint)

    expect(chosen).toEqual([])
    expect(entry("cred_1").querySelector('[data-component="agent-account-note"]')).toBeNull()
  })

  test("every entry says where a turn on it can run, and this computer's login says it runs nowhere else", () => {
    row({ accounts: [account(), machineLogin()] })

    const reach = (key: string) =>
      entry(key).querySelector('[data-component="agent-account-reach"] [data-reach]')
    const places = (key: string) => [...reach(key)?.querySelectorAll("[data-icon]") ?? []]
      .map((icon) => [icon.getAttribute("data-icon"), icon.getAttribute("aria-label")])

    expect(reach("cred_1")?.getAttribute("data-reach")).toBe("local-and-cloud")
    // No words: the two places are two marks, and the second one is what a
    // stored account has that this computer's login does not.
    expect(reach("cred_1")?.textContent).toBe("")
    expect(places("cred_1")).toEqual([
      ["monitor", "settings.providers.agents.reachLocal"],
      ["cloud", "settings.providers.agents.reachCloud"],
    ])
    expect(reach("machine")?.getAttribute("data-reach")).toBe("local-only")
    expect(places("machine")).toEqual([["monitor", "settings.providers.agents.reachLocal"]])
  })

  test("an id the reader cannot match to an account is a tooltip, never a line", () => {
    row({ accounts: [account({ identity: "f050517a-3e46-4798-a274-1d3a34084f2a" })] })

    expect(entry("cred_1").textContent).not.toContain("f050517a")
    expect(entry("cred_1").getAttribute("title")).toBe("f050517a-3e46-4798-a274-1d3a34084f2a")
  })

  test("Reconnect belongs to the row the provider refused, never to the header", () => {
    row({ accounts: [account({ refused: true })] })

    expect([...document.querySelectorAll<HTMLElement>('[data-component="provider-actions"] button')]
      .map((button) => button.dataset.action)).toEqual(["agent-add-account"])
    const actions = entry("cred_1").querySelector('[data-component="agent-account-actions"]')!
    const reconnect = actions.querySelector<HTMLElement>('[data-action="agent-reconnect"]')!
    expect(reconnect.textContent).toBe("settings.providers.agents.reconnectAccount")

    fireEvent.click(reconnect)

    // Reconnect opens the same dialog Add-an-account does, naming the row it
    // came from; the header's control names none.
    openedConnectDialog()
    expect(screen.getAllByTestId("connect-form").at(-1)!.dataset.credential).toBe("cred_1")
  })

  test("a refused account is a ring and the provider's word on its second line, not red words or a hover", () => {
    row({ accounts: [account({ refused: true, detail: "…xgAA · settings.providers.live.authFailed" })] })

    expect(entry("cred_1").hasAttribute("data-invalid")).toBe(true)
    const description = entry("cred_1").querySelector<HTMLElement>('[data-slot="radio-list-item-description"]')!
    expect(description.textContent).toBe("…xgAA · settings.providers.live.authFailed")
    expect(description.querySelector(".sr-only")).toBeNull()
    expect(description.querySelector('[class*="danger"], [class*="error"]')).toBeNull()
    expect(entry("cred_1").getAttribute("title")).toBeNull()
  })

  test("a refused row rests as a ring alone: Reconnect waits with the other two for the pointer", () => {
    row({ accounts: [account({ refused: true, selected: true })] })

    const actions = entry("cred_1").querySelector('[data-component="agent-account-actions"]')!
    expect([...actions.querySelectorAll("button")].map((node) => node.dataset.action))
      .toEqual(["agent-reconnect", "agent-account-check", "agent-account-remove"])
    expect(actions.className).toContain("opacity-0")
  })

  test("the two actions are hidden at rest and arrive with the pointer or the keyboard", () => {
    const checked: string[] = []
    row({ onCheck: (entry) => void checked.push(entry.key) })

    const actions = entry("cred_1").querySelector('[data-component="agent-account-actions"]')!
    expect(actions.className).toContain("opacity-0")
    expect(actions.closest(".group")).toBe(entry("cred_1"))
    expect([...actions.querySelectorAll("button")].map((node) => node.getAttribute("aria-label")))
      .toEqual(["settings.providers.agents.checkAccount", "settings.providers.agents.removeAccount"])

    click("cred_1", "agent-account-check")

    expect(checked).toEqual(["cred_1"])
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

    openedConnectDialog()
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
    openedConnectDialog()
    expect(screen.getByTestId("connect-form")).toBeTruthy()
  })
})
