import { lazyView } from "@/lib/lazy-view"

export { ReviewProvider } from "./store"
export type { ReviewFocus } from "./view/review-tab"
export const ReviewTab = lazyView(() => import("./view/review-tab").then((module) => module.ReviewTab))
export { SourceControlView } from "./view/source-control-view"
export { useLineComments } from "./comments"
