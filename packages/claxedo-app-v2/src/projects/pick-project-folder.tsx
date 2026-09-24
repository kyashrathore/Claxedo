import type { JSX } from "solid-js"
import { DialogSelectDirectory } from "./view/select-directory"

type DialogHost = { show: (view: () => JSX.Element, onClose?: () => void) => unknown }

export function pickProjectFolderWith(dialog: DialogHost) {
  return () =>
    new Promise<string | undefined>((resolve) => {
      void dialog.show(
        () => <DialogSelectDirectory onSelect={(dir) => resolve(typeof dir === "string" ? dir : undefined)} />,
        () => resolve(undefined),
      )
    })
}
