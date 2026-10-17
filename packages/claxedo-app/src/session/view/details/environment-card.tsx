import { createMemo, Show, type JSX } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { useWorkspaceName } from "@/cloud"
import { unreachable } from "@/lib/machine"
import { useProjectList } from "@/projects"
import { useServer, type Placement } from "@/server"
import { DetailsCard, DetailsRow } from "./details-card"
import { readsBranch, sessionEnvironment, type BranchRead, type EnvironmentBranch, type EnvironmentWhere } from "./environment"
import { useDetailsText, type DetailsText } from "./i18n"

const WHERE_ICON = { thisComputer: "monitor", machine: "server", cloud: "cloud" } as const

function whereState(t: DetailsText, where: EnvironmentWhere): string | undefined {
  switch (where.kind) {
    case "thisComputer":
      return undefined
    case "machine":
      return where.state === "online" ? undefined : t(where.state === "paused" ? "details.state.paused" : "details.state.offline")
    case "cloud":
      return where.lifecycle === "live" ? undefined : t(`details.state.${where.lifecycle}`)
    default:
      return unreachable(where)
  }
}

function branchRowText(t: DetailsText, branch: EnvironmentBranch): string {
  if (branch.kind === "named") return branch.name
  return t(branch.kind === "detached" ? "details.branch.detached" : "details.branch.unknown")
}

function useBranchRead(placement: () => Placement): () => BranchRead {
  const server = useServer()
  const status = useQuery(() => ({ ...server.queries.git.status(placement().id), enabled: readsBranch(placement()) }))
  return () => {
    if (!readsBranch(placement())) return { kind: "skipped" }
    if (status.data) return { kind: "ready", status: status.data }
    return status.isError ? { kind: "failed" } : { kind: "loading" }
  }
}

export function EnvironmentCard(props: { readonly placement: Placement }): JSX.Element {
  const t = useDetailsText()
  const server = useServer()
  const machines = useQuery(() => server.queries.machines.list())
  const projects = useProjectList()
  const workspaceName = useWorkspaceName()
  const branch = useBranchRead(() => props.placement)
  const environment = createMemo(() =>
    sessionEnvironment({
      placement: props.placement,
      machines: machines.data ?? [],
      projectName: projects.list().find((entry) => entry.project.id === props.placement.projectId)?.project.name,
      branch: branch(),
    }),
  )
  const whereName = () => {
    const where = environment().where
    if (where.kind === "thisComputer") return t("details.where.thisComputer")
    if (where.kind === "machine") return where.name ?? t("details.where.otherMachine")
    return workspaceName(where.name, props.placement.branch)
  }
  return (
    <DetailsCard slot="details-environment" title={t("details.environment")}>
      <DetailsRow icon={WHERE_ICON[environment().where.kind]}>
        <span data-slot="details-where" class="truncate">{whereName()}</span>
        <Show when={whereState(t, environment().where)}>
          {(state) => <span class="shrink-0 text-text-weak">{state()}</span>}
        </Show>
      </DetailsRow>
      <DetailsRow icon={environment().worktree ? "worktree" : "folder"} title={environment().path}>
        <span data-slot="details-folder" class="max-w-[70%] shrink-0 truncate">{environment().folder}</span>
        <Show when={environment().path}>
          {(path) => <span class="min-w-0 truncate text-text-weak">{path()}</span>}
        </Show>
      </DetailsRow>
      <DetailsRow icon="branch">
        <span data-slot="details-branch" class="truncate">{branchRowText(t, environment().branch)}</span>
      </DetailsRow>
    </DetailsCard>
  )
}
