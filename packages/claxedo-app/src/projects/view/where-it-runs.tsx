import { For, Show, type JSX } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { canStart, canStop, cloudFailureReason, useCloudStatusText, useCloudWorkspaces, type CloudWorkspaceRow, type CloudWorkspaces } from "@/cloud"
import { useServer, type Placement, type Project } from "@/server"
import { SettingsEmpty, SettingsGroup, SettingsList, SettingsNote, SettingsRow, useConnectMachine } from "@/settings"
import { Button, requestConfirm, useDialog } from "@/ui"
import { useProjectsText } from "../i18n"
import { usePlacementOpener } from "../open"
import { useProjectPlacements } from "../store"
import { DialogNewCloudWorkspace } from "./new-cloud-workspace-dialog"

function MachineRow(props: { readonly placement: Placement; readonly machineName?: string }): JSX.Element {
  const t = useProjectsText()
  const open = usePlacementOpener()
  const detail = () => [props.placement.path, props.placement.branch, t(props.placement.reachable ? "projects.where.online" : "projects.where.offline")].filter(Boolean).join(" · ")
  return (
    <SettingsRow title={props.machineName ?? props.placement.label} description={detail()}>
      <Button variant="neutral" size="small" onClick={() => open(props.placement.id)}>
        {t("projects.placement.open")}
      </Button>
    </SettingsRow>
  )
}

function CloudRow(props: { readonly row: CloudWorkspaceRow; readonly cloud: CloudWorkspaces }): JSX.Element {
  const t = useProjectsText()
  const dialog = useDialog()
  const open = usePlacementOpener()
  const status = useCloudStatusText()
  const detail = () => [props.row.branch, status(props.row.state), cloudFailureReason(props.row.state)].filter(Boolean).join(" · ")
  const remove = async () => {
    const confirmed = await requestConfirm(dialog, {
      title: t("projects.where.delete.title", { name: props.row.name }),
      body: t("projects.where.delete.body"),
      confirmLabel: t("projects.where.delete.confirm"),
      cancelLabel: t("projects.where.cancel"),
    })
    if (confirmed) await props.cloud.remove(props.row.id)
  }
  return (
    <SettingsRow title={<span title={props.row.id}>{props.row.name}</span>} description={detail()}>
      <Show when={props.row.state.kind === "ready"}>
        <Button variant="neutral" size="small" onClick={() => open(props.row.id)}>{t("projects.placement.open")}</Button>
      </Show>
      <Show when={canStart(props.row.state)}>
        <Button variant="neutral" size="small" onClick={() => void props.cloud.start(props.row.id)}>{t("projects.where.start")}</Button>
      </Show>
      <Show when={canStop(props.row.state)}>
        <Button variant="neutral" size="small" onClick={() => void props.cloud.stop(props.row.id)}>{t("projects.where.stop")}</Button>
      </Show>
      <Button variant="ghost" size="small" onClick={() => void remove()}>{t("projects.where.delete")}</Button>
    </SettingsRow>
  )
}

export function WhereItRuns(props: { readonly project: Project }): JSX.Element {
  const t = useProjectsText()
  const server = useServer()
  const dialog = useDialog()
  const connectMachine = useConnectMachine()
  const cloudOffered = () => server.capabilities()?.features.cloud === true && props.project.source?.kind !== "folder"
  const placements = useProjectPlacements(() => props.project.id)
  const machines = useQuery(() => server.queries.machines.list())
  const cloud = useCloudWorkspaces(() => props.project.id, cloudOffered)
  const local = () => {
    const state = placements()
    return state.kind === "ready" ? state.data.filter((placement) => placement.kind !== "cloud") : []
  }
  const cloudRows = () => {
    const state = cloud.list()
    return state.kind === "ready" ? state.rows : []
  }
  const machineName = (placement: Placement) => machines.data?.find((machine) => machine.id === placement.machineId)?.name
  const loading = () => placements().kind === "loading" || (cloudOffered() && cloud.list().kind === "loading")
  const empty = () => !loading() && local().length === 0 && cloudRows().length === 0
  const newCloud = () => dialog.show(() => <DialogNewCloudWorkspace cloud={cloud} />)
  return (
    <SettingsGroup title={t("projects.placements")} description={t("projects.where.description")}>
      <Show when={!empty()} fallback={<SettingsEmpty>{t("projects.placements.empty")}</SettingsEmpty>}>
        <SettingsList>
          <For each={local()}>{(placement) => <MachineRow placement={placement} machineName={machineName(placement)} />}</For>
          <For each={cloudRows()}>{(row) => <CloudRow row={row} cloud={cloud} />}</For>
        </SettingsList>
      </Show>
      <div class="projects-where-actions">
        <Show when={cloudOffered()}>
          <Button variant="neutral" size="small" icon="plus" onClick={newCloud}>{t("projects.where.newCloud")}</Button>
        </Show>
        <Button variant="ghost" size="small" icon="plus" onClick={connectMachine}>{t("projects.where.connectMachine")}</Button>
      </div>
      <Show when={cloudOffered()}>
        <SettingsNote>{t("projects.where.setup")}</SettingsNote>
      </Show>
    </SettingsGroup>
  )
}
