import type { CommentItem } from "./submit-input"

export function createSubmitCommentActions(context: {
  add: (item: CommentItem & { type: "file" }) => unknown
  remove: (key: string) => unknown
}) {
  return {
    restore(items: CommentItem[]) {
      for (const item of items) context.add({ type: "file", ...item })
    },
    remove(items: { key: string }[]) {
      for (const item of items) context.remove(item.key)
    },
  }
}

type PromptCommentFocus = {
  file: string
  id: string
}

export type PromptCommentOpenItem = {
  path: string
  commentID?: string
  commentOrigin?: "review" | "file"
}

type PromptCommentRouterInput = {
  comments: {
    setActive: (focus: PromptCommentFocus) => void
    setFocus: (focus: PromptCommentFocus) => void
    focus: () => PromptCommentFocus | null | undefined
  }
  diffFiles: () => readonly string[] | undefined
  view: () => {
    reviewPanel: {
      opened: () => boolean
      open: () => void
    }
  }
  layout: {
    fileTree: {
      setTab: (tab: "all" | "changes") => void
    }
  }
  tabs: () => {
    open: (tab: string) => void
    setActive: (tab: string) => void
  }
  files: {
    tab: (path: string) => string
    load: (path: string) => unknown
  }
  scheduleFrame?: (callback: () => void) => void
}

export function createPromptCommentRouter(input: PromptCommentRouterInput) {
  const scheduleFrame = input.scheduleFrame ?? ((callback) => requestAnimationFrame(callback))

  return (item: PromptCommentOpenItem) => {
    if (!item.commentID) return

    const focus = { file: item.path, id: item.commentID }
    input.comments.setActive(focus)

    const queueCommentFocus = (attempts = 6) => {
      const schedule = (left: number) => {
        scheduleFrame(() => {
          input.comments.setFocus({ ...focus })
          if (left <= 0) return
          scheduleFrame(() => {
            const current = input.comments.focus()
            if (!current) return
            if (current.file !== focus.file || current.id !== focus.id) return
            schedule(left - 1)
          })
        })
      }

      schedule(attempts)
    }

    if (item.commentOrigin === "review" || (item.commentOrigin !== "file" && input.diffFiles()?.includes(item.path))) {
      if (!input.view().reviewPanel.opened()) input.view().reviewPanel.open()
      input.layout.fileTree.setTab("changes")
      input.tabs().setActive("review")
      queueCommentFocus()
      return
    }

    if (!input.view().reviewPanel.opened()) input.view().reviewPanel.open()
    input.layout.fileTree.setTab("all")
    const tab = input.files.tab(item.path)
    input.tabs().open(tab)
    input.tabs().setActive(tab)
    Promise.resolve(input.files.load(item.path)).finally(() => queueCommentFocus())
  }
}
