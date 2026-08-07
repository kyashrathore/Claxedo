import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { describe, expect, test, vi } from "vitest"
import { AIConnectSurface, type AIConnectView } from "./ai-connect-surface"
import { configureOnboardingAppPorts } from "./app-ports"
import type { AIConnectRequest } from "./ai-connect-api"

function requests(responses: Response[]) {
  const calls: Array<{ input: Parameters<AIConnectRequest>[0]; init?: RequestInit }> = []
  const request: AIConnectRequest = async (input, init) => {
    calls.push({ input, init })
    const response = responses.shift()
    if (!response) throw new Error("unexpected request")
    return response
  }
  return { calls, request }
}

/**
 * The provider catalog and the connect form belong to the app shell. Onboarding
 * reaches them through the ports seam, so the seam is what a unit test fills —
 * the real ones drag in the SDK, the router, and a query client.
 */
function stubPorts() {
  configureOnboardingAppPorts({
    ProviderList: ((props: { onSelect: (id: string) => void }) => (
      <button type="button" onClick={() => props.onSelect("anthropic")}>Anthropic</button>
    )) as never,
    ProviderConnectForm: ((props: { provider: string; scope?: string }) => (
      <div data-testid="connect-form" data-provider={props.provider} data-scope={props.scope} />
    )) as never,
    workspaceSandboxDriversUrl: (() => "") as never,
  })
}

/** Drives `view` the way both real callers do, so Back and branching work. */
function Harness(props: Partial<Parameters<typeof AIConnectSurface>[0]> & { initialView?: AIConnectView }) {
  const [view, setView] = createSignal<AIConnectView>(props.initialView ?? { kind: "chooser" })
  return (
    <AIConnectSurface
      localDiscovery
      request={vi.fn() as never}
      invalidateQueries={vi.fn()}
      {...props}
      view={view()}
      onViewChange={setView}
    />
  )
}

describe("opening straight onto the harness check", () => {
  test("autoDiscover runs the scan with no click, and only once", async () => {
    // The go-further card lands here with no button to press. Without this the
    // screen opens on nothing.
    stubPorts()
    const stub = requests([Response.json({
      discovery_id: "discovery-1",
      items: [{ provider_id: "claude-sdk", kind: "oauth_token", label: "Claude Code login", origin: "Keychain", probe: { state: "working" } }],
    })])
    render(() => <Harness destination="local" autoDiscover request={stub.request} initialView={{ kind: "detect" }} />)

    expect(await screen.findByText("Claude Code")).toBeInTheDocument()
    expect(stub.calls.length).toBe(1)
  })

  test("without it the check waits for the user, as the step always has", () => {
    stubPorts()
    const stub = requests([])
    render(() => <Harness destination="local" request={stub.request} />)

    expect(stub.calls.length).toBe(0)
  })
})

describe("AIConnectSurface", () => {
  test("the local screen is one button, not a menu of ways to connect", () => {
    stubPorts()
    render(() => <Harness destination="local" />)

    expect(screen.getByRole("button", { name: "Check my logins" })).toBeInTheDocument()
    expect(screen.getByText(/Nothing to paste/i)).toBeInTheDocument()
    // Nothing to choose: every local harness already has its own login.
    expect(screen.queryByText("Something else")).not.toBeInTheDocument()
    expect(screen.queryByText(/agent harness/i)).not.toBeInTheDocument()
  })

  test("the Cursor dashboard-key caveat appears only where a sandbox needs one", () => {
    stubPorts()
    render(() => <Harness destination="cloud" />)

    // Not "isn't discoverable" — what to do, and why it is the only option.
    expect(screen.getByText(/paste a key from the Cursor dashboard/i)).toBeInTheDocument()
  })

  test("the cloud screen offers each harness the one thing that works for it", () => {
    stubPorts()
    render(() => <Harness destination="cloud" />)

    // Codex keeps its subscription; Claude cannot, and says why rather than
    // leaving the user to discover it.
    expect(screen.getByText(/Sign in with ChatGPT/i)).toBeInTheDocument()
    expect(screen.getByText(/create a token from your subscription with one command/i)).toBeInTheDocument()
    expect(screen.getByText("Something else")).toBeInTheDocument()
  })

  test("each cloud harness opens the connect form for the auth id that carries its methods", () => {
    // These are AUTH ids, not model-catalog ids: `codex-acp` is the one that
    // offers the ChatGPT OAuth flow, `cursor-acp` the dashboard key. Pinned
    // because a plausible-looking wrong id (`cursor`, `openai`) silently
    // downgrades the user to the wrong set of sign-in methods.
    stubPorts()
    const opened: string[] = []
    for (const [label, expected] of [["Codex", "codex-acp"], ["Cursor", "cursor-acp"]] as const) {
      const view = render(() => <Harness destination="cloud" />)
      fireEvent.click(screen.getByText(label))
      opened.push(screen.getByTestId("connect-form").getAttribute("data-provider") ?? "")
      expect(opened.at(-1)).toBe(expected)
      view.unmount()
    }
  })

  test("the save action lives in the body, beside the rows it writes", async () => {
    stubPorts()
    const stub = requests([Response.json({
      discovery_id: "discovery-1",
      items: [{ provider_id: "codex-acp", kind: "oauth_token", label: "Codex", origin: "~/.codex/auth.json", probe: { state: "working" } }],
    })])
    render(() => <Harness destination="cloud" request={stub.request} />)

    fireEvent.click(screen.getByText("Send a login from this computer"))

    expect(await screen.findByRole("button", { name: "Save 1 connection" })).toBeInTheDocument()
  })

  test("a local-only run confirms the machine's login and writes nothing", async () => {
    stubPorts()
    // One response only: a save would need a second, so an attempted write
    // fails this test rather than passing quietly.
    const stub = requests([Response.json({
      discovery_id: "discovery-1",
      items: [
        { provider_id: "claude-acp", kind: "oauth_token", label: "Claude Code login · ACP adapter", origin: "macOS Keychain", probe: { state: "working" } },
        { provider_id: "claude-sdk", kind: "oauth_token", label: "Claude Code login · agent SDK", origin: "macOS Keychain", probe: { state: "working" } },
      ],
    })])
    const submit = vi.fn()
    const detected = vi.fn()
    render(() => (
      <Harness
        destination="local"
        request={stub.request}
        registerSubmit={submit}
        onLocalHarnessesDetected={detected}
      />
    ))

    fireEvent.click(screen.getByRole("button", { name: "Check my logins" }))

    expect(await screen.findByText("Ready")).toBeInTheDocument()
    expect(screen.getByText(/Nothing was saved/i)).toBeInTheDocument()
    // The registry holds nothing for this provider because nothing was sent:
    // discovery is the only request that ever went out.
    expect(stub.calls).toHaveLength(1)
    expect(stub.calls[0].input).toMatchObject({ action: "discover" })
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument()
    expect(detected).toHaveBeenCalledWith(["claude"])
  })

  test("every harness gets a row, so a missing one is an answer rather than an omission", async () => {
    stubPorts()
    const stub = requests([Response.json({
      discovery_id: "discovery-1",
      items: [{ provider_id: "claude-sdk", kind: "oauth_token", label: "Claude Code login · agent SDK", origin: "macOS Keychain", probe: { state: "working" } }],
    })])
    render(() => <Harness destination="local" request={stub.request} />)

    fireEvent.click(screen.getByRole("button", { name: "Check my logins" }))
    await screen.findByText("Ready")

    // Codex and Cursor were not found. Saying so is the point of the screen —
    // a user who expected Cursor to work needs to know it is not signed in.
    expect(screen.getByText("Codex")).toBeInTheDocument()
    expect(screen.getByText("Cursor")).toBeInTheDocument()
    expect(screen.getAllByText("Not signed in")).toHaveLength(2)
    expect(screen.getByText(/cursor-agent login/)).toBeInTheDocument()
  })

  test("a harness Claxedo cannot verify is never given a checkmark", async () => {
    stubPorts()
    // `verify.ts` has no cursor branch, so its probe comes back `unknown`. A
    // tick here would mean "present" while the tick beside Claude means
    // "proven" — and the user would find out at first turn.
    const stub = requests([Response.json({
      discovery_id: "discovery-1",
      items: [
        { provider_id: "claude-sdk", kind: "oauth_token", label: "Claude Code login · agent SDK", origin: "macOS Keychain", probe: { state: "working" } },
        { provider_id: "cursor-acp", kind: "api_key", label: "Cursor", origin: "CURSOR_API_KEY", probe: { state: "unknown", reason: "Claxedo can't check this provider yet — it will be used as-is." } },
      ],
    })])
    render(() => <Harness destination="local" request={stub.request} />)

    fireEvent.click(screen.getByRole("button", { name: "Check my logins" }))
    await screen.findByText("Ready")

    const cursor = document.querySelector('[data-harness="cursor"]')!
    expect(cursor.getAttribute("data-state")).toBe("unverifiable")
    expect(cursor.textContent).toContain("Signed in")
    expect(cursor.textContent).not.toContain("Ready")
    // Exactly one harness earned a checkmark, and it is the probed one.
    expect(screen.getAllByText("Ready")).toHaveLength(1)
  })

  test("a rejected local login says so instead of quietly reading as fine", async () => {
    stubPorts()
    const stub = requests([Response.json({
      discovery_id: "discovery-1",
      items: [{ provider_id: "codex-acp", kind: "oauth_token", label: "Codex", origin: "~/.codex/auth.json", probe: { state: "broken", reason: "The provider rejected this credential." } }],
    })])
    render(() => <Harness destination="local" request={stub.request} />)

    fireEvent.click(screen.getByRole("button", { name: "Check my logins" }))

    expect(await screen.findByText("Needs attention")).toBeInTheDocument()
    expect(screen.getByText("The provider rejected this credential.")).toBeInTheDocument()
  })

  test("a local-only run's primary action never offers a save", async () => {
    stubPorts()
    const stub = requests([Response.json({
      discovery_id: "discovery-1",
      items: [{ provider_id: "claude-sdk", kind: "oauth_token", label: "Claude Code login · agent SDK", origin: "macOS Keychain", probe: { state: "working" } }],
    })])
    const submits: Array<{ run: () => Promise<void>; count: () => number }> = []
    render(() => <Harness destination="local" request={stub.request} registerSubmit={(submit) => submits.push(submit)} />)

    fireEvent.click(screen.getByRole("button", { name: "Check my logins" }))
    await screen.findByText("Ready")

    // The action bar hides its button at count 0, and running it anyway is a
    // no-op rather than a write.
    expect(submits.at(-1)!.count()).toBe(0)
    await submits.at(-1)!.run()
    expect(stub.calls).toHaveLength(1)
  })

  test("two harness bindings of one Claude login collect as one row and save under both", async () => {
    stubPorts()
    const stub = requests([
      Response.json({
        discovery_id: "discovery-1",
        items: [
          { provider_id: "claude-acp", kind: "oauth_token", label: "Claude Code login · ACP adapter", origin: "macOS Keychain", probe: { state: "working" } },
          { provider_id: "claude-sdk", kind: "oauth_token", label: "Claude Code login · agent SDK", origin: "macOS Keychain", probe: { state: "working" } },
        ],
      }),
      Response.json({ saved: [
        { credential_id: "cred-acp", provider_id: "claude-acp" },
        { credential_id: "cred-sdk", provider_id: "claude-sdk" },
      ] }),
      Response.json({ result: "ok" }),
      Response.json({ result: "ok" }),
    ])
    const submits: Array<{ run: () => Promise<void>; count: () => number }> = []
    render(() => <Harness destination="cloud" request={stub.request} registerSubmit={(submit) => submits.push(submit)} />)

    fireEvent.click(screen.getByText("Send a login from this computer"))
    expect(await screen.findByText("Claude Code login")).toBeInTheDocument()
    expect(screen.getAllByRole("checkbox")).toHaveLength(1)
    expect(screen.getByText(/Used by ACP adapter and agent SDK/i)).toBeInTheDocument()
    // One row is one decision, so the action bar counts one.
    expect(submits.at(-1)!.count()).toBe(1)

    await submits.at(-1)!.run()

    // ...and the save still writes both bindings, or one harness would be left
    // unable to resolve auth.
    expect(JSON.parse(String(stub.calls[1].init?.body))).toEqual({
      discovery_id: "discovery-1",
      items: [
        { provider_id: "claude-acp", scope: "local" },
        { provider_id: "claude-sdk", scope: "local" },
      ],
    })
    // Two credentials verified, but the user sees one login with one verdict.
    expect(await screen.findByText("Claude Code login")).toBeInTheDocument()
    expect(screen.getAllByText("Verified")).toHaveLength(1)
  })

  test("two Codex accounts stay independently selectable", async () => {
    stubPorts()
    const stub = requests([Response.json({
      discovery_id: "discovery-1",
      items: [
        { provider_id: "codex-acp", kind: "oauth_token", label: "Codex A", account_id: "account-a", origin: "~/.codex/auth.json", probe: { state: "working" } },
        { provider_id: "codex-acp", kind: "oauth_token", label: "Codex B", account_id: "account-b", origin: "~/.codex/accounts/b.auth.json", probe: { state: "working" } },
      ],
    })])
    const submits: Array<{ count: () => number }> = []
    render(() => <Harness destination="cloud" request={stub.request} registerSubmit={(submit) => submits.push(submit)} />)

    fireEvent.click(screen.getByText("Send a login from this computer"))
    expect(await screen.findByText("Codex A")).toBeInTheDocument()
    expect(screen.getAllByRole("checkbox")).toHaveLength(2)

    fireEvent.click(screen.getAllByRole("checkbox")[1])
    await waitFor(() => expect(submits.at(-1)!.count()).toBe(1))
  })

  test("cloud + Claude offers the subscription and an API key as two equal choices", () => {
    stubPorts()
    render(() => <Harness destination="cloud" />)

    fireEvent.click(screen.getByText("Claude"))

    const options = screen.getAllByRole("button").map((button) => button.textContent ?? "")
    const subscription = options.findIndex((text) => /Use your Claude subscription/i.test(text))
    const apiKey = options.findIndex((text) => /Use an API key/i.test(text))
    expect(subscription).toBeGreaterThanOrEqual(0)
    expect(subscription).toBeLessThan(apiKey)
    // Neither is ranked for the user, and no phrase argues our side of it.
    expect(screen.queryByText(/recommended/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/your subscription, your terms/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/mint/i)).not.toBeInTheDocument()
  })

  test("the setup-token path tells the user to mint it themselves, and stores it as a pasted key", () => {
    stubPorts()
    render(() => <Harness destination="cloud" />)

    fireEvent.click(screen.getByText("Claude"))
    fireEvent.click(screen.getByText("Use your Claude subscription"))

    expect(screen.getByDisplayValue("claude setup-token")).toBeInTheDocument()
    expect(screen.getByText(/about a year/i)).toBeInTheDocument()
    expect(screen.getByText(/for about a year/i)).toBeInTheDocument()
    // The token the user pastes is stored shared, so a sandbox can read it.
    const form = screen.getByTestId("connect-form")
    expect(form).toHaveAttribute("data-provider", "anthropic")
    expect(form).toHaveAttribute("data-scope", "shared")
  })

  test("no Anthropic OAuth sign-in is offered anywhere in the Claude cloud path", () => {
    stubPorts()
    render(() => <Harness destination="cloud" />)

    fireEvent.click(screen.getByText("Claude"))

    expect(screen.queryByText(/sign in with (claude|anthropic)/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/authorize claxedo/i)).not.toBeInTheDocument()
  })

  test("a local-only run is never offered the cloud Claude path", () => {
    stubPorts()
    render(() => <Harness destination="local" />)

    // Absent, not disabled: a local machine has nothing to give a sandbox.
    expect(screen.queryByText("Give cloud agents Claude access")).not.toBeInTheDocument()
  })

  test("a broken probe is shown unchecked with its reason rather than saved", async () => {
    stubPorts()
    const stub = requests([Response.json({
      discovery_id: "discovery-1",
      items: [{ provider_id: "codex-acp", kind: "oauth_token", label: "Codex", origin: "~/.codex/auth.json", probe: { state: "broken", reason: "The provider rejected this credential." } }],
    })])
    const submits: Array<{ count: () => number }> = []
    render(() => <Harness destination="cloud" request={stub.request} registerSubmit={(submit) => submits.push(submit)} />)

    fireEvent.click(screen.getByText("Send a login from this computer"))

    expect(await screen.findByText("The provider rejected this credential.")).toBeInTheDocument()
    expect(screen.getByRole("checkbox")).not.toBeChecked()
    expect(submits.at(-1)!.count()).toBe(0)
  })

  test("invalidates credential queries before reporting a connection", async () => {
    stubPorts()
    const stub = requests([
      Response.json({ discovery_id: "discovery-1", items: [
        { provider_id: "codex-acp", kind: "oauth_token", label: "Codex", origin: "~/.codex/auth.json", probe: { state: "working" } },
      ] }),
      Response.json({ saved: [{ credential_id: "cred-codex", provider_id: "codex-acp" }] }),
      Response.json({ result: "ok" }),
    ])
    const order: string[] = []
    const submits: Array<{ run: () => Promise<void> }> = []
    render(() => (
      <Harness
        destination="cloud"
        request={stub.request}
        invalidateQueries={async () => { order.push("invalidate") }}
        onConnected={() => { order.push("connected") }}
        registerSubmit={(submit) => submits.push(submit)}
      />
    ))

    fireEvent.click(screen.getByText("Send a login from this computer"))
    await screen.findByText("Codex")
    await submits.at(-1)!.run()

    await waitFor(() => expect(order).toEqual(["invalidate", "connected"]))
  })

  test("emits funnel events at verified success and typed failure moments", async () => {
    stubPorts()
    const stub = requests([
      Response.json({ discovery_id: "discovery-1", items: [
        { provider_id: "codex-acp", kind: "oauth_token", label: "Codex", origin: "~/.codex/auth.json", probe: { state: "working" } },
        { provider_id: "openai", kind: "api_key", label: "OpenAI", origin: "OpenCode auth", probe: { state: "working" } },
      ] }),
      Response.json({ saved: [
        { credential_id: "cred-codex", provider_id: "codex-acp" },
        { credential_id: "cred-openai", provider_id: "openai" },
      ] }),
      Response.json({ result: "ok" }),
      Response.json({ result: "auth_failed" }),
    ])
    const events: unknown[] = []
    const submits: Array<{ run: () => Promise<void> }> = []
    render(() => (
      <Harness
        destination="cloud"
        request={stub.request}
        emit={(event) => events.push(event)}
        registerSubmit={(submit) => submits.push(submit)}
      />
    ))

    fireEvent.click(screen.getByText("Send a login from this computer"))
    await screen.findByText("Codex")
    await submits.at(-1)!.run()

    await waitFor(() => expect(events).toEqual([
      { name: "step_verify_failed", step: "ai", class: "auth_failed" },
      { name: "provider_connected", provider: "codex-acp" },
    ]))
  })

  test("a failing credential no longer hides the ones that worked", async () => {
    stubPorts()
    const stub = requests([
      Response.json({ discovery_id: "discovery-1", items: [
        { provider_id: "codex-acp", kind: "oauth_token", label: "Codex", origin: "~/.codex/auth.json", probe: { state: "working" } },
        { provider_id: "openai", kind: "api_key", label: "OpenAI", origin: "OpenCode auth", probe: { state: "working" } },
      ] }),
      Response.json({ saved: [
        { credential_id: "cred-codex", provider_id: "codex-acp" },
        { credential_id: "cred-openai", provider_id: "openai" },
      ] }),
      Response.json({ result: "ok" }),
      Response.json({ result: "auth_failed" }),
    ])
    const submits: Array<{ run: () => Promise<void> }> = []
    render(() => <Harness destination="cloud" request={stub.request} registerSubmit={(submit) => submits.push(submit)} />)

    fireEvent.click(screen.getByText("Send a login from this computer"))
    await screen.findByText("Codex")
    await submits.at(-1)!.run()

    expect(await screen.findByText("Verified")).toBeInTheDocument()
    expect(screen.getByText(/rejected this credential/i)).toBeInTheDocument()
  })

  test("a scan that finds nothing offers the provider catalog instead of a dead end", async () => {
    stubPorts()
    const stub = requests([Response.json({ discovery_id: "discovery-1", items: [] })])
    render(() => <Harness destination="cloud" request={stub.request} />)

    fireEvent.click(screen.getByText("Send a login from this computer"))

    expect(await screen.findByText(/No supported logins found/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Choose a provider instead" }))
    expect(screen.getByRole("button", { name: "Anthropic" })).toBeInTheDocument()
  })
})
