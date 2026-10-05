import { For, Match, Show, Switch, type JSX } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { useCloudStatusText, useCloudWorkspaceName, useRunningCloudWorkspaces } from "@/cloud"
import { useErrorCopy, useTranslator } from "@/i18n"
import { useElapsed } from "@/lib/delay"
import { FailureNotice } from "@/lib/failure"
import { useServer, type ProjectId } from "@/server"
import { Button } from "@/ui"
import { usageDictionary } from "../i18n"

export function CloudUsage(): JSX.Element {
  const t = useTranslator(usageDictionary)
  const server = useServer()
  const errorCopy = useErrorCopy("usage")
  const elapsed = useElapsed()
  const running = useRunningCloudWorkspaces(() => true)
  const projects = useQuery(() => server.queries.projects.list())
  const cloudName = useCloudWorkspaceName()
  const projectName = (id: ProjectId) => projects.data?.find((project) => project.id === id)?.name
  const statusLabel = useCloudStatusText()
  const failed = () => {
    const state = running.list()
    return state.kind === "failed" ? state.error : undefined
  }
  const rows = () => {
    const state = running.list()
    return state.kind === "ready" ? state.rows : undefined
  }
  return (
    <section class="usage-cloud" aria-labelledby="usage-cloud-title">
      <div>
        <h3 id="usage-cloud-title" class="usage-group-title">{t("usage.cloud.title")}</h3>
        <p class="usage-hint">{t("usage.cloud.description")}</p>
      </div>
      <Switch>
        <Match when={failed()}>
          {(error) => <FailureNotice title={t("usage.cloud.failed")} message={errorCopy(error()).message} retryLabel={errorCopy(error()).retry} onRetry={running.refresh} />}
        </Match>
        <Match when={rows()}>
          {(ready) => (
            <Show when={ready().length > 0} fallback={<p class="usage-empty">{t("usage.cloud.empty")}</p>}>
              <ul class="usage-cloud-list">
                <For each={ready()}>
                  {(row) => (
                    <li class="usage-cloud-row" data-workspace-id={row.id} data-state={row.state.kind}>
                      <div class="usage-cloud-text">
                        <span class="usage-cloud-name" title={row.id}>{cloudName(row)}</span>
                        <span class="usage-hint">{[projectName(row.projectId), row.branch, statusLabel(row.state)].filter(Boolean).join(" · ")}</span>
                      </div>
                      <Show when={row.state.kind !== "stopping"}>
                        <Button size="small" variant="neutral" onClick={() => void running.stop(row.id)}>{t("usage.cloud.stop")}</Button>
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          )}
        </Match>
        <Match when={elapsed()}>
          <p class="usage-status" role="status">{t("usage.cloud.loading")}</p>
        </Match>
      </Switch>
    </section>
  )
}
