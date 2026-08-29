import { For, Show, createResource, createSignal, type Component } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { showToast } from "@opencode-ai/ui/toast"
import {
  addTeamMember,
  createOrg,
  createTeam,
  ensureDefaultTeam,
  listOrgs,
  listTeamMembers,
  listTeams,
  readActiveOrgId,
  readActiveTeamId,
  removeTeamMember,
  writeActiveOrgId,
  writeActiveTeamId,
  type OrgListItem,
  type TeamListItem,
} from "@/features/settings/data/org-team-api"

export const OrgTeamSettingsSection: Component = () => {
  const [orgName, setOrgName] = createSignal("")
  const [teamName, setTeamName] = createSignal("")
  const [memberToken, setMemberToken] = createSignal("")
  const [selectedOrgId, setSelectedOrgId] = createSignal(readActiveOrgId())
  const [selectedTeamId, setSelectedTeamId] = createSignal(readActiveTeamId())
  const [orgs, { refetch: refetchOrgs }] = createResource(listOrgs)
  const [teams, { refetch: refetchTeams }] = createResource(
    () => selectedOrgId(),
    async (orgId) => {
      if (!orgId) return [] as TeamListItem[]
      await ensureDefaultTeam(orgId).catch(() => undefined)
      return listTeams(orgId)
    },
  )
  const [members, { refetch: refetchMembers }] = createResource(
    () => selectedTeamId(),
    async (teamId) => teamId ? listTeamMembers(teamId) : [],
  )

  const selectOrg = (org: OrgListItem) => {
    setSelectedOrgId(org.org_id)
    writeActiveOrgId(org.org_id)
    setSelectedTeamId(undefined)
    writeActiveTeamId(undefined)
    void refetchTeams()
  }

  const selectTeam = (team: TeamListItem) => {
    setSelectedTeamId(team.team_id)
    writeActiveTeamId(team.team_id)
    void refetchMembers()
  }

  return (
    <div class="flex flex-col gap-6">
      <section class="flex flex-col gap-3">
        <h3 class="text-14-medium text-text-strong">Organizations</h3>
        <p class="text-12-regular text-text-weak">
          An org is your company tenant. Teams inside an org control project access.
        </p>
        <div class="flex gap-2">
          <input
            class="flex-1 rounded-md border border-border-weak-base bg-transparent px-3 py-2 text-14-regular"
            placeholder="New org name"
            value={orgName()}
            onInput={(event) => setOrgName(event.currentTarget.value)}
          />
          <Button
            size="small"
            onClick={async () => {
              try {
                const created = await createOrg(orgName().trim())
                setOrgName("")
                writeActiveOrgId(created.org_id)
                setSelectedOrgId(created.org_id)
                if (created.default_team_id) {
                  writeActiveTeamId(created.default_team_id)
                  setSelectedTeamId(created.default_team_id)
                }
                await refetchOrgs()
                await refetchTeams()
                showToast({ title: "Organization created", description: created.name })
              } catch (error) {
                showToast({
                  title: "Could not create org",
                  description: error instanceof Error ? error.message : String(error),
                })
              }
            }}
          >
            Create org
          </Button>
        </div>
        <div class="flex flex-col gap-1">
          <For each={orgs() ?? []}>
            {(org) => (
              <button
                type="button"
                class="flex items-center justify-between rounded-md px-3 py-2 text-left text-14-regular hover:bg-surface-base-hover"
                classList={{ "bg-surface-base-hover": selectedOrgId() === org.org_id }}
                onClick={() => selectOrg(org)}
              >
                <span>{org.name}</span>
                <span class="text-12-regular text-text-weak">{org.role}</span>
              </button>
            )}
          </For>
        </div>
      </section>

      <Show when={selectedOrgId()}>
        <section class="flex flex-col gap-3">
          <h3 class="text-14-medium text-text-strong">Teams</h3>
          <div class="flex gap-2">
            <input
              class="flex-1 rounded-md border border-border-weak-base bg-transparent px-3 py-2 text-14-regular"
              placeholder="New team name"
              value={teamName()}
              onInput={(event) => setTeamName(event.currentTarget.value)}
            />
            <Button
              size="small"
              onClick={async () => {
                const orgId = selectedOrgId()
                if (!orgId) return
                try {
                  const created = await createTeam(orgId, teamName().trim())
                  setTeamName("")
                  writeActiveTeamId(created.team_id)
                  setSelectedTeamId(created.team_id)
                  await refetchTeams()
                  showToast({ title: "Team created", description: created.name })
                } catch (error) {
                  showToast({
                    title: "Could not create team",
                    description: error instanceof Error ? error.message : String(error),
                  })
                }
              }}
            >
              Create team
            </Button>
          </div>
          <div class="flex flex-col gap-1">
            <For each={teams() ?? []}>
              {(team) => (
                <button
                  type="button"
                  class="flex items-center justify-between rounded-md px-3 py-2 text-left text-14-regular hover:bg-surface-base-hover"
                  classList={{ "bg-surface-base-hover": selectedTeamId() === team.team_id }}
                  onClick={() => selectTeam(team)}
                >
                  <span>{team.name}</span>
                  <Show when={team.is_default}>
                    <span class="text-12-regular text-text-weak">default</span>
                  </Show>
                </button>
              )}
            </For>
          </div>
        </section>
      </Show>

      <Show when={selectedTeamId()}>
        <section class="flex flex-col gap-3">
          <h3 class="text-14-medium text-text-strong">Team members</h3>
          <div class="flex gap-2">
            <input
              class="flex-1 rounded-md border border-border-weak-base bg-transparent px-3 py-2 text-14-regular"
              placeholder="Member token identifier"
              value={memberToken()}
              onInput={(event) => setMemberToken(event.currentTarget.value)}
            />
            <Button
              size="small"
              onClick={async () => {
                const teamId = selectedTeamId()
                if (!teamId) return
                try {
                  await addTeamMember({ teamId, tokenIdentifier: memberToken().trim() })
                  setMemberToken("")
                  await refetchMembers()
                  showToast({ title: "Member added" })
                } catch (error) {
                  showToast({
                    title: "Could not add member",
                    description: error instanceof Error ? error.message : String(error),
                  })
                }
              }}
            >
              Add
            </Button>
          </div>
          <div class="flex flex-col gap-1">
            <For each={members() ?? []}>
              {(member) => (
                <div class="flex items-center justify-between rounded-md px-3 py-2 text-14-regular">
                  <div class="flex flex-col">
                    <span>{member.display_name || member.email || member.public_id || member.user_id}</span>
                    <span class="text-12-regular text-text-weak">{member.role}</span>
                  </div>
                  <Button
                    size="small"
                    variant="ghost"
                    onClick={async () => {
                      const teamId = selectedTeamId()
                      if (!teamId) return
                      try {
                        await removeTeamMember({
                          teamId,
                          tokenIdentifier: member.token_identifier,
                          userPublicId: member.public_id,
                        })
                        await refetchMembers()
                      } catch (error) {
                        showToast({
                          title: "Could not remove member",
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
        </section>
      </Show>
    </div>
  )
}
