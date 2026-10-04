import { lazyView } from "@/lib/lazy-view"

export { FilesProvider, useFiles } from "./store"
export { useActiveSession } from "./location"
export { useRootListingPrefetch } from "./tree-source"
export { parentPath } from "./path"
export { isMarkdownPath, isMediaPath } from "./preview"
export const FileTab = lazyView(() => import("./view/file-tab").then((module) => module.FileTab))
export { FilesNavigator } from "./view/files-navigator"
