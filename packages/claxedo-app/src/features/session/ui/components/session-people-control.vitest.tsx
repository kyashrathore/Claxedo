import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library"
import { createSignal, type JSX } from "solid-js"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const peopleApi = vi.hoisted(() => ({
  grantSessionShare: vi.fn(),
  listSessionShares: vi.fn(),
  revokeSessionShare: vi.fn(),
}))

const dropdown = vi.hoisted(() => ({
  onOpenChange: undefined as undefined | ((open: boolean) => void),
}))

vi.mock("@/features/session/data/session-share-api", () => peopleApi)

vi.mock("@opencode-ai/ui/button", () => ({
  Button: (props: { children?: JSX.Element; onClick?: () => void; "aria-label"?: string; disabled?: boolean }) => (
    <button type="button" aria-label={props["aria-label"]} disabled={props.disabled} onClick={props.onClick}>
      {props.children}
    </button>
  ),
}))

vi.mock("@opencode-ai/ui/dropdown-menu", () => {
  const Root = (props: { children?: JSX.Element; onOpenChange?: (open: boolean) => void }) => {
    dropdown.onOpenChange = props.onOpenChange
    return <div>{props.children}</div>
  }
  const Part = (props: { children?: JSX.Element }) => <div>{props.children}</div>
  return {
    DropdownMenu: Object.assign(Root, {
      Trigger: Part,
      Portal: Part,
      Content: Part,
    }),
  }
})

vi.mock("@opencode-ai/ui/toast", () => ({ showToast: vi.fn() }))
vi.mock("@/ui/controls/claxedo-icon", () => ({ ClaxedoIcon: () => null }))

import { SessionPeopleControl } from "./session-people-control"

beforeEach(() => {
  peopleApi.grantSessionShare.mockReset()
  peopleApi.listSessionShares.mockReset()
  peopleApi.revokeSessionShare.mockReset()
  dropdown.onOpenChange = undefined
  peopleApi.listSessionShares.mockResolvedValue({
    can_manage_shares: true,
    grants: [],
    participants: [],
    teams: [],
  })
  peopleApi.grantSessionShare.mockResolvedValue({ grant_id: "ssg_1" })
})

afterEach(cleanup)

describe("SessionPeopleControl person mutation", () => {
  test("hides the prior session's capability while a new session is loading", async () => {
    let setTarget!: (target: { sessionId: string; workspaceId: string }) => void
    let resolveSecond!: (value: {
      can_manage_shares: boolean
      grants: []
      participants: []
      teams: []
    }) => void
    peopleApi.listSessionShares
      .mockResolvedValueOnce({ can_manage_shares: true, grants: [], participants: [], teams: [] })
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve }))
    const view = render(() => {
      const [target, set] = createSignal({ sessionId: "ses_1", workspaceId: "ws_1" })
      setTarget = set
      return <SessionPeopleControl sessionId={target().sessionId} workspaceId={target().workspaceId} />
    })

    await view.findByText("Share", { selector: "div" })
    setTarget({ sessionId: "ses_2", workspaceId: "ws_2" })

    await waitFor(() => expect(peopleApi.listSessionShares).toHaveBeenCalledTimes(2))
    expect(view.queryByText("Share", { selector: "div" })).not.toBeInTheDocument()

    resolveSecond({ can_manage_shares: false, grants: [], participants: [], teams: [] })
    await waitFor(() => expect(view.queryByText("Share", { selector: "div" })).not.toBeInTheDocument())
  })

  test("offers a fail-closed retry after the People lookup fails", async () => {
    peopleApi.listSessionShares
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce({ can_manage_shares: true, grants: [], participants: [], teams: [] })
    const view = render(() => <SessionPeopleControl sessionId="ses_1" workspaceId="ws_1" />)

    const retry = await view.findByRole("button", { name: "Retry sharing controls" })
    expect(view.queryByText("Share", { selector: "div" })).not.toBeInTheDocument()
    fireEvent.click(retry)

    expect(await view.findByText("Share", { selector: "div" })).toBeInTheDocument()
  })

  test("refreshes People data when the menu opens", async () => {
    const view = render(() => <SessionPeopleControl sessionId="ses_1" workspaceId="ws_1" />)

    await view.findByText("Share", { selector: "div" })
    const callsBeforeOpen = peopleApi.listSessionShares.mock.calls.length
    dropdown.onOpenChange?.(true)

    await waitFor(() => expect(peopleApi.listSessionShares).toHaveBeenCalledTimes(callsBeforeOpen + 1))
  })

  test("renders no sharing controls for a session reader who cannot manage shares", async () => {
    peopleApi.listSessionShares.mockResolvedValue({
      can_manage_shares: false,
      grants: [],
      participants: [],
      teams: [],
    })
    const view = render(() => <SessionPeopleControl sessionId="ses_1" workspaceId="ws_1" />)

    await waitFor(() => expect(peopleApi.listSessionShares).toHaveBeenCalled())
    expect(view.queryByLabelText("Share session")).not.toBeInTheDocument()
    expect(view.queryByText("Add person")).not.toBeInTheDocument()
  })

  test("shows the session organization's teams as a visible list", async () => {
    peopleApi.listSessionShares.mockResolvedValue({
      can_manage_shares: true,
      grants: [],
      participants: [],
      teams: [
        { team_id: "team_everyone", name: "Everyone", is_shared: true },
        { team_id: "team_backend", name: "Backend", is_shared: false },
      ],
    })
    const view = render(() => <SessionPeopleControl sessionId="ses_1" workspaceId="ws_1" />)

    expect(await view.findByText("Everyone")).toBeInTheDocument()
    expect(view.getByText("Backend")).toBeInTheDocument()
    expect(view.getByText("Shared")).toBeInTheDocument()
    fireEvent.click(view.getByRole("button", { name: "Share with Backend" }))
    await waitFor(() => {
      expect(peopleApi.grantSessionShare).toHaveBeenCalledWith({
        sessionId: "ses_1",
        workspaceId: "ws_1",
        grantedToTeamPublicId: "team_backend",
      })
    })
    expect(view.queryByRole("combobox")).not.toBeInTheDocument()
  })

  test("revokes a shared team from its named team row", async () => {
    peopleApi.listSessionShares.mockResolvedValue({
      can_manage_shares: true,
      grants: [{ grant_id: "ssg_everyone", granted_to_team_id: "team_everyone" }],
      participants: [],
      teams: [{ team_id: "team_everyone", name: "Everyone", is_shared: true }],
    })
    peopleApi.revokeSessionShare.mockResolvedValue({ revoked: true })
    const view = render(() => <SessionPeopleControl sessionId="ses_1" workspaceId="ws_1" />)

    fireEvent.click(await view.findByRole("button", { name: "Remove Everyone from session" }))

    await waitFor(() => {
      expect(peopleApi.revokeSessionShare).toHaveBeenCalledWith({
        sessionId: "ses_1",
        workspaceId: "ws_1",
        grantedToTeamPublicId: "team_everyone",
      })
    })
    expect(view.queryByText("Team team_everyone")).not.toBeInTheDocument()
  })

  test("creates one removable user share without separately enrolling a participant", async () => {
    const view = render(() => <SessionPeopleControl sessionId="ses_1" workspaceId="ws_1" />)

    fireEvent.input(await view.findByPlaceholderText("Person token identifier"), {
      target: { value: "  https://issuer.test|user_bob  " },
    })
    fireEvent.click(view.getByText("Add person"))

    await waitFor(() => {
      expect(peopleApi.grantSessionShare).toHaveBeenCalledWith({
        sessionId: "ses_1",
        workspaceId: "ws_1",
        grantedToTokenIdentifier: "https://issuer.test|user_bob",
      })
    })
  })

  test("removes the effective user share by its canonical grant id", async () => {
    peopleApi.listSessionShares.mockResolvedValue({
      can_manage_shares: true,
      participants: [],
      teams: [],
      grants: [{
        grant_id: "ssg_bob",
        granted_to_user_id: "user_bob",
      }],
    })
    peopleApi.revokeSessionShare.mockResolvedValue({ revoked: true })
    const view = render(() => <SessionPeopleControl sessionId="ses_1" workspaceId="ws_1" />)

    await view.findByText("User user_bob")
    fireEvent.click(view.getByText("Remove"))

    await waitFor(() => {
      expect(peopleApi.revokeSessionShare).toHaveBeenCalledWith({
        sessionId: "ses_1",
        workspaceId: "ws_1",
        grantId: "ssg_bob",
      })
    })
  })
})
