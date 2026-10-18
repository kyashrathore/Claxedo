import { onMount } from "solid-js"
import { nextIdleSlice } from "@/lib/idle"
import { lazyView } from "@/lib/lazy-view"

export const loadOnDemandViews = () => Promise.all([import("./slash-popover"), import("./image-attachments"), import("../quote/annotation-editor")])

export const PromptPopover = lazyView(() => import("./slash-popover").then((module) => module.PromptPopover))

export const PromptImageAttachments = lazyView(() => import("./image-attachments").then((module) => module.PromptImageAttachments))

export const AnnotationEditor = lazyView(() => import("../quote/annotation-editor").then((module) => module.AnnotationEditor))

export function warmOnDemandViews(): void {
  onMount(() => {
    void nextIdleSlice()
      .then(loadOnDemandViews)
      .catch((error: unknown) => console.warn("The composer's popover, attachments and annotation editor could not be fetched ahead; they load when first shown", { error }))
  })
}
