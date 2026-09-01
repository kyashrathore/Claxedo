import type { Accessor } from "solid-js"
import { harnessProfile, pickHarness } from "@/features/session/harness/profile"
import type { createHarnessSubmitController } from "@/features/session/harness/controller"
import { composerHarnessId, isComposerHarnessMode, type ComposerMode } from "../mode"

export type PromptComposerEditMode = "normal" | "shell"

export type PromptModeCommand = {
  id: string
  title: string
  category: string
  keybind: string
  slash?: string
  disabled: boolean
  onSelect: VoidFunction
}

export const promptShellModeKey = "mod+shift+x"
export const promptNormalModeKey = "mod+shift+e"

export function registerPromptModeCommands(input: {
  register: (scope: string, commands: () => PromptModeCommand[]) => void
  mode: Accessor<PromptComposerEditMode>
  pick: VoidFunction
  setMode: (mode: PromptComposerEditMode) => void
  /** Goal entry-point gate: unknown capabilities count as selectable — `armGoal` resolves the truth. */
  goalSelectable: Accessor<boolean>
  armGoal: VoidFunction
  labels: {
    attachFile: string
    fileCategory: string
    shellMode: string
    normalMode: string
    sessionCategory: string
    goal: string
  }
}) {
  input.register("prompt-input", () => [
    {
      id: "file.attach",
      title: input.labels.attachFile,
      category: input.labels.fileCategory,
      keybind: "mod+u",
      disabled: input.mode() !== "normal",
      onSelect: input.pick,
    },
    {
      id: "prompt.goal",
      title: input.labels.goal,
      category: input.labels.sessionCategory,
      keybind: "",
      slash: "goal",
      disabled: input.mode() !== "normal" || !input.goalSelectable(),
      onSelect: input.armGoal,
    },
    {
      id: "prompt.mode.shell",
      title: input.labels.shellMode,
      category: input.labels.sessionCategory,
      keybind: promptShellModeKey,
      disabled: input.mode() === "shell",
      onSelect: () => input.setMode("shell"),
    },
    {
      id: "prompt.mode.normal",
      title: input.labels.normalMode,
      category: input.labels.sessionCategory,
      keybind: promptNormalModeKey,
      disabled: input.mode() === "normal",
      onSelect: () => input.setMode("normal"),
    },
  ])
}

/** The composer's harness-selection reads: one derivation for mode, type, ref, and display name. */
export function createSubmitHarnessSelection(input: {
  composerMode: () => ComposerMode
  harnessController: Pick<ReturnType<typeof createHarnessSubmitController>, "isHarnessMode" | "harness">
}) {
  const selectedHarnessMode = (scope: string) => {
    const mode = input.composerMode()
    if (mode.kind === "session") return isComposerHarnessMode(mode)
    return input.harnessController.isHarnessMode(scope) || isComposerHarnessMode(mode)
  }
  const selectedHarnessType = (scope: string) => {
    const mode = input.composerMode()
    if (mode.kind === "session") return composerHarnessId(mode)
    const harness = input.harnessController.harness(scope)
    return harness === "opencode" ? composerHarnessId(mode) : harness
  }
  const selectedHarnessRef = (scope: string) => {
    const id = pickHarness(selectedHarnessType(scope))
    return id && id !== "opencode" ? { id } : undefined
  }
  const selectedHarnessDisplayName = (scope: string) =>
    harnessProfile(pickHarness(selectedHarnessType(scope)) ?? "opencode").displayName
  return { selectedHarnessMode, selectedHarnessType, selectedHarnessRef, selectedHarnessDisplayName }
}
