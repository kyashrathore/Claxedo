import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library"
import { onMount, type JSX } from "solid-js"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const peopleApi = vi.hoisted(() => ({
  addSessionParticipant: vi.fn(),
  grantSessionShare: vi.fn(),
  listSessionShares: vi.fn(),
  listTeamsForActiveOrg: vi.fn(),
  revokeSessionShare: vi.fn(),
}))

vi.mock("@/features/session/data/session-share-api", () => peopleApi)

vi.mock("@opencode-ai/ui/button", () => ({
  Button: (props: { children?: JSX.Element; onClick?: () => void }) => (
    <button type="button" onClick={props.onClick}>{props.children}</button>
  ),
}))

vi.mock("@opencode-ai/ui/dropdown-menu", () => {
  const Root = (props: { children?: JSX.Element; onOpenChange?: (open: boolean) => void }) => {
    onMount(() => props.onOpenChange?.(true))
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
  vi.clearAllMocks()
  peopleApi.listSessionShares.mockResolvedValue({ grants: [], participants: [] })
  peopleApi.listTeamsForActiveOrg.mockResolvedValue([])
  peopleApi.addSessionParticipant.mockResolvedValue({ participant_id: "ses_1:user_bob" })
  peopleApi.grantSessionShare.mockResolvedValue({ grant_id: "ssg_1" })
})

afterEach(cleanup)

describe("SessionPeopleControl person mutation", () => {
  test("creates one removable user share without separately enrolling a participant", async () => {
    const view = render(() => <SessionPeopleControl sessionId="ses_1" workspaceId="ws_1" />)

    fireEvent.input(view.getByPlaceholderText("Person token identifier"), {
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
    expect(peopleApi.addSessionParticipant).not.toHaveBeenCalled()
  })

  test("removes the effective user share by its canonical grant id", async () => {
    peopleApi.listSessionShares.mockResolvedValue({
      participants: [],
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
    expect(peopleApi.addSessionParticipant).not.toHaveBeenCalled()
  })
})
