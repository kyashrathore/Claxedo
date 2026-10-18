import { lazyView } from "@/lib/lazy-view"

export const loadOnDemandViews = () => Promise.all([import("./slash-popover"), import("./image-attachments"), import("../quote/annotation-editor")])

export const PromptPopover = lazyView(() => import("./slash-popover").then((module) => module.PromptPopover))

export const PromptImageAttachments = lazyView(() => import("./image-attachments").then((module) => module.PromptImageAttachments))

export const AnnotationEditor = lazyView(() => import("../quote/annotation-editor").then((module) => module.AnnotationEditor))
