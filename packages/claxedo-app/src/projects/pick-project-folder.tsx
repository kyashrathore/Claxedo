import type { JSX } from "solid-js"
import type { FolderPlace } from "./folder-places"
import { DialogSelectDirectory } from "./view/select-directory"

type DialogHost = { push: (view: () => JSX.Element, onClose?: () => void) => unknown }

export function pickProjectFolderWith(dialog: DialogHost) {
  return (place?: FolderPlace) =>
    new Promise<string | undefined>((resolve) => {
      void dialog.push(
        () => <DialogSelectDirectory {...(place?.machine ? { machine: place.machine } : {})} onSelect={resolve} />,
        () => resolve(undefined),
      )
    })
}
