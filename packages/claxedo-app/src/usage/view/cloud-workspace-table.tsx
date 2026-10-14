import { For, Show, type JSX } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { useCloudCommandFailureText, useCloudStatusText, useMachineSizeName, useWorkspaceName } from "@/cloud"
import { useI18n, useTranslator } from "@/i18n"
import { formatDateTimeMed } from "@/lib/relative-time"
import { useServer, type MachineRate, type PlacementId, type ProjectId } from "@/server"
import { Button } from "@/ui"
import type { CloudRow } from "../cloud-rows"
import { usageDictionary } from "../i18n"
import { wholeMinutes } from "../model"
import { useUsageFormats } from "./usage-formats"

function useRowWords() {
  const t = useTranslator(usageDictionary)
  const i18n = useI18n()
  const statusText = useCloudStatusText()
  const failureText = useCloudCommandFailureText()
  const sizeName = useMachineSizeName()
  const machine = (row: CloudRow): string | undefined => {
    const time = row.time
    if (!time) return undefined
    const size = sizeName(time.machineClass)
    const shape = (rate: MachineRate) => t("usage.cloud.machine", { vcpu: rate.vcpu, memoryGb: rate.memoryGb })
    return [time.providerLabel, size, time.rate ? shape(time.rate) : undefined].filter(Boolean).join(" · ")
  }
  const status = (row: CloudRow): string | undefined => {
    const failure = row.live ? failureText(row.live.commandFailure) : undefined
    if (failure) return failure
    const since = row.time?.runningSince
    if (row.running && since !== undefined && (!row.live || row.live.state.kind === "ready")) return t("usage.cloud.runningSince", { time: formatDateTimeMed(since, i18n.intlTag()) })
    return row.live ? statusText(row.live.state) : undefined
  }
  return { machine, status }
}

export function CloudWorkspaceTable(props: { readonly rows: readonly CloudRow[]; readonly onStop: (id: PlacementId) => void }): JSX.Element {
  const t = useTranslator(usageDictionary)
  const format = useUsageFormats()
  const server = useServer()
  const projects = useQuery(() => server.queries.projects.list())
  const projectName = (id: ProjectId | undefined) => (id === undefined ? undefined : projects.data?.find((project) => project.id === id)?.name)
  const workspaceName = useWorkspaceName()
  const words = useRowWords()
  const detail = (row: CloudRow) => [projectName(row.projectId), row.branch, words.machine(row)].filter(Boolean).join(" · ")
  return (
    <table class="usage-table usage-cloud-table" aria-label={t("usage.cloud.title")}>
      <thead>
        <tr>
          <th scope="col" class="usage-table-lead">{t("usage.cloud.workspace")}</th>
          <th scope="col">{t("usage.cloud.minutes")}</th>
          <th scope="col">{t("usage.cloud.rateHeading")}</th>
          <th scope="col">{t("usage.cloud.cost")}</th>
          <th scope="col"><span class="usage-visually-hidden">{t("usage.cloud.actions")}</span></th>
        </tr>
      </thead>
      <tbody>
        <For each={props.rows}>
          {(row) => (
            <tr class="usage-cloud-row" data-workspace-id={row.id} data-running={row.running}>
              <th scope="row" class="usage-table-lead">
                <span class="usage-table-name" title={row.id}>{workspaceName(row.name, row.branch)}</span>
                <span class="usage-cloud-detail">{detail(row)}</span>
                <Show when={words.status(row)}>{(status) => <span class="usage-cloud-status">{status()}</span>}</Show>
              </th>
              <td>{row.time ? format.whole(wholeMinutes(row.time.activeMs)) : "–"}</td>
              <td>{row.time?.rate ? format.hourlyRate(row.time.rate.usdPerHour) : row.time ? t("usage.unknown") : "–"}</td>
              <td>{row.time?.costUsd !== undefined ? format.money(row.time.costUsd) : "–"}</td>
              <td class="usage-cloud-action">
                <Show when={row.running && row.live?.state.kind !== "stopping"}>
                  <Button size="small" variant="neutral" onClick={() => props.onStop(row.id)}>{t("usage.cloud.stop")}</Button>
                </Show>
              </td>
            </tr>
          )}
        </For>
      </tbody>
    </table>
  )
}
