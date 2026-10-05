import { For, Match, Show, Switch, type JSX } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { canStart, canStop, cloudFailureReason, useCloudCommandFailureText, useCloudStatusText, useCloudWorkspaces, useWorkspaceName, type CloudWorkspaceRow, type CloudWorkspaces } from "@/cloud"
import { useErrorCopy } from "@/i18n"
import { FailureNotice } from "@/lib/failure"
import { machineOfPlacement, useServer, type AppError, type Machine, type Placement, type Project } from "@/server"
import { SettingsEmpty, SettingsGroup, SettingsList, SettingsListSkeleton, SettingsNote, SettingsRow, useConnectMachine } from "@/settings"
import { Button, requestConfirm, useDialog } from "@/ui"
import { homeRelativePath } from "../folder-paths"
import { useProjectsText, type ProjectsKey } from "../i18n"
import { usePlacementOpener } from "../open"
import { useProjectPlacements } from "../store"
import { DialogNewCloudWorkspace } from "./new-cloud-workspace-dialog"

function MachinePlacementRow(props: { readonly placement: Placement; readonly machine: Machine | undefined }): JSX.Element {
  const t = useProjectsText()
  const open = usePlacementOpener()
  const path = () => (props.placement.path ? homeRelativePath(props.placement.path) : undefined)
  const state = (): ProjectsKey => {
    if (props.machine?.paused) return "projects.where.paused"
    return (props.machine?.online ?? props.placement.reachable) ? "projects.where.online" : "projects.where.offline"
  }
  const detail = () => [props.machine?.name, path(), props.placement.branch, t(state())].filter(Boolean).join(" · ")
  return (
    <SettingsRow title={props.placement.label} description={detail()}>
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
  const commandFailure = useCloudCommandFailureText()
  const named = useWorkspaceName()
  const name = () => named(props.row.name, undefined)
  const detail = () => [props.row.branch, status(props.row.state), cloudFailureReason(props.row.state), commandFailure(props.row.commandFailure)].filter(Boolean).join(" · ")
  const remove = async () => {
    const confirmed = await requestConfirm(dialog, {
      title: t("projects.where.delete.title", { name: name() }),
      body: t("projects.where.delete.body"),
      confirmLabel: t("projects.where.delete.confirm"),
      cancelLabel: t("projects.where.cancel"),
    })
    if (confirmed) await props.cloud.remove(props.row.id)
  }
  return (
    <SettingsRow title={<span title={props.row.id}>{name()}</span>} description={detail()}>
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

function PlacementRows(props: { readonly local: readonly Placement[]; readonly cloudRows: readonly CloudWorkspaceRow[]; readonly cloud: CloudWorkspaces }): JSX.Element {
  const t = useProjectsText()
  const server = useServer()
  const machines = useQuery(() => server.queries.machines.list())
  const machineOf = (placement: Placement) => machineOfPlacement(machines.data ?? [], placement)
  return (
    <Show when={props.local.length + props.cloudRows.length > 0} fallback={<SettingsEmpty>{t("projects.placements.empty")}</SettingsEmpty>}>
      <SettingsList>
        <For each={props.local}>{(placement) => <MachinePlacementRow placement={placement} machine={machineOf(placement)} />}</For>
        <For each={props.cloudRows}>{(row) => <CloudRow row={row} cloud={props.cloud} />}</For>
      </SettingsList>
    </Show>
  )
}

type PlacementsReady = { readonly local: readonly Placement[]; readonly cloudRows: readonly CloudWorkspaceRow[] }

type PlacementsLoad = { readonly kind: "loading" } | { readonly kind: "failed"; readonly error: AppError; readonly retry: () => void } | ({ readonly kind: "ready" } & PlacementsReady)

function usePlacementsLoad(project: () => Project, cloud: CloudWorkspaces, cloudOffered: () => boolean): () => PlacementsLoad {
  const placements = useProjectPlacements(() => project().id)
  return () => {
    const machine = placements.state()
    const listed = cloudOffered() ? cloud.list() : { kind: "ready" as const, rows: [] }
    if (machine.kind === "failed") return { kind: "failed", error: machine.error, retry: placements.retry }
    if (listed.kind === "failed") return { kind: "failed", error: listed.error, retry: cloud.refresh }
    if (machine.kind === "loading" || listed.kind === "loading") return { kind: "loading" }
    return { kind: "ready", local: machine.data.filter((placement) => placement.kind !== "cloud"), cloudRows: listed.rows }
  }
}

export function WhereItRuns(props: { readonly project: Project }): JSX.Element {
  const t = useProjectsText()
  const server = useServer()
  const dialog = useDialog()
  const errorCopy = useErrorCopy("projects")
  const connectMachine = useConnectMachine()
  const cloudOffered = () => server.capabilities()?.features.cloud === true && props.project.source?.kind !== "folder"
  const cloud = useCloudWorkspaces(() => props.project.id, cloudOffered)
  const load = usePlacementsLoad(() => props.project, cloud, cloudOffered)
  const ready = (): PlacementsReady | undefined => {
    const state = load()
    return state.kind === "ready" ? state : undefined
  }
  const failed = () => {
    const state = load()
    return state.kind === "failed" ? state : undefined
  }
  const newCloud = () => dialog.show(() => <DialogNewCloudWorkspace cloud={cloud} />)
  return (
    <SettingsGroup title={t("projects.placements")} description={t("projects.where.description")}>
      <Switch fallback={<SettingsListSkeleton />}>
        <Match when={ready()}>
          {(ready) => <PlacementRows local={ready().local} cloudRows={ready().cloudRows} cloud={cloud} />}
        </Match>
        <Match when={failed()}>
          {(failed) => <FailureNotice title={t("projects.placements.failed")} message={errorCopy(failed().error).message} retryLabel={errorCopy(failed().error).retry} onRetry={failed().retry} />}
        </Match>
      </Switch>
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
