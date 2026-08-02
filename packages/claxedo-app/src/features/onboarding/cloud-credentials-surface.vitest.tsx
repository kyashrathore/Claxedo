import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { describe, expect, test, vi } from "vitest"
import { CloudCredentialsSurface } from "./cloud-credentials-surface"
import type { OnboardingCredential } from "./state"

const claudeLogin: OnboardingCredential = {
  id: "cred-claude",
  providerId: "claude-sdk",
  kind: "oauth_token",
  scope: "local",
  machineId: "machine-a",
  verification: "ok",
  label: "Claude Code login · agent SDK",
}

const codexLogin: OnboardingCredential = {
  id: "cred-codex",
  providerId: "codex-acp",
  kind: "oauth_token",
  scope: "local",
  machineId: "machine-a",
  verification: "ok",
  label: "Synced from local Codex auth",
}

describe("CloudCredentialsSurface", () => {
  test("a discovered Claude Code login is listed without a Share checkbox", () => {
    render(() => (
      <CloudCredentialsSurface candidates={[codexLogin]} blocked={[claudeLogin]} shared={[]} request={vi.fn()} />
    ))

    expect(screen.getByText("Claude Code login · agent SDK")).toBeInTheDocument()
    const boxes = screen.getAllByRole("checkbox")
    expect(boxes).toHaveLength(1)
    expect(screen.getByText("Synced from local Codex auth")).toBeInTheDocument()
  })

  test("the unshareable row says why and points at setup-token", () => {
    render(() => <CloudCredentialsSurface candidates={[]} blocked={[claudeLogin]} shared={[]} request={vi.fn()} />)

    expect(screen.getByText(/Claude Code owns this login/i)).toBeInTheDocument()
    expect(screen.getByText(/claude setup-token/i)).toBeInTheDocument()
    // Not the dead-end copy: there IS something here, it just cannot travel.
    expect(screen.queryByText(/No credentials on this machine are available to share/i)).not.toBeInTheDocument()
  })

  test("a non-shareable credential handed in as a candidate is still never offered", () => {
    render(() => <CloudCredentialsSurface candidates={[claudeLogin, codexLogin]} shared={[]} request={vi.fn()} />)

    expect(screen.getAllByRole("checkbox")).toHaveLength(1)
    expect(screen.getByText(/claude setup-token/i)).toBeInTheDocument()
  })

  test("a setup-token and an API key are both offered", () => {
    const setupToken: OnboardingCredential = { ...claudeLogin, id: "cred-token", kind: "api_key", label: "Claude setup token" }
    const apiKey: OnboardingCredential = { ...claudeLogin, id: "cred-key", providerId: "anthropic", kind: "api_key", label: "Anthropic API key" }
    render(() => <CloudCredentialsSurface candidates={[setupToken, apiKey]} shared={[]} request={vi.fn()} />)

    expect(screen.getAllByRole("checkbox")).toHaveLength(2)
    expect(screen.queryByText(/claude setup-token/i)).not.toBeInTheDocument()
  })

  test("submitting shares only the offerable rows", async () => {
    const shared: Array<{ credentialId?: string; action?: string }> = []
    const request = vi.fn(async (input: { credentialId?: string; action?: string }) => {
      shared.push(input)
      return Response.json({})
    })
    let submit: { run: () => Promise<void>; count: () => number } | undefined
    render(() => (
      <CloudCredentialsSurface
        candidates={[claudeLogin, codexLogin]}
        shared={[]}
        request={request as never}
        registerSubmit={(value) => (submit = value)}
      />
    ))

    expect(submit?.count()).toBe(1)
    await submit?.run()
    expect(shared).toMatchObject([{ credentialId: "cred-codex", action: "scope" }])
  })

  test("the share button lives in the body, counting only what it will act on", () => {
    // The footer is navigation-only; a button that widens who can spend a
    // credential belongs beside the rows it acts on.
    render(() => <CloudCredentialsSurface candidates={[claudeLogin, codexLogin]} shared={[]} request={vi.fn()} />)

    expect(screen.getByRole("button", { name: "Share 1 credential" })).toBeInTheDocument()
  })

  test("the body button shares, with no action bar registered at all", async () => {
    const shared: Array<{ credentialId?: string }> = []
    const request = vi.fn(async (input: { credentialId?: string }) => {
      shared.push(input)
      return Response.json({})
    })
    render(() => <CloudCredentialsSurface candidates={[codexLogin]} shared={[]} request={request as never} />)

    fireEvent.click(screen.getByRole("button", { name: "Share 1 credential" }))
    await waitFor(() => expect(shared).toMatchObject([{ credentialId: "cred-codex" }]))
  })

  test("deselecting every row retires the button rather than offering a no-op", async () => {
    render(() => <CloudCredentialsSurface candidates={[codexLogin]} shared={[]} request={vi.fn()} />)

    expect(screen.getByRole("button", { name: "Share 1 credential" })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("checkbox"))
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Share/ })).not.toBeInTheDocument())
  })

  test("an unshareable-only step offers no share button to press", () => {
    render(() => <CloudCredentialsSurface candidates={[]} blocked={[claudeLogin]} shared={[]} request={vi.fn()} />)

    expect(screen.queryByRole("button", { name: /^Share/ })).not.toBeInTheDocument()
    expect(screen.getByText(/claude setup-token/i)).toBeInTheDocument()
  })
})
