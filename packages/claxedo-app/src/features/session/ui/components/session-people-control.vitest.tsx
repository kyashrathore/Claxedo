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

const toast = vi.hoisted(() => ({ showToast: vi.fn() }))

vi.mock("@opencode-ai/ui/toast", () => toast)
vi.mock("@/ui/controls/claxedo-icon", () => ({ ClaxedoIcon: () => null }))

import { SessionPeopleControl } from "./session-people-control"

beforeEach(() => {
  peopleApi.grantSessionShare.mockReset()
  peopleApi.listSessionShares.mockReset()
  peopleApi.revokeSessionShare.mockReset()
  toast.showToast.mockReset()
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
    expect(view.getByText("Can follow", { selector: "span" })).toBeInTheDocument()
    fireEvent.click(view.getByRole("button", { name: "Share with Backend" }))
    await waitFor(() => {
      expect(peopleApi.grantSessionShare).toHaveBeenCalledWith({
        sessionId: "ses_1",
        workspaceId: "ws_1",
        grantedToTeamPublicId: "team_backend",
        level: "follow",
      })
    })
  })

  test("revokes a shared team from its named team row", async () => {
    peopleApi.listSessionShares.mockResolvedValue({
      can_manage_shares: true,
      grants: [{ grant_id: "ssg_everyone", granted_to_team_id: "team_everyone", level: "follow" }],
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
        level: "follow",
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
        level: "follow",
      }],
    })
    peopleApi.revokeSessionShare.mockResolvedValue({ revoked: true })
    const view = render(() => <SessionPeopleControl sessionId="ses_1" workspaceId="ws_1" />)

    await view.findByText("User user_bob")
    fireEvent.click(view.getByRole("button", { name: "Remove User user_bob from session" }))

    await waitFor(() => {
      expect(peopleApi.revokeSessionShare).toHaveBeenCalledWith({
        sessionId: "ses_1",
        workspaceId: "ws_1",
        grantId: "ssg_bob",
      })
    })
  })
})

const DISCLOSURE =
  "The agent runs on the workspace's machine with that machine's files. A teammate who can send "
  + "messages can ask it to read anything there, including the transcripts of your other sessions "
  + "in this workspace. Sharing works best for sessions on a cloud environment, where each session "
  + "has a machine of its own. If this machine holds anything you would not want a teammate to "
  + "reach, do not share sessions from workspaces on it."

describe("SessionPeopleControl share levels", () => {
  async function openControl(context?: Partial<{
    grants: unknown[]
    participants: unknown[]
    teams: unknown[]
  }>) {
    peopleApi.listSessionShares.mockResolvedValue({
      can_manage_shares: true,
      grants: [],
      participants: [],
      teams: [],
      ...context,
    })
    const view = render(() => <SessionPeopleControl sessionId="ses_1" workspaceId="ws_1" />)
    await view.findByText("Share", { selector: "div" })
    return view
  }

  test("grants at follow without showing the disclosure", async () => {
    const view = await openControl()

    fireEvent.input(await view.findByPlaceholderText("Person token identifier"), {
      target: { value: "https://issuer.test|user_bob" },
    })
    fireEvent.click(view.getByText("Add person"))

    await waitFor(() => {
      expect(peopleApi.grantSessionShare).toHaveBeenCalledWith({
        sessionId: "ses_1",
        workspaceId: "ws_1",
        level: "follow",
        grantedToTokenIdentifier: "https://issuer.test|user_bob",
      })
    })
    expect(view.queryByText(DISCLOSURE)).not.toBeInTheDocument()
  })

  test("a send grant is held behind the verbatim disclosure until it is acknowledged", async () => {
    const view = await openControl()

    fireEvent.input(await view.findByPlaceholderText("Person token identifier"), {
      target: { value: "https://issuer.test|user_bob" },
    })
    fireEvent.change(view.getByLabelText("Share level"), { target: { value: "send" } })
    fireEvent.click(view.getByText("Add person"))

    expect(await view.findByText(DISCLOSURE)).toBeInTheDocument()
    expect(peopleApi.grantSessionShare).not.toHaveBeenCalled()
    const confirm = view.getByRole("button", { name: "Allow sending: Person added to session" })
    expect(confirm).toBeDisabled()

    fireEvent.click(confirm)
    expect(peopleApi.grantSessionShare).not.toHaveBeenCalled()

    fireEvent.click(view.getByRole("checkbox"))
    fireEvent.click(view.getByRole("button", { name: "Allow sending: Person added to session" }))

    await waitFor(() => {
      expect(peopleApi.grantSessionShare).toHaveBeenCalledWith({
        sessionId: "ses_1",
        workspaceId: "ws_1",
        level: "send",
        grantedToTokenIdentifier: "https://issuer.test|user_bob",
      })
    })
  })

  test("cancelling the disclosure sends nothing and clears the acknowledgement", async () => {
    const view = await openControl()

    fireEvent.input(await view.findByPlaceholderText("Person token identifier"), {
      target: { value: "https://issuer.test|user_bob" },
    })
    fireEvent.change(view.getByLabelText("Share level"), { target: { value: "send" } })
    fireEvent.click(view.getByText("Add person"))
    fireEvent.click(await view.findByRole("checkbox"))
    fireEvent.click(view.getByText("Cancel"))

    expect(peopleApi.grantSessionShare).not.toHaveBeenCalled()
    expect(view.queryByText(DISCLOSURE)).not.toBeInTheDocument()

    fireEvent.click(view.getByText("Add person"))
    expect(await view.findByRole("checkbox")).not.toBeChecked()
    expect(view.getByRole("button", { name: "Allow sending: Person added to session" })).toBeDisabled()
  })

  test("downgrades a sending grant from its own row with no disclosure", async () => {
    const view = await openControl({
      grants: [{ grant_id: "ssg_bob", granted_to_user_id: "user_bob", level: "send" }],
    })

    expect(await view.findByText("Can send messages", { selector: "span" })).toBeInTheDocument()
    fireEvent.click(view.getByRole("button", { name: "Limit User user_bob to following" }))

    await waitFor(() => {
      expect(peopleApi.grantSessionShare).toHaveBeenCalledWith({
        sessionId: "ses_1",
        workspaceId: "ws_1",
        level: "follow",
        grantedToUserId: "user_bob",
      })
    })
    expect(view.queryByText(DISCLOSURE)).not.toBeInTheDocument()
  })

  test("raising an existing follow grant to send passes through the same disclosure gate", async () => {
    const view = await openControl({
      grants: [{ grant_id: "ssg_bob", granted_to_user_id: "user_bob", level: "follow" }],
    })

    fireEvent.click(await view.findByRole("button", { name: "Let User user_bob send messages" }))

    expect(await view.findByText(DISCLOSURE)).toBeInTheDocument()
    expect(peopleApi.grantSessionShare).not.toHaveBeenCalled()
    fireEvent.click(view.getByRole("checkbox"))
    fireEvent.click(view.getByRole("button", { name: "Allow sending: User user_bob on this session" }))

    await waitFor(() => {
      expect(peopleApi.grantSessionShare).toHaveBeenCalledWith({
        sessionId: "ses_1",
        workspaceId: "ws_1",
        level: "send",
        grantedToUserId: "user_bob",
      })
    })
  })

  test("a refused send grant reports the plane's reason and leaves the disclosure open", async () => {
    const view = await openControl()
    peopleApi.grantSessionShare.mockRejectedValueOnce(
      new Error("That person can follow this session, but they cannot be allowed to send messages on it."),
    )

    fireEvent.input(await view.findByPlaceholderText("Person token identifier"), {
      target: { value: "https://issuer.test|user_bob" },
    })
    fireEvent.change(view.getByLabelText("Share level"), { target: { value: "send" } })
    fireEvent.click(view.getByText("Add person"))
    fireEvent.click(await view.findByRole("checkbox"))
    fireEvent.click(view.getByRole("button", { name: "Allow sending: Person added to session" }))

    await waitFor(() => {
      expect(toast.showToast).toHaveBeenCalledWith({
        title: "Could not share this session",
        description: "That person can follow this session, but they cannot be allowed to send messages on it.",
      })
    })
    expect(view.getByText(DISCLOSURE)).toBeInTheDocument()
  })

  test("a shared team shows its level and revokes from the same row", async () => {
    peopleApi.revokeSessionShare.mockResolvedValue({ revoked: true })
    const view = await openControl({
      grants: [{ grant_id: "ssg_eng", granted_to_team_id: "team_eng", level: "send" }],
      teams: [{ team_id: "team_eng", name: "Engineering", is_shared: true }],
    })

    expect(await view.findByText("Can send messages", { selector: "span" })).toBeInTheDocument()
    fireEvent.click(view.getByRole("button", { name: "Remove Engineering from session" }))

    await waitFor(() => {
      expect(peopleApi.revokeSessionShare).toHaveBeenCalledWith({
        sessionId: "ses_1",
        workspaceId: "ws_1",
        grantedToTeamPublicId: "team_eng",
      })
    })
  })
})
