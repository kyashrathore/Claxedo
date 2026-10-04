import type { Accessor } from "solid-js"

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

type ModeCommandsInput = {
  register: (scope: string, commands: () => PromptModeCommand[]) => void
  mode: Accessor<PromptComposerEditMode>
  pick: VoidFunction
  setMode: (mode: PromptComposerEditMode) => void
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
}

export function registerPromptModeCommands(input: ModeCommandsInput) {
  input.register("prompt-input", () => promptModeCommands(input))
}

function promptModeCommands(input: ModeCommandsInput): PromptModeCommand[] {
  return [
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
  ]
}
