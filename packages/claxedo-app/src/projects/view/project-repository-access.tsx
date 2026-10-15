import { For, Match, Switch, type JSX } from "solid-js"
import type { CodeHostRepositoryAccess } from "@/server"
import { useProjectsText } from "../i18n"

const LINK = "underline underline-offset-2 text-text-strong"

export function RepositoryAccessHint(props: { access: CodeHostRepositoryAccess; host: string }): JSX.Element {
  const t = useProjectsText()
  return (
    <p class="text-12-regular text-text-weak">
      <Switch>
        <Match when={props.access.kind === "token" ? props.access : undefined}>
          {(access) => (
            <>
              {t("projects.add.access.token", { host: props.host })}{" "}
              <a href={access().settingsUrl} target="_blank" rel="noreferrer" class={LINK}>{t("projects.add.access.tokenSettings")}</a>
            </>
          )}
        </Match>
        <Match when={props.access.kind === "app" && props.access.installations.length > 0 ? props.access : undefined}>
          {(access) => (
            <>
              {t("projects.add.access.app", { host: props.host })}{" "}
              <For each={access().installations}>
                {(installation, index) => (
                  <>
                    {index() > 0 ? ", " : ""}
                    <a href={installation.settingsUrl} target="_blank" rel="noreferrer" class={LINK}>
                      {t("projects.add.access.configure", { account: installation.account })}
                    </a>
                  </>
                )}
              </For>
            </>
          )}
        </Match>
        <Match when={props.access.kind === "app"}>{t("projects.add.access.notInstalled", { host: props.host })}</Match>
      </Switch>
    </p>
  )
}
