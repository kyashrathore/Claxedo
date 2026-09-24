import { createSignal, type Accessor } from "solid-js"

export type PortalSlot = readonly [get: Accessor<HTMLElement | null>, set: (el: HTMLElement | null) => void]

export function createPortalSlot(name: string): PortalSlot {
  const [slot, setSlotInternal] = createSignal<HTMLElement | null>(null, { name })
  const set = (el: HTMLElement | null): void => {
    setSlotInternal(el)
  }
  return [slot, set] as const
}

export const [browserToolbarSlot, setBrowserToolbarSlot] = createPortalSlot("browser-toolbar")
export const [processToolbarSlot, setProcessToolbarSlot] = createPortalSlot("process-toolbar")
export const [fileHeaderActionsSlot, setFileHeaderActionsSlot] = createPortalSlot("file-header-actions")

export const [reviewToolbarSlot, setReviewToolbarSlot] = createPortalSlot("review-toolbar")

export const [reviewControlsSlot, setReviewControlsSlot] = createPortalSlot("review-controls")

export const [reviewTabHeaderSlot, setReviewTabHeaderSlot] = createPortalSlot("review-tab-header")

export const [titlebarLeftSlot, setTitlebarLeftSlot] = createPortalSlot("titlebar-left")
export const [titlebarCenterSlot, setTitlebarCenterSlot] = createPortalSlot("titlebar-center")
export const [titlebarRightSlot, setTitlebarRightSlot] = createPortalSlot("titlebar-right")
