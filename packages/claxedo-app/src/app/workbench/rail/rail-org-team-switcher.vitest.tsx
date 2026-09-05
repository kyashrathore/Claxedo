import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { AccountPort, AccountState } from "@/platform/account/account-port"
import { AccountPortProvider } from "@/platform/account/account-provider"
import { RailOrgTeamSwitcher } from "./rail-org-team-switcher"

const api = vi.hoisted(() => ({
  listOrgs: vi.fn(async () => [] as Array<{ org_id: string; name: string }>),
}))

vi.mock("@/features/settings/data/org-team-api", () => ({
  ensureDefaultTeam: vi.fn(async () => undefined),
  listOrgs: api.listOrgs,
  listTeams: vi.fn(async () => []),
  readActiveOrgId: () => undefined,
  readActiveTeamId: () => undefined,
  writeActiveOrgId: vi.fn(),
  writeActiveTeamId: vi.fn(),
}))

vi.mock("./rail-account-menu", () => ({
  RailAccountSubmenu: (props: { label: string; children?: unknown }) => (
    <div data-testid="submenu">{props.label}</div>
  ),
}))

function port(state: AccountState): AccountPort {
  return {
    state: () => state,
    signIn: vi.fn(async () => {}),
    signOut: vi.fn(async () => {}),
    run: vi.fn(async () => undefined as never),
  }
}

function mount(account: AccountPort) {
  return render(() => (
    <AccountPortProvider port={account}>
      <RailOrgTeamSwitcher />
    </AccountPortProvider>
  ))
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("RailOrgTeamSwitcher account boundary", () => {
  test("renders nothing and asks for no organizations while the account is unsigned", async () => {
    mount(port({ status: "unsigned" }))
    await Promise.resolve()
    expect(screen.queryByTestId("submenu")).toBeNull()
    expect(api.listOrgs).not.toHaveBeenCalled()
  })

  test("offers the organization picker once the account is signed", async () => {
    mount(port({ status: "signed", identity: { userId: "user_1" } }))
    await waitFor(() => expect(screen.getByTestId("submenu").textContent).toBe("Select organization"))
    expect(api.listOrgs).toHaveBeenCalledTimes(1)
  })
})
