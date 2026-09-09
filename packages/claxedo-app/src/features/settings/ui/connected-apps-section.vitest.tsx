import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { ErrorBoundary } from "solid-js"
import { afterEach, expect, test, vi } from "vitest"

import { ConnectedAppsSettingsSection } from "./connected-apps-section"
import { cloudStrings } from "@/platform/i18n/cloud-strings"

afterEach(() => cleanup())

const t = (key: string) => (cloudStrings.en as Record<string, string>)[key] ?? key

test("lists what an account has consented to and revokes one", async () => {
  const revoke = vi.fn(async () => undefined)
  let remaining = [
    { consentId: "consent-1", clientId: "aBcD", name: "Cursor", scopes: ["claxedo:read", "claxedo:act"] },
    { consentId: "consent-2", clientId: "claxedo-cli", name: "Claxedo CLI", scopes: ["workspace:read"] },
  ]

  render(() => (
    <ConnectedAppsSettingsSection
      t={t}
      list={async () => remaining}
      revoke={async (consentId) => {
        await revoke()
        remaining = remaining.filter((app) => app.consentId !== consentId)
      }}
    />
  ))

  expect(await screen.findByText("Cursor")).toBeInTheDocument()
  expect(screen.getByText("claxedo:read, claxedo:act")).toBeInTheDocument()
  expect(screen.getByText("Claxedo CLI")).toBeInTheDocument()

  fireEvent.click(screen.getAllByRole("button", { name: "Disconnect" })[0])

  await waitFor(() => expect(screen.queryByText("Cursor")).not.toBeInTheDocument())
  expect(revoke).toHaveBeenCalledTimes(1)
  expect(screen.getByText("Claxedo CLI")).toBeInTheDocument()
})

test("keeps a failed revoke on the page with the account's apps intact", async () => {
  render(() => (
    <ConnectedAppsSettingsSection
      t={t}
      list={async () => [{ consentId: "consent-1", clientId: "aBcD", name: "Cursor", scopes: ["claxedo:read"] }]}
      revoke={async () => {
        throw new Error("Consent record is gone")
      }}
    />
  ))

  fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }))

  expect(await screen.findByRole("alert")).toHaveTextContent("Consent record is gone")
  expect(screen.getByText("Cursor")).toBeInTheDocument()
})

test("says so when nothing has been connected", async () => {
  render(() => <ConnectedAppsSettingsSection t={t} list={async () => []} revoke={vi.fn()} />)

  expect(await screen.findByText("No application has been given access to your Claxedo account."))
    .toBeInTheDocument()
})

/**
 * A build whose consent endpoint answers 404 threw out of this section, past
 * the dialog it renders in, into the application's own ErrorBoundary — which
 * replaced the whole app with the error page.
 */
test("reports a list that could not be loaded without throwing out of the section", async () => {
  render(() => (
    <ErrorBoundary fallback={() => <div>escaped to the boundary</div>}>
      <ConnectedAppsSettingsSection
        t={t}
        list={async () => {
          throw new Error("Connected applications are unavailable")
        }}
        revoke={vi.fn()}
      />
    </ErrorBoundary>
  ))

  expect(await screen.findByRole("alert")).toHaveTextContent("Connected applications are unavailable")
  expect(screen.queryByText("escaped to the boundary")).not.toBeInTheDocument()
  expect(screen.getByText("No application has been given access to your Claxedo account.")).toBeInTheDocument()
})
