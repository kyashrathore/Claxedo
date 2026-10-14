import { For, Show, type JSX } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { canStop, useCloudCommandFailureText, useCloudStatusText, useMachineSizeName, useWorkspaceName } from "@/cloud"
import { useTranslator } from "@/i18n"
import { useServer, type MachineTimeWorkspace, type PlacementId, type ProjectId } from "@/server"
import { Button, Tag } from "@/ui"
import { usageDictionary } from "../i18n"
import type { SandboxRow } from "../sandbox-rows"
import { useUsageFormats } from "./usage-formats"

function useRowWords() {
  const t = useTranslator(usageDictionary)
  const format = useUsageFormats()
  const statusText = useCloudStatusText()
  const failureText = useCloudCommandFailureText()
  const sizeName = useMachineSizeName()
  const server = useServer()
  const projects = useQuery(() => server.queries.projects.list())
  const projectName = (id: ProjectId | undefined) => (id === undefined ? undefined : projects.data?.find((project) => project.id === id)?.name)
  const machine = (time: MachineTimeWorkspace) => {
    const shape = time.rate ? t("usage.sandbox.machine", { vcpu: time.rate.vcpu, memoryGb: time.rate.memoryGb }) : undefined
    return [time.providerLabel, sizeName(time.machineClass), shape].filter(Boolean).join(" · ")
  }
  const detail = (row: SandboxRow) => [projectName(row.projectId), ...row.machines.map(machine)].filter(Boolean).join(" · ")
  const status = (row: SandboxRow) => {
    if (row.live) return statusText(row.live.state)
    if (row.runningSince !== undefined) return statusText({ kind: "ready" })
    if (row.lastStoppedAt !== undefined) return t("usage.sandbox.asleepSince", { date: format.date(row.lastStoppedAt) })
    return statusText({ kind: "stopped" })
  }
  const failure = (row: SandboxRow) => failureText(row.live?.commandFailure)
  return { detail, status, failure }
}

export function SandboxTable(props: { readonly rows: readonly SandboxRow[]; readonly onStop: (id: PlacementId) => void }): JSX.Element {
  const t = useTranslator(usageDictionary)
  const format = useUsageFormats()
  const workspaceName = useWorkspaceName()
  const words = useRowWords()
  return (
    <table class="usage-table usage-sandbox-table" aria-label={t("usage.sandbox.workspaces")}>
      <thead>
        <tr>
          <th scope="col" class="usage-table-lead">{t("usage.sandbox.workspace")}</th>
          <th scope="col">{t("usage.sandbox.time")}</th>
          <th scope="col">{t("usage.sandbox.cost")}</th>
          <th scope="col"><span class="usage-visually-hidden">{t("usage.sandbox.actions")}</span></th>
        </tr>
      </thead>
      <tbody>
        <For each={props.rows}>
          {(row) => (
            <tr>
              <th scope="row" class="usage-table-lead">
                <span class="usage-sandbox-name">
                  <span class="usage-table-name" title={row.id}>{workspaceName(row.name, row.branch)}</span>
                  <Tag>{words.status(row)}</Tag>
                </span>
                <span class="usage-sandbox-detail">{words.detail(row)}</span>
                <Show when={words.failure(row)}>{(failure) => <span class="usage-sandbox-detail">{failure()}</span>}</Show>
              </th>
              <td>{row.machines.length > 0 ? format.duration(row.activeMs) : "–"}</td>
              <td>{row.machines.length > 0 ? format.spend(row.cost) : "–"}</td>
              <td class="usage-sandbox-action">
                <Show when={row.live && canStop(row.live.state)}>
                  <Button size="small" variant="neutral" onClick={() => props.onStop(row.id)}>{t("usage.sandbox.stop")}</Button>
                </Show>
              </td>
            </tr>
          )}
        </For>
      </tbody>
    </table>
  )
}
