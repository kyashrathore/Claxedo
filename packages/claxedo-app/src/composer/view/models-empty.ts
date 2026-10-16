import type { Accessor } from "solid-js"
import { useStartFresh, useWakeProgress, useWakeWorkspace, useWorkspaceName, type StartFreshAction } from "@/cloud"
import { useServer, type PlacementId, type WorkspaceRuntime } from "@/server"
import type { HarnessType } from "../harness/profile"
import { useComposerText } from "../text"
import { modelsEmptyNotice } from "./models-empty-notice"
import type { HarnessAccountState } from "./harness-account-state"
import type { ModelLoadFailure } from "./harness-picker-model-section"

type ModelsEmptyInput = {
  readonly harness: Accessor<HarnessType | undefined>
  readonly harnessLabel: (harness: HarnessType) => string
  readonly runtime: Accessor<WorkspaceRuntime>
  readonly account: Accessor<HarnessAccountState>
  readonly placementId: Accessor<PlacementId | undefined>
  readonly openProviders: () => void
  readonly unavailableHere: Accessor<ModelLoadFailure | undefined>
}

export function createModelsEmpty(input: ModelsEmptyInput): Accessor<ModelLoadFailure | undefined> {
  const t = useComposerText()
  const server = useServer()
  const named = useWorkspaceName()
  const wakeWorkspace = useWakeWorkspace()
  const startFresh = useStartFresh()
  const wakeProgress = useWakeProgress(input.runtime)
  const workspaceName = () => {
    const id = input.placementId()
    const placement = id && server.placements.byId(id)
    return placement ? named(placement.label, placement.branch) : ""
  }
  const wake = () => {
    const id = input.placementId()
    if (id) wakeWorkspace(id)
  }
  const startFreshAction: StartFreshAction = {
    label: startFresh.label,
    run: () => {
      const id = input.placementId()
      if (id) startFresh.run(id, workspaceName())
    },
  }
  return () => {
    const harness = input.harness()
    if (!harness) return undefined
    return modelsEmptyNotice(t, {
      harnessName: input.harnessLabel(harness),
      workspaceName: workspaceName(),
      runtime: input.runtime(),
      wakeProgress: wakeProgress(),
      account: input.account(),
      unavailableHere: input.unavailableHere(),
      wake,
      startFresh: startFreshAction,
      openProviders: input.openProviders,
    })
  }
}
