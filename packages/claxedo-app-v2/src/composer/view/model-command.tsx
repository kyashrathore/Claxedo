import { Button, Dialog } from "@/ui"
import type { useDialog } from "@/ui"
import type { ModelKey } from "../harness/model-key"
import { ModelList, type PickerItem } from "./model-list"

export type ModelChoice = {
  readonly items: readonly PickerItem[]
  readonly current: ModelKey | undefined
  readonly choose: (model: ModelKey) => void
}

export function showModelDialog(dialog: ReturnType<typeof useDialog>, labels: { title: string; connect: string }, choice: ModelChoice, connect: () => void) {
  const current = () => choice.items.find((item) => item.id === choice.current?.modelID && item.provider.id === choice.current.providerID)
  dialog.show(() => (
    <Dialog
      title={labels.title}
      action={
        <Button class="h-7 -my-1 text-14-medium" icon="plus-small" tabIndex={-1} onClick={() => { dialog.close(); connect() }}>
          {labels.connect}
        </Button>
      }
    >
      <ModelList
        model={{ list: () => [...choice.items], current, set: (model) => model && choice.choose(model) }}
        onSelect={() => dialog.close()}
      />
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
