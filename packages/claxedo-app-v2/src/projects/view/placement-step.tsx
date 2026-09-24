import { createEffect, createMemo, For, Show, type Component } from "solid-js"
import type { Machine } from "@/server"
import { RadioGroup, RadioItem } from "@/ui"
import { useProjectsServer } from "../api"
import type { AddProjectFlow } from "../add-project"
import { useProjectsText, type ProjectsText } from "../i18n"
import type { PlacementChoice } from "../model"
import { useMachines } from "../store"

type Row = {
  readonly key: string
  readonly choice: PlacementChoice
  readonly title: string
  readonly detail: string
  readonly selectable: boolean
}

function sameChoice(a: PlacementChoice | undefined, b: PlacementChoice): boolean {
  if (!a) return false
  if (a.kind === "cloud" || b.kind === "cloud") return a.kind === b.kind
  return a.machineId === b.machineId
}

function machineRow(t: ProjectsText, machine: Machine, folderSource: boolean): Row {
  const detail = machine.isThisMachine
    ? t("projects.add.placement.thisMachine.hint")
    : folderSource
      ? t("projects.add.placement.folderNeedsMachine")
      : t("projects.add.placement.machine.unavailable")
  const title = machine.isThisMachine ? t("projects.add.placement.thisMachine") : machine.name
  return {
    key: `machine:${machine.id}`,
    choice: { kind: "machine", machineId: machine.id },
    title: machine.online ? title : `${title} (${t("projects.add.placement.offline")})`,
    detail: machine.isThisMachine ? detail : `${t("projects.add.placement.machine.hint")} ${detail}`,
    selectable: machine.isThisMachine && machine.online,
  }
}

function cloudRow(t: ProjectsText): Row {
  return {
    key: "cloud",
    choice: { kind: "cloud" },
    title: t("projects.add.placement.cloud"),
    detail: t("projects.add.placement.cloud.hint"),
    selectable: true,
  }
}

export const PlacementStep: Component<{ flow: AddProjectFlow }> = (props) => {
  const t = useProjectsText()
  const server = useProjectsServer()
  const machines = useMachines()
  const folderSource = () => props.flow.draft.source?.kind === "folder"

  const rows = createMemo((): readonly Row[] => {
    const capabilities = server.capabilities()
    const known = machines()
    const listed = known.kind === "ready" ? known.data : []
    const self = capabilities?.thisMachine
    const all = self && !listed.some((machine) => machine.id === self.id) ? [self, ...listed] : listed
    const result = all.map((machine) => machineRow(t, machine, folderSource()))
    if (capabilities?.features.cloud && !folderSource()) result.push(cloudRow(t))
    return result
  })
  const selectedKey = () => rows().find((row) => sameChoice(props.flow.draft.placement, row.choice))?.key ?? ""

  createEffect(() => {
    const current = props.flow.draft.placement
    const stillValid = current && rows().some((row) => row.selectable && sameChoice(current, row.choice))
    if (!stillValid) props.flow.setDraft("placement", rows().find((row) => row.selectable)?.choice)
  })

  return (
    <div class="flex flex-col gap-3" data-slot="placement-step">
      <RadioGroup
        class="projects-choices"
        aria-label={t("projects.add.placement.title")}
        value={selectedKey()}
        onChange={(key) => {
          const row = rows().find((candidate) => candidate.key === key)
          if (row) props.flow.setDraft("placement", row.choice)
        }}
      >
        <For each={rows()}>
          {(row) => <RadioItem value={row.key} label={row.title} description={row.detail} disabled={!row.selectable} data-placement={row.key} />}
        </For>
      </RadioGroup>
      <Show when={rows().every((row) => !row.selectable)}>
        <p class="projects-hint m-0">{t("projects.add.placement.empty")}</p>
      </Show>
    </div>
  )
}
