import { Show } from "solid-js"
import { Tag } from "@/ui"
import { useTranslator } from "@/i18n"
import type { OrgRole } from "@/server"
import { dictionary } from "../i18n"
import { useAccess } from "../store"
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

  return (
    <div class="org-section" data-component="settings-organization">
      <p class="org-intro">{t("access.org.description")}</p>
      <Show when={user()} fallback={<p class="org-note">{t("access.org.signedOut")}</p>}>
        {(who) => (
          <Show when={who().orgId} fallback={<p class="org-note">{t("access.org.none")}</p>}>
            <div class="org-card">
              <div class="org-row">
                <span class="org-name">{who().name}</span>
                <span class="org-you">{t("access.org.you")}</span>
                <Tag>{t(ROLE_KEY[access.orgRole() ?? "member"])}</Tag>
              </div>
            </div>
            <Show when={access.can("org.manage")} fallback={<p class="org-note">{t("access.org.restricted")}</p>}>
              <h2 class="org-heading">{t("access.org.accounts")}</h2>
              <p class="org-note">{t("access.org.accounts.hint")}</p>
            </Show>
          </Show>
        )}
      </Show>
    </div>
  )
}
