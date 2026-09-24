import { createEffect, createMemo, For, Show, type Component } from "solid-js"
import type { Machine } from "@/server"
import { useProjectsServer } from "../api"
import type { AddProjectFlow } from "../add-project"
import { projectsText } from "../i18n"
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

function machineRow(machine: Machine, folderSource: boolean): Row {
  const detail = machine.isThisMachine
    ? projectsText("projects.add.placement.thisMachine.hint")
    : folderSource
      ? projectsText("projects.add.placement.folderNeedsMachine")
      : projectsText("projects.add.placement.machine.unavailable")
  const title = machine.isThisMachine ? projectsText("projects.add.placement.thisMachine") : machine.name
  return {
    key: `machine:${machine.id}`,
    choice: { kind: "machine", machineId: machine.id },
    title: machine.online ? title : `${title} (${projectsText("projects.add.placement.offline")})`,
    detail: machine.isThisMachine ? detail : `${projectsText("projects.add.placement.machine.hint")} ${detail}`,
    selectable: machine.isThisMachine && machine.online,
  }
}

export const PlacementStep: Component<{ flow: AddProjectFlow }> = (props) => {
  const server = useProjectsServer()
  const machines = useMachines()
  const folderSource = () => props.flow.draft.source?.kind === "folder"

  const rows = createMemo((): readonly Row[] => {
    const capabilities = server.capabilities()
    const known = machines()
    const listed = known.kind === "ready" ? known.data : []
    const self = capabilities?.thisMachine
    const all = self && !listed.some((machine) => machine.id === self.id) ? [self, ...listed] : listed
    const result = all.map((machine) => machineRow(machine, folderSource()))
    if (capabilities?.features.cloud && !folderSource()) {
      result.push({
        key: "cloud",
        choice: { kind: "cloud" },
        title: projectsText("projects.add.placement.cloud"),
        detail: projectsText("projects.add.placement.cloud.hint"),
        selectable: true,
      })
    }
    return result
  })

  createEffect(() => {
    const current = props.flow.draft.placement
    const first = rows().find((row) => row.selectable)
    const stillValid = current && rows().some((row) => row.selectable && sameChoice(current, row.choice))
    if (!stillValid) props.flow.setDraft("placement", first?.choice)
  })

  return (
    <div class="flex flex-col gap-3" data-slot="placement-step">
      <div role="radiogroup" aria-label={projectsText("projects.add.placement.title")} class="flex flex-col gap-2">
        <For each={rows()}>
          {(row) => (
            <button
              type="button"
              role="radio"
              class="projects-choice"
              aria-checked={sameChoice(props.flow.draft.placement, row.choice)}
              disabled={!row.selectable}
              data-placement={row.key}
              onClick={() => props.flow.setDraft("placement", row.choice)}
            >
              <span class="projects-choice-title">{row.title}</span>
              <span class="projects-choice-detail">{row.detail}</span>
            </button>
          )}
        </For>
      </div>
      <Show when={rows().every((row) => !row.selectable)}>
        <p class="projects-hint">{projectsText("projects.add.placement.empty")}</p>
      </Show>
    </div>
  )
}
