import { For, Show, createResource, createSignal, type Component } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { showToast } from "@opencode-ai/ui/toast"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import {
  grantSessionShare,
  listSessionShares,
  revokeSessionShare,
  type SessionShareLevel,
} from "@/features/session/data/session-share-api"

/**
 * Shown before every `send` grant, and acknowledged before it is sent.
 *
 * The consequence it states is not a policy the product could choose
 * otherwise: the agent has the machine's filesystem, so whoever can prompt it
 * can read whatever that machine holds.
 */
const SEND_DISCLOSURE =
  "The agent runs on the workspace's machine with that machine's files. A teammate who can send "
  + "messages can ask it to read anything there, including the transcripts of your other sessions "
  + "in this workspace. Sharing works best for sessions on a cloud environment, where each session "
  + "has a machine of its own. If this machine holds anything you would not want a teammate to "
  + "reach, do not share sessions from workspaces on it."

/**
 * What the grantee may do, and the whole of it: a share level is the only
 * cross-person grant in the product, so nothing a person is a member of adds
 * to or subtracts from what these two words promise.
 */
const LEVEL_LABEL: Record<SessionShareLevel, string> = {
  follow: "Can follow",
  send: "Can send messages",
}

/** A `send` grant the granter has asked for and not yet acknowledged. */
type PendingSend = {
  description: string
  send: () => Promise<void>
}

export const SessionPeopleControl: Component<{
  sessionId: string
  workspaceId: string
}> = (props) => {
  const [open, setOpen] = createSignal(false)
  const [personToken, setPersonToken] = createSignal("")
  const [newLevel, setNewLevel] = createSignal<SessionShareLevel>("follow")
  const [pending, setPending] = createSignal<PendingSend | undefined>()
  const [acknowledged, setAcknowledged] = createSignal(false)
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

  const closeDisclosure = () => {
    setPending(undefined)
    setAcknowledged(false)
  }

  const report = (title: string, error: unknown) => {
    showToast({ title, description: error instanceof Error ? error.message : String(error) })
  }

  /**
   * Every grant goes through here, so raising an existing share to `send` is
   * gated exactly as a new one is. The control plane keeps one active grant
   * per recipient, so a repeat grant at another level moves that grant rather
   * than adding a second.
   */
  const share = async (input: {
    level: SessionShareLevel
    description: string
    target:
      | { grantedToTokenIdentifier: string }
      | { grantedToUserId: string }
      | { grantedToOrgId: string }
      | { grantedToTeamPublicId: string }
    onGranted?: () => void
  }) => {
    const send = async () => {
      try {
        await grantSessionShare({
          sessionId: props.sessionId,
          workspaceId: props.workspaceId,
          level: input.level,
          ...input.target,
        })
        input.onGranted?.()
        closeDisclosure()
        await refetch()
        showToast({ title: `${input.description} — ${LEVEL_LABEL[input.level].toLowerCase()}` })
      } catch (error) {
        report("Could not share this session", error)
      }
    }
    if (input.level !== "send") {
      await send()
      return
    }
    setAcknowledged(false)
    setPending({ description: input.description, send })
  }

  const remove = async (
    target: { grantId: string } | { grantedToTeamPublicId: string },
  ) => {
    try {
      await revokeSessionShare({ sessionId: props.sessionId, workspaceId: props.workspaceId, ...target })
      closeDisclosure()
      await refetch()
    } catch (error) {
      report("Could not revoke share", error)
    }
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
              closeDisclosure()
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
                A session share is the only thing that lets a teammate reach this session.
              </p>
              <Show when={pending()}>
                {(request) => (
                  <div
                    role="alertdialog"
                    aria-label="Sending messages shares this machine"
                    class="flex flex-col gap-2 rounded-md border border-border-weak-base p-2"
                  >
                    <div class="text-12-medium text-text-strong">Before you allow sending</div>
                    <p class="text-12-regular text-text-weak">{SEND_DISCLOSURE}</p>
                    <label class="flex items-start gap-2 text-12-regular text-text-strong">
                      <input
                        type="checkbox"
                        checked={acknowledged()}
                        onChange={(event) => setAcknowledged(event.currentTarget.checked)}
                      />
                      I understand what a teammate who can send messages can reach.
                    </label>
                    <div class="flex items-center gap-2">
                      <Button
                        size="small"
                        disabled={!acknowledged()}
                        aria-label={`Allow sending: ${request().description}`}
                        onClick={() => void request().send()}
                      >
                        Allow sending
                      </Button>
                      <Button size="small" variant="ghost" onClick={closeDisclosure}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </Show>
              <div class="flex flex-col gap-2">
                <input
                  class="w-full rounded-md border border-border-weak-base bg-transparent px-2 py-1.5 text-12-regular"
                  placeholder="Person token identifier"
                  value={personToken()}
                  onInput={(event) => setPersonToken(event.currentTarget.value)}
                />
                <label class="flex items-center gap-2 text-12-regular text-text-weak">
                  Share level
                  <select
                    class="rounded-md border border-border-weak-base bg-transparent px-1 py-1 text-12-regular"
                    aria-label="Share level"
                    value={newLevel()}
                    onChange={(event) => setNewLevel(event.currentTarget.value === "send" ? "send" : "follow")}
                  >
                    <option value="follow">{LEVEL_LABEL.follow}</option>
                    <option value="send">{LEVEL_LABEL.send}</option>
                  </select>
                </label>
                <Button
                  size="small"
                  onClick={() => {
                    const token = personToken().trim()
                    if (!token) return
                    void share({
                      level: newLevel(),
                      description: "Person added to session",
                      target: { grantedToTokenIdentifier: token },
                      onGranted: () => setPersonToken(""),
                    })
                  }}
                >
                  Add person
                </Button>
              </div>
              <div class="flex flex-col gap-2">
                <div class="text-12-medium text-text-strong">Teams</div>
                <Show
                  when={data().teams.length > 0}
                  fallback={<p class="text-12-regular text-text-weak">No teams are available to share with.</p>}
                >
                  <div class="flex flex-col gap-1">
                    <For each={data().teams}>
                      {(team) => {
                        const level = () =>
                          data().grants.find((grant) => grant.granted_to_team_id === team.team_id)?.level
                        return (
                          <div class="flex items-center justify-between gap-2 rounded-md border border-border-weak-base px-2 py-1.5">
                            <span class="min-w-0 truncate text-12-regular text-text-strong">{team.name}</span>
                            <Show
                              when={!team.is_shared}
                              fallback={(
                                <div class="flex items-center gap-1">
                                  <span class="text-12-regular text-text-weak">
                                    {LEVEL_LABEL[level() ?? "follow"]}
                                  </span>
                                  <Button
                                    size="small"
                                    variant="ghost"
                                    aria-label={level() === "send"
                                      ? `Limit ${team.name} to following`
                                      : `Let ${team.name} send messages`}
                                    onClick={() => void share({
                                      level: level() === "send" ? "follow" : "send",
                                      description: `${team.name} on this session`,
                                      target: { grantedToTeamPublicId: team.team_id },
                                    })}
                                  >
                                    {level() === "send" ? "Limit to following" : "Let them send"}
                                  </Button>
                                  <Button
                                    size="small"
                                    variant="ghost"
                                    aria-label={`Remove ${team.name} from session`}
                                    onClick={() => void remove({ grantedToTeamPublicId: team.team_id })}
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
                                onClick={() => void share({
                                  level: newLevel(),
                                  description: `${team.name} on this session`,
                                  target: { grantedToTeamPublicId: team.team_id },
                                })}
                              >
                                Share
                              </Button>
                            </Show>
                          </div>
                        )
                      }}
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
                    {(grant) => {
                      const name = () => grant.granted_to_org_id
                        ? `Org ${grant.granted_to_org_id}`
                        : `User ${grant.granted_to_user_id}`
                      const target = () => grant.granted_to_org_id
                        ? { grantedToOrgId: grant.granted_to_org_id }
                        : { grantedToUserId: grant.granted_to_user_id ?? "" }
                      return (
                        <div class="flex items-center justify-between gap-2 text-12-regular">
                          <span class="truncate">{name()}</span>
                          <span class="shrink-0 text-text-weak">{LEVEL_LABEL[grant.level]}</span>
                          <Button
                            size="small"
                            variant="ghost"
                            aria-label={grant.level === "send"
                              ? `Limit ${name()} to following`
                              : `Let ${name()} send messages`}
                            onClick={() => void share({
                              level: grant.level === "send" ? "follow" : "send",
                              description: `${name()} on this session`,
                              target: target(),
                            })}
                          >
                            {grant.level === "send" ? "Limit to following" : "Let them send"}
                          </Button>
                          <Button
                            size="small"
                            variant="ghost"
                            aria-label={`Remove ${name()} from session`}
                            onClick={() => void remove({ grantId: grant.grant_id })}
                          >
                            Remove
                          </Button>
                        </div>
                      )
                    }}
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
