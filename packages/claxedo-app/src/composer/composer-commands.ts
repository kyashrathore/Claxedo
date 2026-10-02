import type { Accessor } from "solid-js"
import { settingsPath, useCommands, useShellRoute, type CommandOption } from "@/shell"
import { useDialog } from "@/ui"
import type { ComposerHarness } from "./composer-harness"
import type { ComposerController } from "./controller"
import { harnessModelItems } from "./harness/model-items"
import type { ComposerRefs } from "./refs"
import type { createComposerSend } from "./send"
import type { ComposerKey } from "./store"
import type { useComposerText } from "./text"
import { registerPromptModeCommands } from "./view/mode-commands"
import { registerModelCommand, showModelDialog } from "./view/model-command"

type CommandsInput = {
  readonly key: Accessor<ComposerKey>
  readonly harness: ComposerHarness
  readonly controller: ComposerController
  readonly refs: ComposerRefs
  readonly send: ReturnType<typeof createComposerSend>
  readonly goalAvailable: Accessor<boolean>
  readonly manageSession: Accessor<boolean>
  readonly hidden: Accessor<boolean>
  readonly t: ReturnType<typeof useComposerText>
}

type Register = (scope: string, options: () => CommandOption[]) => void

export function registerComposerCommands(input: CommandsInput) {
  const commands = useCommands()
  const register: Register = (scope, options) => commands.register(scope, () => (input.hidden() ? [] : options()))
  registerModelChooser(input, (scope, options) => register(scope, () => input.manageSession() ? options() : []))
  const { t, controller } = input
  registerPromptModeCommands({
    register,
    mode: () => controller.state.mode,
    shellEnabled: input.manageSession,
    pick: () => input.refs.fileInput()?.click(),
    setMode: controller.setMode,
    goalSelectable: input.goalAvailable,
    armGoal: input.send.armGoal,
    labels: {
      attachFile: t("prompt.action.attachFile"),
      fileCategory: t("command.category.file"),
      shellMode: t("command.prompt.mode.shell"),
      normalMode: t("command.prompt.mode.normal"),
      sessionCategory: t("command.category.session"),
      goal: t("prompt.action.goal"),
    },
  })
}

function registerModelChooser({ key, harness, t }: CommandsInput, register: Register) {
  const dialog = useDialog()
  const routing = useShellRoute()
  registerModelCommand({
    register,
    available: () => !!harness.selection().harness,
    open: () => {
      const scope = key()
      const snapshot = harness.controller.read(scope)
      showModelDialog(
        dialog,
        { title: t("dialog.model.select.title"), connect: t("command.provider.connect") },
        {
          items: harnessModelItems(snapshot),
          current: snapshot.selectedModelKey,
          choose: (model) => void harness.controller.setModel(scope, model, harness.scopeInput()),
        },
        () => routing.navigate(settingsPath("models")),
      )
    },
    labels: { title: t("command.model.choose"), description: t("command.model.choose.description"), category: t("command.category.model") },
  })
}
