import { createMemo, type Accessor } from "solid-js"
import type { WorkbenchStore } from "../store"

export function createContentTitle(wb: WorkbenchStore, contentId: Accessor<string | null | undefined>): Accessor<string | undefined> {
  return createMemo(() => {
    const id = contentId()
    const opened = id ? wb.content(id) : undefined
    return opened?.kind.title(opened.state as never)
  })
}
