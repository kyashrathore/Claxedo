import { lazyView } from "@/lib/lazy-view"

export { ReviewProvider } from "./store"
export type { ReviewFocus } from "./view/review-tab"
export const ReviewTab = lazyView(() => import("./view/review-tab").then((module) => module.ReviewTab))
export const loadSourceControlView = () => import("./view/source-control-view")
export const SourceControlView = lazyView(() => loadSourceControlView().then((module) => module.SourceControlView))
export { useLineComments } from "./comments"
export { reviewDictionary } from "./i18n"
