import { For, Show } from "solid-js"
import { Tag } from "@/ui"
import { useTranslator } from "@/i18n"
import type { OrgRole } from "@/server"
import { dictionary } from "../i18n"
import { isOrgManager, type OrgMember } from "../model"
import { useAccess } from "../provider"
import "./access.css"

const ROLE_KEY = {
  owner: "access.org.role.owner",
  admin: "access.org.role.admin",
  member: "access.org.role.member",
} as const satisfies Record<OrgRole, string>

export function OrganizationSection() {
  const t = useTranslator(dictionary)
  const access = useAccess()
  const user = () => {
    const who = access.principal()
    return who?.kind === "user" ? who : undefined
  }
  const role = () => user()?.orgRole
  const org = () => access.org()

  return (
    <section class="org-section" data-component="settings-organization" aria-labelledby="settings-organization-title">
      <h1 id="settings-organization-title" class="org-title">{t("access.org.title")}</h1>
      <p class="org-intro">{t("access.org.description")}</p>
      <Show when={user()} fallback={<p class="org-note">{t("access.org.signedOut")}</p>}>
        {(who) => (
          <Show when={who().orgId} fallback={<p class="org-note">{t("access.org.none")}</p>}>
            <div class="org-card">
              <div class="org-row">
                <span class="org-name">{who().name}</span>
                <span class="org-you">{t("access.org.you")}</span>
                <Tag variant="accent">{t(ROLE_KEY[role() ?? "member"])}</Tag>
              </div>
            </div>
            <Show when={isOrgManager(role())} fallback={<p class="org-note" data-component="org-restricted">{t("access.org.restricted")}</p>}>
              <h2 class="org-heading">{t("access.org.members")}</h2>
              <MemberList members={org().members()?.kind === "listed" ? (org().members() as { members: readonly OrgMember[] }).members : undefined} unavailable={org().members()?.kind === "unavailable" || org().membersError() !== undefined} />
              <h2 class="org-heading">{t("access.org.accounts")}</h2>
              <p class="org-note">{t("access.org.accounts.hint")}</p>
            </Show>
          </Show>
        )}
      </Show>
    </section>
  )
}

function MemberList(props: { readonly members: readonly OrgMember[] | undefined; readonly unavailable: boolean }) {
  const t = useTranslator(dictionary)
  return (
    <Show when={!props.unavailable} fallback={<p class="org-note" data-component="org-members-unavailable">{t("access.org.members.unavailable")}</p>}>
      <ul class="org-card" aria-label={t("access.org.members")}>
        <Show when={props.members?.length === 0}>
          <li class="org-note">{t("access.org.members.empty")}</li>
        </Show>
        <For each={props.members ?? []}>
          {(member) => (
            <li class="org-row" data-member={member.userId}>
              <span class="org-name">{member.label}</span>
              <Show when={member.email}>{(email) => <span class="org-note">{email()}</span>}</Show>
              <Tag>{t(ROLE_KEY[member.role])}</Tag>
            </li>
          )}
        </For>
      </ul>
    </Show>
  )
}
