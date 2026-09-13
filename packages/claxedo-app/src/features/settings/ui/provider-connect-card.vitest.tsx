import { cleanup, render } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"
import { lazy, Suspense } from "solid-js"
import { ProviderConnectCard } from "./provider-connect-card"
import { engineConnectContext, harnessConnectContext } from "@/platform/identity/harness-catalog"

const state = { suspend: false }

vi.mock("@/features/settings/app-ports", () => {
  // The real form is code-split, so the thing under test is what happens while
  // its chunk is still in flight.
  const NeverArrives = lazy(() => new Promise<never>(() => undefined))
  return {
    ProviderConnectForm: (props: { provider: string }) =>
      state.suspend
        ? <NeverArrives />
        : <div data-testid="connect-form" data-provider={props.provider} />,
  }
})

vi.mock("@/platform/i18n/provider", () => ({
  useLanguage: () => ({
    t: (key: string, vars?: Record<string, string>) => (vars ? `${key}:${Object.values(vars).join("|")}` : key),
  }),
}))

afterEach(() => {
  cleanup()
  state.suspend = false
})

function card(extra: Partial<Parameters<typeof ProviderConnectCard>[0]> = {}) {
  return render(() => (
    <Suspense fallback={<div data-testid="shell-fallback" />}>
      <ProviderConnectCard
        provider="claude-sdk"
        context={harnessConnectContext("claude")}
        harness="claude"
        onClose={() => undefined}
        {...extra}
      />
    </Suspense>
  ))
}

function heading() {
  return document.querySelector('[data-component="provider-connect-card"] span')?.textContent ?? ""
}

describe("ProviderConnectCard", () => {
  test("a harness login is titled by the harness, not by the id it is stored under", () => {
    card()

    expect(heading()).toBe("provider.connect.title.harness:Claude Code|Anthropic")
    expect(document.querySelector('[data-component="provider-connect-card"]')?.textContent)
      .not.toContain("claude-sdk")
  })

  test("a vendor inside an engine is titled for both of them", () => {
    card({ provider: "anthropic", context: engineConnectContext("pi", "Anthropic"), harness: "pi" })

    expect(heading()).toBe("provider.connect.title.engine:Pi|Anthropic")
  })

  test("reconnecting names the same subject and says what it replaces", () => {
    card({ credentialId: "cred_1" })

    expect(heading()).toBe("settings.providers.connect.reconnectTitle:Claude Code")
    expect(document.querySelector('[data-component="provider-connect-card"]')?.getAttribute("data-credential"))
      .toBe("cred_1")
  })

  test("the form's own boundary absorbs the chunk load, so the shell never falls back", () => {
    // `lazy` suspends the nearest boundary. Without one here that is the app
    // shell, and opening this card read as a page reload.
    state.suspend = true

    card()

    expect(document.querySelector('[data-testid="shell-fallback"]')).toBeNull()
    expect(document.querySelector('[data-component="provider-connect-loading"]')).not.toBeNull()
    expect(heading()).toBe("provider.connect.title.harness:Claude Code|Anthropic")
  })
})
