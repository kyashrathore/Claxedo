import { For, Show, createResource, createSignal, type Component } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { showToast } from "@opencode-ai/ui/toast"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import {
  addSessionParticipant,
  grantSessionShare,
  listSessionShares,
  listTeamsForActiveOrg,
  revokeSessionShare,
} from "@/features/session/data/session-share-api"

export const SessionPeopleControl: Component<{
  sessionId: string
  workspaceId: string
}> = (props) => {
  const [open, setOpen] = createSignal(false)
  const [personToken, setPersonToken] = createSignal("")
  const [teamPublicId, setTeamPublicId] = createSignal("")
  const [shares, { refetch }] = createResource(
    () => open() ? `${props.sessionId}:${props.workspaceId}` : undefined,
    async () => listSessionShares(props.sessionId, props.workspaceId),
  )
  const [teams] = createResource(
    () => open() ? "teams" : undefined,
    async () => listTeamsForActiveOrg(),
  )

  return (
    <DropdownMenu
      open={open()}
      onOpenChange={setOpen}
    >
      <DropdownMenu.Trigger
        as={Button}
        size="small"
        variant="ghost"
        aria-label="Session people"
      >
        <Icon name="share" size="small" />
        People
      </DropdownMenu.Trigger>
      <DropdownMenu.Content class="w-80 p-3 flex flex-col gap-3">
        <div class="text-12-medium text-text-strong">Share this private session</div>
        <p class="text-12-regular text-text-weak">
          Workspace access alone is not enough. Add a person or a team.
        </p>
        <div class="flex flex-col gap-2">
          <input
            class="w-full rounded-md border border-border-weak-base bg-transparent px-2 py-1.5 text-12-regular"
            placeholder="Person token identifier"
            value={personToken()}
            onInput={(event) => setPersonToken(event.currentTarget.value)}
          />
          <Button
            size="small"
            onClick={async () => {
              try {
                const token = personToken().trim()
                await addSessionParticipant({
                  sessionId: props.sessionId,
                  workspaceId: props.workspaceId,
                  participantTokenIdentifier: token,
                })
                await grantSessionShare({
                  sessionId: props.sessionId,
                  workspaceId: props.workspaceId,
                  grantedToTokenIdentifier: token,
                }).catch(() => undefined)
                setPersonToken("")
                await refetch()
                showToast({ title: "Person added to session" })
              } catch (error) {
                showToast({
                  title: "Could not add person",
                  description: error instanceof Error ? error.message : String(error),
                })
              }
            }}
          >
            Add person
          </Button>
        </div>
        <div class="flex flex-col gap-2">
          <select
            class="w-full rounded-md border border-border-weak-base bg-transparent px-2 py-1.5 text-12-regular"
            value={teamPublicId()}
            onChange={(event) => setTeamPublicId(event.currentTarget.value)}
          >
            <option value="">Share with team…</option>
            <For each={teams() ?? []}>
              {(team) => <option value={team.team_id}>{team.name}</option>}
            </For>
          </select>
          <Button
            size="small"
            onClick={async () => {
              const teamId = teamPublicId()
              if (!teamId) return
              try {
                await grantSessionShare({
                  sessionId: props.sessionId,
                  workspaceId: props.workspaceId,
                  grantedToTeamPublicId: teamId,
                })
                setTeamPublicId("")
                await refetch()
                showToast({ title: "Team shared on session" })
              } catch (error) {
                showToast({
                  title: "Could not share with team",
                  description: error instanceof Error ? error.message : String(error),
                })
              }
            }}
          >
            Add team
          </Button>
        </div>
        <Show when={shares()}>
          {(data) => (
            <div class="flex flex-col gap-1 max-h-40 overflow-auto">
              <For each={data().participants}>
                {(row) => (
                  <div class="text-12-regular text-text-weak">Participant {row.user_id}</div>
                )}
              </For>
              <For each={data().grants}>
                {(grant) => (
                  <div class="flex items-center justify-between gap-2 text-12-regular">
                    <span class="truncate">
                      {grant.granted_to_team_id
                        ? `Team ${grant.granted_to_team_id}`
                        : grant.granted_to_org_id
                          ? `Org ${grant.granted_to_org_id}`
                          : `User ${grant.granted_to_user_id}`}
                    </span>
                    <Button
                      size="small"
                      variant="ghost"
                      onClick={async () => {
                        try {
                          await revokeSessionShare({
                            sessionId: props.sessionId,
                            workspaceId: props.workspaceId,
                            grantId: grant.grant_id,
                          })
                          await refetch()
                        } catch (error) {
                          showToast({
                            title: "Could not revoke share",
                            description: error instanceof Error ? error.message : String(error),
                          })
                        }
                      }}
                    >
                      Remove
                    </Button>
                  </div>
                )}
              </For>
            </div>
          )}
        </Show>
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}
