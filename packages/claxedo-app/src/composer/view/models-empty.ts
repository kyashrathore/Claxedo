import type { Accessor } from "solid-js"
import { useWorkspaceName } from "@/cloud"
import { useServer, type PlacementId } from "@/server"
import type { HarnessType } from "../harness/profile"
import { useComposerText } from "../text"
import type { HarnessAccountState } from "./harness-account-state"
import type { ModelLoadFailure } from "./harness-picker-model-section"

type ModelsEmptyInput = {
  readonly harness: Accessor<HarnessType | undefined>
  readonly harnessLabel: (harness: HarnessType) => string
  readonly asleep: Accessor<boolean>
  readonly account: Accessor<HarnessAccountState>
  readonly placementId: Accessor<PlacementId | undefined>
  readonly openProviders: () => void
}

export function createModelsEmpty(input: ModelsEmptyInput): Accessor<ModelLoadFailure | undefined> {
  const t = useComposerText()
  const server = useServer()
  const named = useWorkspaceName()
  const placementName = (id: PlacementId | undefined) => {
    const placement = id && server.placements.byId(id)
    return placement ? named(placement.label, placement.branch) : ""
  }
  return () => {
    const harness = input.harness()
    if (!harness) return undefined
    const name = input.harnessLabel(harness)
    if (input.asleep()) {
      const id = input.placementId()
      return { message: t("composer.models.asleep", { name: placementName(id) }), detail: t("composer.models.asleep.detail") }
    }
    if (input.account() === "missing") {
      return { message: t("composer.models.none"), detail: t("composer.models.none.detail", { harness: name }), action: { label: t("composer.models.addAccount"), run: input.openProviders } }
    }
    return input.account() === "present" ? { message: t("composer.models.empty", { harness: name }) } : undefined
  }
}
