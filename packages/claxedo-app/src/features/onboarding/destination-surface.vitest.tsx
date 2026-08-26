// `fireEvent`, not `el.click()` / `el.dispatchEvent(...)`: only Testing
// Library's dispatch goes through the `eventWrapper` that flushes Solid 2's
// scheduler (see vitest.setup.ts), so a native dispatch leaves the next line
// reading a pre-event DOM.
import { fireEvent, render, screen } from "@solidjs/testing-library"
import { beforeAll, describe, expect, test, vi } from "vitest"
import { configureAppPortsForTest } from "@/app/integrations/test-support/app-ports-stub"
import { DestinationSurface } from "./destination-surface"
import type { CodeHostStatus } from "./code-host-api"
import type { SandboxProviderCatalog } from "./sandbox-provider-api"

// The stub resolves ports via `require()`, which vitest's ESM graph cannot
// serve for this module — inject the logo directly so the picker renders.
beforeAll(() =>
  configureAppPortsForTest({
    onboarding: {
      SandboxDriverLogo: (props: { id: string; label: string; class?: string }) => (
        <svg data-provider-logo={props.id} class={props.class} aria-hidden="true" />
      ),
    },
  }),
)

const catalog: SandboxProviderCatalog = {
  defaultProviderId: "daytona",
  providers: [
    {
      id: "daytona",
      label: "Daytona",
      fields: [{ key: "apiKey", label: "API key", secret: true }],
      configured: false,
      isDefault: true,
    },
  ],
}

const githubAvailable: CodeHostStatus = {
  integrations: [
    {
      id: "github",
      name: "GitHub",
      methods: ["key"],
      prompts: [{ id: "token", label: "Fine-grained personal access token", secret: true }],
    },
  ],
  connections: [],
}

const githubConnected: CodeHostStatus = {
  ...githubAvailable,
  connections: [{ id: "conn-1", integrationId: "github", accountLabel: "kyashrathore", status: "connected" }],
}

const authUrl = ({ driverId }: { driverId: string }) => `https://server/drivers/${driverId}/auth`

const cloudProps = {
  destination: "both" as const,
  sandboxCatalog: catalog,
  codeHosts: githubAvailable,
  sandboxAuthUrl: authUrl,
}

describe("the cloud question", () => {
  test("is one yes/no question, not a pick-your-location menu", () => {
    render(() => <DestinationSurface onChoose={vi.fn()} />)

    expect(screen.getByText("Yes, run cloud sessions too")).toBeInTheDocument()
    expect(screen.getByText("No, just this machine")).toBeInTheDocument()
    // Local is not a choice to make — agents run here either way.
    expect(screen.queryByText("On this machine")).not.toBeInTheDocument()
  })

  test("the yes row names the outcome, then the work it takes", () => {
    render(() => <DestinationSurface onChoose={vi.fn()} />)

    expect(screen.getByText(/keep running after you close your laptop/i)).toBeInTheDocument()
    expect(screen.getByText(/set up a sandbox provider and connect GitHub/i)).toBeInTheDocument()
  })

  test("choosing reports the answer", () => {
    const onChoose = vi.fn()
    render(() => <DestinationSurface onChoose={onChoose} />)

    fireEvent.click(screen.getByText("Yes, run cloud sessions too"))
    expect(onChoose).toHaveBeenCalledWith("both")

    fireEvent.click(screen.getByText("No, just this machine"))
    expect(onChoose).toHaveBeenCalledWith("local")
  })

  test("the surface never navigates — the row is the choice, Next is the move", () => {
    const onChoose = vi.fn()
    render(() => <DestinationSurface onChoose={onChoose} />)

    fireEvent.click(screen.getByText("No, just this machine"))
    expect(onChoose).toHaveBeenCalledTimes(1)
    expect(screen.getByText("Yes, run cloud sessions too")).toBeInTheDocument()
  })

  test("re-entering the step shows the existing answer, and it stays changeable", () => {
    const onChoose = vi.fn()
    render(() => <DestinationSurface destination="local" onChoose={onChoose} />)

    expect(screen.getByRole("button", { pressed: true })).toHaveTextContent("No, just this machine")

    fireEvent.click(screen.getByText("Yes, run cloud sessions too"))
    expect(onChoose).toHaveBeenCalledWith("both")
  })

  test("nothing is preselected before the user answers", () => {
    render(() => <DestinationSurface onChoose={vi.fn()} />)
    expect(screen.queryByRole("button", { pressed: true })).not.toBeInTheDocument()
  })
})

describe("saying no", () => {
  test("shows the project picker and nothing cloud-shaped", () => {
    render(() => (
      <DestinationSurface
        destination="local"
        onChoose={vi.fn()}
        projectPicker={<button type="button">Open a project</button>}
      />
    ))

    expect(screen.getByRole("button", { name: "Open a project" })).toBeInTheDocument()
    expect(screen.queryByLabelText("API key")).not.toBeInTheDocument()
    expect(screen.queryByText("Repository access")).not.toBeInTheDocument()
  })
})

describe("saying yes", () => {
  test("opens both requirements in place rather than deferring them to later steps", () => {
    render(() => <DestinationSurface {...cloudProps} onChoose={vi.fn()} />)

    expect(screen.getByText("Sandbox provider")).toBeInTheDocument()
    expect(screen.getByLabelText("API key")).toBeInTheDocument()
    expect(screen.getByText("Repository access")).toBeInTheDocument()
  })

  test("hides the project picker — a cloud session clones, it does not open a folder", () => {
    render(() => (
      <DestinationSurface
        {...cloudProps}
        onChoose={vi.fn()}
        projectPicker={<button type="button">Open a project</button>}
      />
    ))

    expect(screen.queryByRole("button", { name: "Open a project" })).not.toBeInTheDocument()
  })

  test("names the provider when a lone one leaves no picker to name it", () => {
    render(() => <DestinationSurface {...cloudProps} onChoose={vi.fn()} />)

    expect(screen.getByText(/Cloud sessions run on/i)).toBeInTheDocument()
    // One provider is a statement, not a choice — no picker to operate.
    expect(document.querySelector('[data-slot="select-select-trigger"]')).toBeNull()
  })

  test("several providers collapse into one select rather than a row per provider", () => {
    // A row each pushed the key field and the whole repository section off the
    // screen. The picker is the same select Settings uses, logos included.
    const many: SandboxProviderCatalog = {
      defaultProviderId: "daytona",
      providers: [
        catalog.providers[0]!,
        {
          id: "modal",
          label: "Modal",
          fields: [{ key: "token", label: "Token", secret: true }],
          configured: false,
          isDefault: false,
        },
        {
          id: "vercel",
          label: "Vercel",
          fields: [{ key: "token", label: "Token", secret: true }],
          configured: false,
          isDefault: false,
        },
      ],
    }
    const { container } = render(() => <DestinationSurface {...cloudProps} sandboxCatalog={many} onChoose={vi.fn()} />)

    const trigger = container.querySelector('[data-slot="select-select-trigger"]')
    expect(trigger).not.toBeNull()
    expect(trigger).toHaveAttribute("aria-label", "Sandbox provider")
    // The trigger shows the chosen provider, not all three as rows to scan.
    expect(trigger).toHaveTextContent("Daytona")
    expect(trigger).not.toHaveTextContent("Modal")
    // Only the chosen provider's fields are asked for.
    expect(screen.getByLabelText("API key")).toBeInTheDocument()
    expect(screen.queryByLabelText("Token")).not.toBeInTheDocument()
    // The brand mark rides along with the name, as it does in Settings.
    expect(container.querySelector("[data-provider-logo]")).not.toBeNull()
  })

  test("says where the key goes and who the sandbox bills", () => {
    render(() => <DestinationSurface {...cloudProps} onChoose={vi.fn()} />)

    expect(screen.getByText(/Your key stays on this machine/i)).toBeInTheDocument()
    expect(screen.getByText(/bill to your Daytona account/i)).toBeInTheDocument()
  })

  test("saving the key sends it and reports the provider ready", async () => {
    const write = vi.fn(async () => ({
      default_driver: "daytona",
      drivers: [{ id: "daytona", label: "Daytona", fields: [], configured: true, default: true }],
      verification: { state: "working" },
    }))
    const onSandboxConfigured = vi.fn()
    render(() => (
      <DestinationSurface
        {...cloudProps}
        onChoose={vi.fn()}
        writeSandboxKey={write}
        onSandboxConfigured={onSandboxConfigured}
      />
    ))

    const input = screen.getByLabelText("API key") as HTMLInputElement
    input.value = "dtn_live_123"
    fireEvent.input(input)
    fireEvent.click(screen.getByRole("button", { name: "Save key" }))
    await vi.waitFor(() => expect(onSandboxConfigured).toHaveBeenCalled())

    expect(write).toHaveBeenCalledWith(expect.stringContaining("daytona"), {
      auth: { apiKey: "dtn_live_123" },
      default: true,
    })
    expect(screen.getByText(/Daytona is ready for cloud sessions/i)).toBeInTheDocument()
  })

  test("the key save is gated until the field is filled", () => {
    render(() => <DestinationSurface {...cloudProps} onChoose={vi.fn()} />)

    expect(screen.getByRole("button", { name: "Save key" })).toBeDisabled()
  })

  test("a rejected key surfaces a repair, never a server code", async () => {
    const write = vi.fn(async () => {
      throw new Error("sandbox_driver_credentials_missing: Missing daytona credentials")
    })
    const { container } = render(() => (
      <DestinationSurface {...cloudProps} onChoose={vi.fn()} writeSandboxKey={write} />
    ))

    const input = screen.getByLabelText("API key") as HTMLInputElement
    input.value = "bad"
    fireEvent.input(input)
    fireEvent.click(screen.getByRole("button", { name: "Save key" }))

    await screen.findByText(/no working key/i)
    expect(container.textContent).not.toContain("sandbox_driver_credentials_missing")
  })

  test("an already-configured provider reads as settled rather than asking again", () => {
    render(() => (
      <DestinationSurface
        {...cloudProps}
        sandboxCatalog={{
          ...catalog,
          providers: [{ ...catalog.providers[0]!, configured: true, verification: { state: "working" } }],
        }}
        onChoose={vi.fn()}
      />
    ))

    expect(screen.getByText(/Daytona is ready for cloud sessions/i)).toBeInTheDocument()
    expect(screen.queryByLabelText("API key")).not.toBeInTheDocument()
  })

  test("ready is an earned verdict — an unchecked key never claims it", () => {
    // Modal's control plane is gRPC-only, so it reports can't-check by design.
    // A tick there would promise something nobody proved.
    render(() => (
      <DestinationSurface
        {...cloudProps}
        sandboxCatalog={{
          defaultProviderId: "modal",
          providers: [
            {
              id: "modal",
              label: "Modal",
              fields: [{ key: "token", label: "Token", secret: true }],
              configured: true,
              isDefault: true,
              verification: {
                state: "unknown",
                reason: "Claxedo can't check this provider yet — the key was saved as-is.",
              },
            },
          ],
        }}
        onChoose={vi.fn()}
      />
    ))

    expect(screen.queryByText(/is ready for cloud sessions/i)).not.toBeInTheDocument()
    expect(screen.getByText(/Modal key saved\./)).toBeInTheDocument()
    // The server's sentence, verbatim — it already reads for a human.
    expect(screen.getByText(/can't check this provider yet/i)).toBeInTheDocument()
  })

  test("a saved-but-unchecked key says so even with no reason to quote", () => {
    const write = vi.fn(async () => ({
      default_driver: "daytona",
      drivers: [{ id: "daytona", label: "Daytona", fields: [], configured: true, default: true }],
      verification: { state: "unknown" },
    }))
    render(() => <DestinationSurface {...cloudProps} onChoose={vi.fn()} writeSandboxKey={write} />)

    const input = screen.getByLabelText("API key") as HTMLInputElement
    input.value = "dtn_live_123"
    fireEvent.input(input)
    fireEvent.click(screen.getByRole("button", { name: "Save key" }))

    return vi.waitFor(() => {
      expect(screen.getByText(/Daytona key saved\./)).toBeInTheDocument()
      expect(screen.queryByText(/is ready for cloud sessions/i)).not.toBeInTheDocument()
    })
  })

  test("a rejected key shows the provider's own reason and stores nothing", async () => {
    // The server refuses before storing, and its 400 body carries the verdict —
    // preferred over anything re-derived from the message text here.
    const write = vi.fn(async () => {
      throw new Error(
        JSON.stringify({
          error: {
            code: "sandbox_driver_key_rejected",
            message: "Sandbox provider rejected the key",
            reason:
              "That key works, but the provider reports no active billing on the account. Add billing, then save it again.",
          },
        }),
      )
    })
    const onSandboxConfigured = vi.fn()
    const { container } = render(() => (
      <DestinationSurface
        {...cloudProps}
        onChoose={vi.fn()}
        writeSandboxKey={write}
        onSandboxConfigured={onSandboxConfigured}
      />
    ))

    const input = screen.getByLabelText("API key") as HTMLInputElement
    input.value = "dtn_bad"
    fireEvent.input(input)
    fireEvent.click(screen.getByRole("button", { name: "Save key" }))

    expect(await screen.findByText(/no active billing on the account/i)).toBeInTheDocument()
    // Nothing was stored, so nothing reads as settled and the form stays open.
    expect(onSandboxConfigured).not.toHaveBeenCalled()
    expect(screen.getByLabelText("API key")).toBeInTheDocument()
    expect(container.textContent).not.toContain("sandbox_driver_key_rejected")
  })
})

describe("repository access", () => {
  test("asks for a token when no account is connected", () => {
    render(() => <DestinationSurface {...cloudProps} onChoose={vi.fn()} />)

    expect(screen.getByLabelText("Fine-grained personal access token")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Connect GitHub" })).toBeDisabled()
    // Says what connecting buys, and that public repos need none of it.
    expect(screen.getByText(/clone your private repos/i)).toBeInTheDocument()
    expect(screen.getByText(/public repos need nothing/i)).toBeInTheDocument()
  })

  test("an existing connection is the answer — it never re-asks for a token", () => {
    render(() => <DestinationSurface {...cloudProps} codeHosts={githubConnected} onChoose={vi.fn()} />)

    expect(screen.getByText("kyashrathore")).toBeInTheDocument()
    expect(screen.getByText("Connected")).toBeInTheDocument()
    expect(screen.queryByLabelText("Fine-grained personal access token")).not.toBeInTheDocument()
  })

  test("connecting sends the pasted token", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ ok: true })))
    const onCodeHostConnected = vi.fn()
    render(() => (
      <DestinationSurface
        {...cloudProps}
        onChoose={vi.fn()}
        codeHostRequest={request as never}
        onCodeHostConnected={onCodeHostConnected}
      />
    ))

    const input = screen.getByLabelText("Fine-grained personal access token") as HTMLInputElement
    input.value = "github_pat_abc"
    fireEvent.input(input)
    fireEvent.click(screen.getByRole("button", { name: "Connect GitHub" }))
    await vi.waitFor(() => expect(onCodeHostConnected).toHaveBeenCalled())

    expect(JSON.parse(String(request.mock.calls[0]![1]!.body))).toEqual({ fields: {}, secret: "github_pat_abc" })
  })

  test("a rejected token says what repairs it", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ code: "verify_failed" }), { status: 400 }))
    const { container } = render(() => (
      <DestinationSurface {...cloudProps} onChoose={vi.fn()} codeHostRequest={request as never} />
    ))

    const input = screen.getByLabelText("Fine-grained personal access token") as HTMLInputElement
    input.value = "bad"
    fireEvent.input(input)
    fireEvent.click(screen.getByRole("button", { name: "Connect GitHub" }))

    await screen.findByText(/copied whole/i)
    expect(container.textContent).not.toContain("verify_failed")
  })

  test("a degraded connection still counts, and says what to watch for", () => {
    render(() => (
      <DestinationSurface
        {...cloudProps}
        codeHosts={{
          ...githubAvailable,
          connections: [{ id: "c", integrationId: "github", accountLabel: "octocat", status: "degraded" }],
        }}
        onChoose={vi.fn()}
      />
    ))

    expect(screen.getByText("octocat")).toBeInTheDocument()
    expect(screen.getByText(/needs reconnecting in Settings/i)).toBeInTheDocument()
  })

  test("a server with no code host says cloud has nothing to clone", () => {
    render(() => (
      <DestinationSurface {...cloudProps} codeHosts={{ integrations: [], connections: [] }} onChoose={vi.fn()} />
    ))

    expect(screen.getByText(/no code hosts to connect/i)).toBeInTheDocument()
  })

  test("an OAuth host opens its authorization page instead of asking for a paste", async () => {
    const openUrl = vi.fn()
    const request = vi.fn(
      async () => new Response(JSON.stringify({ url: "https://host.example/oauth", attemptId: "a1" })),
    )
    render(() => (
      <DestinationSurface
        {...cloudProps}
        codeHosts={{
          integrations: [{ id: "gitlab", name: "GitLab", methods: ["oauth"], prompts: [] }],
          connections: [],
        }}
        onChoose={vi.fn()}
        codeHostRequest={request as never}
        openUrl={openUrl}
      />
    ))

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Connect GitLab" }))
    await vi.waitFor(() => expect(openUrl).toHaveBeenCalledWith("https://host.example/oauth"))
  })
})

/**
 * GitHub's device flow asks the user to TYPE a short code on github.com — it
 * cannot be prefilled, and there is no callback, so the screen has to show the
 * code and then keep asking whether it was approved.
 */
describe("the device-code flow", () => {
  const githubOAuth: CodeHostStatus = {
    integrations: [
      {
        id: "github",
        name: "GitHub",
        methods: ["oauth", "key"],
        prompts: [{ id: "token", label: "Fine-grained personal access token", secret: true }],
      },
    ],
    connections: [],
  }

  /** Starts a grant, then answers every poll from `polls` in order. */
  function deviceHost(polls: Array<Record<string, unknown>>) {
    let poll = -1
    return vi.fn(async (path: string) => {
      if (path.startsWith("/attempts/")) {
        poll += 1
        return new Response(JSON.stringify(polls[Math.min(poll, polls.length - 1)] ?? { status: "pending" }))
      }
      return new Response(
        JSON.stringify({
          url: "https://github.com/login/device",
          attemptId: "attempt-1",
          userCode: "WDJB-MJHT",
          intervalMs: 5000,
        }),
      )
    })
  }

  const started = (request: ReturnType<typeof deviceHost>, extra: Record<string, unknown> = {}) => {
    const view = render(() => (
      <DestinationSurface
        {...cloudProps}
        codeHosts={githubOAuth}
        onChoose={vi.fn()}
        codeHostRequest={request as never}
        codeHostPollSleep={async () => undefined}
        {...extra}
      />
    ))
    fireEvent.click(screen.getByRole("button", { name: "Connect GitHub" }))
    return view
  }

  test("shows the code the user has to type, copyable", async () => {
    started(deviceHost([{ status: "pending" }]))

    // The code is the instruction, so it is rendered rather than left in a URL
    // the user would have to read out of a browser tab.
    const field = (await screen.findByLabelText("Your code")) as HTMLInputElement
    expect(field.value).toBe("WDJB-MJHT")
    expect(field).toHaveAttribute("readonly")
    expect(screen.getByText(/Enter this code on GitHub/i)).toBeInTheDocument()
  })

  test("opens the verification page and keeps a way back to it", async () => {
    const openUrl = vi.fn()
    // Never resolves the poll, so the grant stays open for the assertion — the
    // real one sits here for as long as the user takes to approve it.
    started(deviceHost([{ status: "pending" }]), { openUrl, codeHostPollSleep: () => new Promise<void>(() => {}) })

    await vi.waitFor(() => expect(openUrl).toHaveBeenCalledWith("https://github.com/login/device"))
    // A user who closed the tab can reopen it without restarting the grant.
    const reopen = await screen.findByRole("button", { name: "Open GitHub" })
    fireEvent.click(reopen)
    expect(openUrl).toHaveBeenCalledTimes(2)
  })

  test("says it is waiting, rather than looking finished while it polls", async () => {
    started(deviceHost([{ status: "pending" }]))

    expect(await screen.findByText(/Waiting for you to approve it/i)).toBeInTheDocument()
  })

  test("polling through to approval reports the connection", async () => {
    const onCodeHostConnected = vi.fn()
    started(deviceHost([{ status: "pending" }, { status: "complete" }]), { onCodeHostConnected })

    await vi.waitFor(() => expect(onCodeHostConnected).toHaveBeenCalled())
    // The grant is settled, so its code stops being instructions.
    await vi.waitFor(() => expect(screen.queryByLabelText("Your code")).not.toBeInTheDocument())
  })

  test("a refused grant explains itself and offers a retry, never a raw code", async () => {
    const { container } = started(deviceHost([{ status: "expired" }]))

    expect(await screen.findByText(/expired before it was approved/i)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument()
    expect(container.textContent).not.toMatch(/expired_token|access_denied|status/)
  })

  test("a grant nobody approves gives up and says so, rather than polling forever", async () => {
    // GitHub stops honouring a device code after ~15 minutes, so a user who
    // walked away is told the code died rather than left on a live spinner.
    let polls = 0
    const request = vi.fn(async (path: string) => {
      if (path.startsWith("/attempts/")) {
        polls += 1
        return new Response(JSON.stringify({ status: "pending" }))
      }
      return new Response(
        JSON.stringify({
          url: "https://github.com/login/device",
          attemptId: "attempt-1",
          userCode: "WDJB-MJHT",
          intervalMs: 60_000,
        }),
      )
    })
    started(request as never)

    expect(await screen.findByText(/expired before it was approved/i)).toBeInTheDocument()
    // Bounded by the code's lifetime, not spinning without end.
    expect(polls).toBe(15)
  })

  test("the token stays reachable underneath, as a way out rather than a rival", async () => {
    render(() => (
      <DestinationSurface
        {...cloudProps}
        codeHosts={githubOAuth}
        onChoose={vi.fn()}
        codeHostRequest={deviceHost([]) as never}
      />
    ))

    // Signing in leads; the token is one click away and asks for nothing until
    // the user wants it.
    expect(screen.queryByLabelText("Fine-grained personal access token")).not.toBeInTheDocument()
    fireEvent.click(screen.getByText(/Prefer a token/i))
    expect(screen.getByLabelText("Fine-grained personal access token")).toBeInTheDocument()
  })

  test("the token fallback still connects on its own", async () => {
    const request = deviceHost([])
    const onCodeHostConnected = vi.fn()
    render(() => (
      <DestinationSurface
        {...cloudProps}
        codeHosts={githubOAuth}
        onChoose={vi.fn()}
        codeHostRequest={request as never}
        onCodeHostConnected={onCodeHostConnected}
      />
    ))

    fireEvent.click(screen.getByText(/Prefer a token/i))
    const input = screen.getByLabelText("Fine-grained personal access token") as HTMLInputElement
    input.value = "github_pat_abc"
    fireEvent.input(input)
    fireEvent.click(screen.getByRole("button", { name: "Use this token" }))

    await vi.waitFor(() => expect(onCodeHostConnected).toHaveBeenCalled())
    expect(JSON.parse(String(request.mock.calls[0]![1]!.body))).toEqual({ fields: {}, secret: "github_pat_abc" })
  })
})
