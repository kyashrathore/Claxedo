import { Dialog, DialogBody, DialogHeader, DialogTitle } from "@/ui"
import type { useDialog } from "@/ui"
import type { ModelChoice } from "@/server"
import { ModelList, type PickerItem } from "./model-list"

export function chooseRecoveryModel(dialog: ReturnType<typeof useDialog>, title: string, candidates: readonly PickerItem[]): Promise<ModelChoice | undefined> {
  return new Promise((resolve) => {
    dialog.show(
      () => (
        <Dialog size="large">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          <DialogBody>
          <ModelList
            model={{ list: () => [...candidates], current: () => undefined, set: (model) => resolve(model) }}
            onSelect={() => dialog.close()}
          />
          </DialogBody>
        </Dialog>
      ),
      () => resolve(undefined),
    )
  })
}
