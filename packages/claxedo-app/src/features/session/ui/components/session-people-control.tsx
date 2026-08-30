import { For, Show, createResource, createSignal, type Component } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { showToast } from "@opencode-ai/ui/toast"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import {
  grantSessionShare,
  listSessionShares,
  revokeSessionShare,
} from "@/features/session/data/session-share-api"

export const SessionPeopleControl: Component<{
  sessionId: string
  workspaceId: string
}> = (props) => {
  const [open, setOpen] = createSignal(false)
  const [personToken, setPersonToken] = createSignal("")
  const peopleKey = () => `${props.sessionId}:${props.workspaceId}`
  const [people, { refetch }] = createResource(
    peopleKey,
    async (key) => ({
      key,
      context: await listSessionShares(props.sessionId, props.workspaceId),
    }),
  )
  const manageable = () => {
    const data = people.state === "ready" || people.state === "refreshing" ? people.latest : undefined
    return data?.key === peopleKey() && data.context.can_manage_shares ? data.context : undefined
  }

  return (
    <>
      <Show when={people.error}>
        <Button
          size="small"
          variant="ghost"
          aria-label="Retry sharing controls"
          onClick={() => void refetch()}
        >
          Retry
        </Button>
      </Show>
      <Show when={manageable()}>
        {(data) => (
          <DropdownMenu
            open={open()}
            onOpenChange={(next) => {
              setOpen(next)
              if (next) void refetch()
            }}
          >
          <DropdownMenu.Trigger
            as={Button}
            size="small"
            variant="ghost"
            aria-label="Share session"
          >
            <Icon name="share" size="small" />
            Share
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content class="z-[220] w-80 p-3 flex flex-col gap-3">
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
                      if (!token) return
                      await grantSessionShare({
                        sessionId: props.sessionId,
                        workspaceId: props.workspaceId,
                        grantedToTokenIdentifier: token,
                      })
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
                <div class="text-12-medium text-text-strong">Teams</div>
                <Show
                  when={data().teams.length > 0}
                  fallback={<p class="text-12-regular text-text-weak">No teams are available for this workspace.</p>}
                >
                  <div class="flex flex-col gap-1">
                    <For each={data().teams}>
                      {(team) => (
                        <div class="flex items-center justify-between gap-2 rounded-md border border-border-weak-base px-2 py-1.5">
                          <span class="min-w-0 truncate text-12-regular text-text-strong">{team.name}</span>
                          <Show
                            when={!team.is_shared}
                            fallback={(
                              <div class="flex items-center gap-1">
                                <span class="text-12-regular text-text-weak">Shared</span>
                                <Button
                                  size="small"
                                  variant="ghost"
                                  aria-label={`Remove ${team.name} from session`}
                                  onClick={async () => {
                                    try {
                                      await revokeSessionShare({
                                        sessionId: props.sessionId,
                                        workspaceId: props.workspaceId,
                                        grantedToTeamPublicId: team.team_id,
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
                          >
                            <Button
                              size="small"
                              variant="ghost"
                              aria-label={`Share with ${team.name}`}
                              onClick={async () => {
                                try {
                                  await grantSessionShare({
                                    sessionId: props.sessionId,
                                    workspaceId: props.workspaceId,
                                    grantedToTeamPublicId: team.team_id,
                                  })
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
                              Share
                            </Button>
                          </Show>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
              </div>
              <div class="flex flex-col gap-1 max-h-40 overflow-auto">
                <Show
                  when={data().participants.length > 0 || data().grants.some((grant) => !grant.granted_to_team_id)}
                  fallback={<p class="text-12-regular text-text-weak">No people have been added yet.</p>}
                >
                  <For each={data().participants}>
                    {(row) => (
                      <div class="text-12-regular text-text-weak">Participant {row.user_id}</div>
                    )}
                  </For>
                  <For each={data().grants.filter((grant) => !grant.granted_to_team_id)}>
                    {(grant) => (
                      <div class="flex items-center justify-between gap-2 text-12-regular">
                        <span class="truncate">
                          {grant.granted_to_org_id
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
                </Show>
              </div>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
          </DropdownMenu>
        )}
      </Show>
    </>
  )
}
