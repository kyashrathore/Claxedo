import { Button, Dialog, DialogBody, DialogHeader, DialogTitle, Icon } from "@/ui"
import type { useDialog } from "@/ui"
import type { ModelChoice } from "@/server"
import { ModelList, type PickerItem } from "./model-list"

export type ModelDialogChoice = {
  readonly items: readonly PickerItem[]
  readonly current: ModelChoice | undefined
  readonly choose: (model: ModelChoice) => void
}

export function showModelDialog(dialog: ReturnType<typeof useDialog>, labels: { title: string; connect: string }, choice: ModelDialogChoice, connect: () => void) {
  const current = () => choice.items.find((item) => item.id === choice.current?.modelId && item.provider.id === choice.current.providerId)
  dialog.show(() => (
    <Dialog size="large" fit containerClass="long-dialog-container">
      <DialogHeader>
        <DialogTitle>{labels.title}</DialogTitle>
        <Button class="h-7 -my-1 text-14-medium" tabIndex={-1} onClick={() => { dialog.close(); connect() }}>
          <Icon name="plus-small" size="small" />
          {labels.connect}
        </Button>
      </DialogHeader>
      <DialogBody>
      <ModelList
        model={{ list: () => [...choice.items], current, set: (model) => model && choice.choose(model) }}
        onSelect={() => dialog.close()}
      />
      </DialogBody>
    </Dialog>
  ))
}

export function registerModelCommand(input: {
  readonly register: (scope: string, options: () => ModelCommandOption[]) => void
  readonly available: () => boolean
  readonly open: () => void
  readonly labels: { readonly title: string; readonly description: string; readonly category: string }
}) {
  input.register("prompt-model", () => [
    {
      id: "model.choose",
      title: input.labels.title,
      description: input.labels.description,
      category: input.labels.category,
      keybind: "mod+'",
      slash: "model",
      disabled: !input.available(),
      onSelect: input.open,
    },
  ])
}

type ModelCommandOption = {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly category: string
  readonly keybind: string
  readonly slash: string
  readonly disabled: boolean
  readonly onSelect: () => void
}
