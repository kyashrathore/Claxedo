import type { JSX } from "solid-js"
import { DialogSelectDirectory } from "@/features/session/app-ports"

type DialogHost = { show: (view: () => JSX.Element, onClose?: () => void) => unknown }

/**
 * The folder source of "Create project…" in the composer's Project chip: opens
 * the server's folder picker and resolves to the chosen path, or `undefined`
 * when the picker closes without a choice.
 */
export function pickProjectFolderWith(dialog: DialogHost) {
  return () =>
    new Promise<string | undefined>((resolve) => {
      void dialog.show(
        () => <DialogSelectDirectory onSelect={(dir) => resolve(typeof dir === "string" ? dir : undefined)} />,
        () => resolve(undefined),
      )
    })
}
