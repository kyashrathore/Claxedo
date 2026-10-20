import { createSignal, createUniqueId, For, Show, type JSX } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { canStop, useCloudCommandFailureText, useCloudStatusText, useMachineSizeName, useWorkspaceName } from "@/cloud"
import { useTranslator } from "@/i18n"
import { useServer, type MachineTimeWorkspace, type PlacementId, type ProjectId } from "@/server"
import { Button, ClaxedoIcon, Tag } from "@/ui"
import { usageDictionary } from "../i18n"
import type { SandboxProjectGroup } from "../sandbox-groups"
import type { SandboxRow } from "../sandbox-rows"
import { useUsageFormats } from "./usage-formats"

function useRowWords() {
  const t = useTranslator(usageDictionary)
  const statusText = useCloudStatusText()
  const failureText = useCloudCommandFailureText()
  const sizeName = useMachineSizeName()
  const server = useServer()
  const projects = useQuery(() => server.queries.projects.list())
  const project = (id: ProjectId | undefined) => (id === undefined ? undefined : projects.data?.find((entry) => entry.id === id)?.name) ?? t("usage.sandbox.noProject")
  const machine = (time: MachineTimeWorkspace) => {
    const shape = time.rate ? t("usage.sandbox.machine", { vcpu: time.rate.vcpu, memoryGb: time.rate.memoryGb }) : undefined
    return [time.providerLabel, sizeName(time.machineClass), shape].filter(Boolean).join(" · ")
  }
  const detail = (row: SandboxRow) => row.machines.map(machine).join(" · ")
  const status = (row: SandboxRow) => {
    if (row.live) return statusText(row.live.state)
    return row.runningSince !== undefined ? statusText({ kind: "ready" }) : undefined
  }
  const failure = (row: SandboxRow) => failureText(row.live?.commandFailure)
  const count = (group: SandboxProjectGroup) => t(group.rows.length === 1 ? "usage.sandbox.workspaces.one" : "usage.sandbox.workspaces.other", { count: group.rows.length })
  return { project, detail, status, failure, count }
}

function Figures(props: { readonly timed: boolean; readonly activeMs: number; readonly cost: SandboxRow["cost"] }): JSX.Element {
  const format = useUsageFormats()
  return (
    <>
      <td>{props.timed ? format.duration(props.activeMs) : "–"}</td>
      <td>{props.timed ? format.spend(props.cost) : "–"}</td>
    </>
  )
}

function WorkspaceRow(props: { readonly row: SandboxRow; readonly id: string | undefined; readonly onStop: (id: PlacementId) => void }): JSX.Element {
  const t = useTranslator(usageDictionary)
  const workspaceName = useWorkspaceName()
  const words = useRowWords()
  return (
    <tr class="usage-table-member" id={props.id}>
      <th scope="row" class="usage-table-lead">
        <span class="usage-sandbox-name">
          <span class="usage-table-name" title={props.row.id}>{workspaceName(props.row.name, props.row.branch)}</span>
          <Show when={words.status(props.row)}>{(status) => <Tag>{status()}</Tag>}</Show>
        </span>
        <Show when={words.detail(props.row)}>{(detail) => <span class="usage-table-detail">{detail()}</span>}</Show>
        <Show when={words.failure(props.row)}>{(failure) => <span class="usage-table-detail">{failure()}</span>}</Show>
      </th>
      <Figures timed={props.row.machines.length > 0} activeMs={props.row.activeMs} cost={props.row.cost} />
      <td class="usage-sandbox-action">
        <Show when={props.row.live && canStop(props.row.live.state)}>
          <Button size="small" variant="neutral" onClick={() => props.onStop(props.row.id)}>{t("usage.sandbox.stop")}</Button>
        </Show>
      </td>
    </tr>
  )
}

function ProjectGroupRows(props: { readonly group: SandboxProjectGroup; readonly onStop: (id: PlacementId) => void }): JSX.Element {
  const words = useRowWords()
  const rowsId = createUniqueId()
  const [expanded, setExpanded] = createSignal(props.group.running)
  return (
    <>
      <tr>
        <th scope="row" class="usage-table-lead">
          <button type="button" class="usage-table-toggle" aria-expanded={expanded()} aria-controls={rowsId} onClick={() => setExpanded(!expanded())}>
            <ClaxedoIcon name="chevron-right" size="small" class="usage-table-chevron" />
            <span class="usage-table-name">{words.project(props.group.projectId)}</span>
          </button>
          <span class="usage-table-detail usage-table-indent">{words.count(props.group)}</span>
        </th>
        <Figures timed={props.group.rows.some((row) => row.machines.length > 0)} activeMs={props.group.activeMs} cost={props.group.cost} />
        <td />
      </tr>
      <Show when={expanded()}>
        <For each={props.group.rows}>{(row, index) => <WorkspaceRow row={row} id={index() === 0 ? rowsId : undefined} onStop={props.onStop} />}</For>
      </Show>
    </>
  )
}

export function SandboxTable(props: { readonly groups: readonly SandboxProjectGroup[]; readonly onStop: (id: PlacementId) => void }): JSX.Element {
  const t = useTranslator(usageDictionary)
  return (
    <table class="usage-table usage-sandbox-table" aria-label={t("usage.sandbox.projects")}>
      <thead>
        <tr>
          <th scope="col" class="usage-table-lead">{t("usage.sandbox.project")}</th>
          <th scope="col">{t("usage.sandbox.time")}</th>
          <th scope="col">{t("usage.sandbox.cost")}</th>
          <th scope="col"><span class="usage-visually-hidden">{t("usage.sandbox.actions")}</span></th>
        </tr>
      </thead>
      <tbody>
        <For each={props.groups}>{(group) => <ProjectGroupRows group={group} onStop={props.onStop} />}</For>
      </tbody>
    </table>
  )
}
