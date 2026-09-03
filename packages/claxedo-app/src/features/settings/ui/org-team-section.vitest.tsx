import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { AccountPort, AccountState } from "@/platform/account/account-port"
import { AccountPortProvider } from "@/platform/account/account-provider"
import { OrgTeamSettingsSection } from "./org-team-section"

const api = vi.hoisted(() => ({
  listOrgs: vi.fn(),
  listTeams: vi.fn(async () => []),
  listTeamMembers: vi.fn(async () => []),
  ensureDefaultTeam: vi.fn(async () => undefined),
  activeOrgId: undefined as string | undefined,
  activeTeamId: undefined as string | undefined,
}))

vi.mock("@/features/settings/data/org-team-api", () => ({
  addTeamMember: vi.fn(),
  createOrg: vi.fn(),
  createTeam: vi.fn(),
  ensureDefaultTeam: api.ensureDefaultTeam,
  listOrgs: api.listOrgs,
  listTeamMembers: api.listTeamMembers,
  listTeams: api.listTeams,
  readActiveOrgId: () => api.activeOrgId,
  readActiveTeamId: () => api.activeTeamId,
  removeTeamMember: vi.fn(),
  writeActiveOrgId: vi.fn(),
  writeActiveTeamId: vi.fn(),
}))

function port(state: AccountState, signIn = vi.fn(async () => {})): AccountPort {
  return {
    state: () => state,
    signIn,
    signOut: vi.fn(async () => {}),
    run: vi.fn(async () => undefined as never),
  }
}

function mount(account: AccountPort) {
  return render(() => (
    <AccountPortProvider port={account}>
      <OrgTeamSettingsSection />
    </AccountPortProvider>
  ))
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  api.activeOrgId = undefined
  api.activeTeamId = undefined
})

describe("OrgTeamSettingsSection account boundary", () => {
  test("does not request organizations while unsigned and offers sign in", async () => {
    api.activeOrgId = "org_from_previous_account"
    api.activeTeamId = "team_from_previous_account"
    const signIn = vi.fn(async () => {})
    mount(port({ status: "unsigned" }, signIn))

    expect(screen.getByText("Sign in to manage organizations and teams.")).toBeTruthy()
    expect(api.listOrgs).not.toHaveBeenCalled()
    expect(api.listTeams).not.toHaveBeenCalled()
    expect(api.listTeamMembers).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }))
    await waitFor(() => expect(signIn).toHaveBeenCalledOnce())
  })

  test("contains a signed request failure inside the settings panel", async () => {
    api.listOrgs.mockRejectedValueOnce(new Error("control plane unavailable"))
    mount(port({ status: "signed", identity: { userId: "user_1" } }))

    expect(await screen.findByText("Could not load organizations")).toBeTruthy()
    expect(screen.getByText("control plane unavailable")).toBeTruthy()
  })
})
