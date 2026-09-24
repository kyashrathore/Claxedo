import { useDialog } from "@/ui"
import { nativeFolderDialog } from "./desktop-folder"
import { useProjectsText } from "./i18n"
import { FolderBrowserDialog } from "./view/folder-browser"

export function useFolderPicker(): () => Promise<string | undefined> {
  const dialog = useDialog()
  const t = useProjectsText()
  return () => {
    const native = nativeFolderDialog()
    if (native) return native(t("projects.picker.title"))
    return new Promise((resolve) => dialog.show(() => <FolderBrowserDialog onChoose={resolve} />, () => resolve(undefined)))
  }
}
