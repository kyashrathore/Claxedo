import { Dialog } from "@/ui"
import type { useDialog } from "@/ui"
import type { ModelChoice } from "@/server"
import { ModelList, type PickerItem } from "./model-list"

export function chooseRecoveryModel(dialog: ReturnType<typeof useDialog>, title: string, candidates: readonly PickerItem[]): Promise<ModelChoice | undefined> {
  return new Promise((resolve) => {
    dialog.show(
      () => (
        <Dialog title={title}>
          <ModelList
            model={{ list: () => [...candidates], current: () => undefined, set: (model) => resolve(model) }}
            onSelect={() => dialog.close()}
          />
        </Dialog>
      ),
      () => resolve(undefined),
    )
  })
}
