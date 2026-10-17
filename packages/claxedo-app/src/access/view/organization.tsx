import { For, Match, Show, Switch } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { useErrorCopy, useTranslator } from "@/i18n"
import { useElapsed } from "@/lib/delay"
import { FailureNotice } from "@/lib/failure"
import { useServer, type OrgMembership, type OrgRole } from "@/server"
import { Tag } from "@/ui"
import { accessDictionary } from "../i18n"
import { isOrgManager } from "../model"
import { useAccess } from "../store"
import { SignedOutNotice } from "./signed-out"
import "./access.css"

const ROLE_KEY = {
  owner: "access.org.role.owner",
  admin: "access.org.role.admin",
  member: "access.org.role.member",
} as const satisfies Record<OrgRole, string>

function OrganizationMembers(props: { readonly membership: OrgMembership }) {
  const t = useTranslator(accessDictionary)
  const server = useServer()
  const errorCopy = useErrorCopy("organization")
  const elapsed = useElapsed()
  const members = useQuery(() => server.queries.organizations.members(props.membership.orgId))
  return (
    <section class="org-group" aria-labelledby={`org-${props.membership.orgId}`}>
      <div class="org-group-header">
        <h2 id={`org-${props.membership.orgId}`} class="org-heading">{props.membership.name}</h2>
      </div>
      <Switch>
        <Match when={members.error}>
          {(error) => <FailureNotice title={t("access.org.membersFailed")} message={errorCopy(error()).message} retryLabel={errorCopy(error()).retry} onRetry={() => void members.refetch()} />}
        </Match>
        <Match when={members.data}>
          {(rows) => (
            <ul class="org-card" aria-label={t("access.org.members")}>
              <For each={rows()}>
                {(member) => (
                  <li class="org-row" data-member-you={member.you ? "true" : undefined}>
                    <span class="org-name">{member.name ?? t("access.org.unnamed")}</span>
                    <Show when={member.you}>
                      <span class="org-you">{t("access.org.you")}</span>
                    </Show>
                    <Tag>{t(ROLE_KEY[member.role])}</Tag>
                  </li>
                )}
              </For>
            </ul>
          )}
        </Match>
        <Match when={elapsed()}>
          <p class="org-note" role="status">{t("access.org.membersLoading")}</p>
        </Match>
      </Switch>
      <p class="org-note">{t(isOrgManager(props.membership.role) ? "access.org.manager" : "access.org.restricted")}</p>
    </section>
  )
}

function Memberships() {
  const t = useTranslator(accessDictionary)
  const server = useServer()
  const errorCopy = useErrorCopy("organization")
  const elapsed = useElapsed()
  const mine = useQuery(() => server.queries.organizations.mine())
  return (
    <Switch>
      <Match when={mine.error}>
        {(error) => <FailureNotice title={t("access.org.failed")} message={errorCopy(error()).message} retryLabel={errorCopy(error()).retry} onRetry={() => void mine.refetch()} />}
      </Match>
      <Match when={mine.data}>
        {(rows) => (
          <Show when={rows().length > 0} fallback={<p class="org-note">{t("access.org.none")}</p>}>
            <For each={rows()}>{(membership) => <OrganizationMembers membership={membership} />}</For>
          </Show>
        )}
      </Match>
      <Match when={elapsed()}>
        <p class="org-note" role="status">{t("access.org.loading")}</p>
      </Match>
    </Switch>
  )
}

export function OrganizationSection() {
  const t = useTranslator(accessDictionary)
  const access = useAccess()
  return (
    <div class="org-section">
      <p class="org-intro">{t("access.org.description")}</p>
      <Show when={access.signedIn()} fallback={<SignedOutNotice />}>
        <Memberships />
      </Show>
    </div>
  )
}
