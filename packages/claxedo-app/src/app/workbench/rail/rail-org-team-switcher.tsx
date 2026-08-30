import { For, Show, createResource, createSignal, type Component } from "solid-js"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import {
  ensureDefaultTeam,
  listOrgs,
  listTeams,
  readActiveOrgId,
  readActiveTeamId,
  writeActiveOrgId,
  writeActiveTeamId,
  type OrgListItem,
  type TeamListItem,
} from "@/features/settings/data/org-team-api"
import { RailAccountSubmenu } from "./rail-account-menu"

/**
 * Active org/team picker in the rail account menu.
 * Selection is application-owned (localStorage); it does not depend on Clerk Organizations.
 */
export const RailOrgTeamSwitcher: Component = () => {
  const [activeOrgId, setActiveOrgId] = createSignal(readActiveOrgId())
  const [activeTeamId, setActiveTeamId] = createSignal(readActiveTeamId())
  const [orgs] = createResource(async () => {
    try {
      return await listOrgs()
    } catch {
      return [] as OrgListItem[]
    }
  })
  const [teams, { refetch: refetchTeams }] = createResource(
    () => activeOrgId(),
    async (orgId) => {
      if (!orgId) return [] as TeamListItem[]
      try {
        await ensureDefaultTeam(orgId).catch(() => undefined)
        return await listTeams(orgId)
      } catch {
        return [] as TeamListItem[]
      }
    },
  )

  const activeOrgLabel = () => {
    const id = activeOrgId()
    const match = (orgs() ?? []).find((org) => org.org_id === id)
    return match?.name ?? (id ? "Organization" : "Select organization")
  }

  const activeTeamLabel = () => {
    const id = activeTeamId()
    const match = (teams() ?? []).find((team) => team.team_id === id)
    return match?.name ?? (id ? "Team" : "Select team")
  }

  const selectOrg = (org: OrgListItem) => {
    setActiveOrgId(org.org_id)
    writeActiveOrgId(org.org_id)
    setActiveTeamId(undefined)
    writeActiveTeamId(undefined)
    void refetchTeams()
  }

  const selectTeam = (team: TeamListItem) => {
    setActiveTeamId(team.team_id)
    writeActiveTeamId(team.team_id)
  }

  return (
    <>
      <RailAccountSubmenu icon="folders" label={activeOrgLabel()} contentStyle={{ "z-index": 220, "min-width": "220px" }}>
        <DropdownMenu.Group>
          <DropdownMenu.GroupLabel>Organization</DropdownMenu.GroupLabel>
          <For each={orgs() ?? []}>
            {(org) => (
              <DropdownMenu.Item
                closeOnSelect={false}
                onSelect={() => selectOrg(org)}
              >
                <span class="flex-1 truncate">{org.name}</span>
                <Show when={activeOrgId() === org.org_id}>
                  <span class="text-text-weak/50">&#10003;</span>
                </Show>
              </DropdownMenu.Item>
            )}
          </For>
          <Show when={(orgs() ?? []).length === 0}>
            <DropdownMenu.Item disabled>
              <span class="text-text-weak">No organizations yet</span>
            </DropdownMenu.Item>
          </Show>
        </DropdownMenu.Group>
      </RailAccountSubmenu>

      <Show when={!!activeOrgId()}>
        <RailAccountSubmenu icon="share" label={activeTeamLabel()} contentStyle={{ "z-index": 220, "min-width": "220px" }}>
          <DropdownMenu.Group>
            <DropdownMenu.GroupLabel>Team</DropdownMenu.GroupLabel>
            <For each={teams() ?? []}>
              {(team) => (
                <DropdownMenu.Item
                  closeOnSelect={false}
                  onSelect={() => selectTeam(team)}
                >
                  <span class="flex-1 truncate">
                    {team.name}
                    <Show when={team.is_default}>
                      <span class="text-text-weak"> (default)</span>
                    </Show>
                  </span>
                  <Show when={activeTeamId() === team.team_id}>
                    <span class="text-text-weak/50">&#10003;</span>
                  </Show>
                </DropdownMenu.Item>
              )}
            </For>
            <Show when={(teams() ?? []).length === 0}>
              <DropdownMenu.Item disabled>
                <span class="text-text-weak">No teams yet</span>
              </DropdownMenu.Item>
            </Show>
          </DropdownMenu.Group>
        </RailAccountSubmenu>
      </Show>
    </>
  )
}
