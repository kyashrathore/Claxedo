import type { Capabilities, Machine } from "@/server"
import type { PlacementChoice } from "./model"

export type PlacementOption =
  | { readonly kind: "machine"; readonly key: string; readonly machine: Machine; readonly selectable: boolean }
  | { readonly kind: "cloud"; readonly key: string; readonly selectable: true }

export function choiceKey(choice: PlacementChoice): string {
  return choice.kind === "cloud" ? "cloud" : `machine:${choice.machineId}`
}

export function optionChoice(option: PlacementOption): PlacementChoice {
  return option.kind === "cloud" ? { kind: "cloud" } : { kind: "machine", machineId: option.machine.id }
}

export function placementOptions(
  capabilities: Capabilities | undefined,
  machines: readonly Machine[],
  folderSource: boolean,
): readonly PlacementOption[] {
  const self = capabilities?.thisMachine
  const all = self && !machines.some((machine) => machine.id === self.id) ? [self, ...machines] : machines
  const options: PlacementOption[] = all.map((machine) => ({
    kind: "machine",
    key: choiceKey({ kind: "machine", machineId: machine.id }),
    machine,
    selectable: machine.isThisMachine && machine.online,
  }))
  if (capabilities?.features.cloud && !folderSource) options.push({ kind: "cloud", key: choiceKey({ kind: "cloud" }), selectable: true })
  return options
}

export function chosenPlacement(options: readonly PlacementOption[], explicit: PlacementChoice | undefined): PlacementChoice | undefined {
  const selectable = options.filter((option) => option.selectable).map(optionChoice)
  const kept = explicit ? selectable.find((choice) => choiceKey(choice) === choiceKey(explicit)) : undefined
  return kept ?? selectable[0]
}
