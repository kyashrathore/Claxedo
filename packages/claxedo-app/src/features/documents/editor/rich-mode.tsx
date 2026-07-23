import type { Editor } from "@tiptap/core"
import { TextSelection } from "@tiptap/pm/state"
import { createTiptapEditor } from "solid-tiptap"
import { For, Show, createComputed, createSignal, onCleanup } from "solid-js"
import { joinMarkdownEnvelope, normalizeSerializedMarkdownBody } from "@/features/documents/markdown/frontmatter"
import type { RichMarkdown } from "@/features/documents/markdown/detector"
import { documentRichEditorExtensions } from "./rich-extensions"
import "./document-editor.css"

type TocMark = { order: number; pos: number; title: string; level: number }

type ToolbarAction = {
  label: string
  icon: string
  active: (editor: Editor) => boolean
  run: (editor: Editor) => void
  style?: string
}

const toolbarActions: ToolbarAction[] = [
  {
    label: "Bold",
    icon: "B",
    style: "font-weight:700",
    active: (editor) => editor.isActive("bold"),
    run: (editor) => editor.chain().focus().toggleBold().run(),
  },
  {
    label: "Italic",
    icon: "I",
    style: "font-style:italic",
    active: (editor) => editor.isActive("italic"),
    run: (editor) => editor.chain().focus().toggleItalic().run(),
  },
  {
    label: "Underline",
    icon: "U",
    style: "text-decoration:underline",
    active: (editor) => editor.isActive("underline"),
    run: (editor) => editor.chain().focus().toggleUnderline().run(),
  },
  {
    label: "Strikethrough",
    icon: "S",
    style: "text-decoration:line-through",
    active: (editor) => editor.isActive("strike"),
    run: (editor) => editor.chain().focus().toggleStrike().run(),
  },
  {
    label: "Inline code",
    icon: "<>",
    style: "font-family:var(--font-family-mono)",
    active: (editor) => editor.isActive("code"),
    run: (editor) => editor.chain().focus().toggleCode().run(),
  },
  {
    label: "Highlight",
    icon: "▰",
    active: (editor) => editor.isActive("highlight"),
    run: (editor) => editor.chain().focus().toggleHighlight({ color: "var(--surface-warning-base)" }).run(),
  },
]

const blockActions: ToolbarAction[] = [
  {
    label: "Text",
    icon: "T",
    active: (editor) => editor.isActive("paragraph"),
    run: (editor) => editor.chain().focus().clearNodes().setParagraph().run(),
  },
  ...([1, 2, 3] as const).map((level) => ({
    label: `Heading ${level}`,
    icon: `H${level}`,
    active: (editor: Editor) => editor.isActive("heading", { level }),
    run: (editor: Editor) => editor.chain().focus().clearNodes().setHeading({ level }).run(),
  })),
  {
    label: "Bulleted list",
    icon: "•",
    active: (editor) => editor.isActive("bulletList"),
    run: (editor) => editor.chain().focus().clearNodes().toggleBulletList().run(),
  },
  {
    label: "Numbered list",
    icon: "1.",
    active: (editor) => editor.isActive("orderedList"),
    run: (editor) => editor.chain().focus().clearNodes().toggleOrderedList().run(),
  },
  {
    label: "To-do list",
    icon: "☐",
    active: (editor) => editor.isActive("taskList"),
    run: (editor) => editor.chain().focus().clearNodes().toggleTaskList().run(),
  },
  {
    label: "Quote",
    icon: "❝",
    active: (editor) => editor.isActive("blockquote"),
    run: (editor) => editor.chain().focus().clearNodes().toggleBlockquote().run(),
  },
]

function mapPositionThroughReplacement(position: number, before: Editor["state"]["doc"], after: Editor["state"]["doc"]) {
  const start = before.content.findDiffStart(after.content)
  if (start === null || position <= start) return position
  const end = before.content.findDiffEnd(after.content)
  if (!end) return position
  if (position >= end.a) return position + end.b - end.a
  return Math.min(end.b, start + position - start)
}

export function RichMode(props: {
  detection: RichMarkdown
  onInput: (markdown: string) => void
  onBlur: () => void
  onSerializationError: (error: Error) => void
}) {
  let element!: HTMLDivElement
  let editor: Editor | undefined
  let toolbarTimer: ReturnType<typeof setTimeout> | undefined
  const [toolbar, setToolbar] = createSignal<{ x: number; y: number }>()
  const [linkOpen, setLinkOpen] = createSignal(false)
  const [linkValue, setLinkValue] = createSignal("")
  const [blocksOpen, setBlocksOpen] = createSignal(false)
  const [tableOpen, setTableOpen] = createSignal(false)
  const [toc, setToc] = createSignal<TocMark[]>([])
  const [activeToc, setActiveToc] = createSignal(-1)
  const [empty, setEmpty] = createSignal(false)
  const [tick, setTick] = createSignal(0)

  const closeToolbarMenus = () => {
    setLinkOpen(false)
    setBlocksOpen(false)
    setTableOpen(false)
  }

  const rebuildToc = () => {
    if (!editor) return
    const list: TocMark[] = []
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name !== "heading") return true
      const title = node.textContent.trim()
      if (!title) return true
      list.push({
        order: list.length,
        pos,
        title,
        level: typeof node.attrs.level === "number" ? node.attrs.level : 1,
      })
      return true
    })
    setToc((current) =>
      current.length === list.length &&
      current.every(
        (mark, index) =>
          mark.pos === list[index]?.pos && mark.title === list[index]?.title && mark.level === list[index]?.level,
      )
        ? current
        : list,
    )
    setEmpty(editor.isEmpty)
  }

  const computeToolbar = () => {
    if (!editor) return
    const selection = editor.state.selection
    if (!(selection instanceof TextSelection) || selection.empty) {
      setToolbar()
      closeToolbarMenus()
      return
    }
    const selected = editor.state.doc.textBetween(selection.from, selection.to, "\n", "\n").trim()
    if (!selected) {
      setToolbar()
      closeToolbarMenus()
      return
    }
    const points = (() => {
      try {
        return {
          start: editor!.view.coordsAtPos(selection.from),
          end: editor!.view.coordsAtPos(selection.to),
        }
      } catch {
        // DOM implementations without layout (the component-test runtime)
        // still exercise selection behavior; the real browser supplies the
        // coordinates used for final placement.
        return { start: { left: 10, top: 58, bottom: 74 }, end: { left: 10, top: 58, bottom: 74 } }
      }
    })()
    const start = points.start
    const end = points.end
    const shell = element.closest(".notion-page-shell")?.getBoundingClientRect()
    const left = shell?.left ?? 10
    const right = shell?.right ?? window.innerWidth - 10
    const x = Math.max(left, Math.min(start.left, right - 520))
    const above = Math.min(start.top, end.top) - 48
    const y = above < 12 ? Math.max(start.bottom, end.bottom) + 8 : above
    setToolbar({ x, y })
  }

  const scheduleToolbar = () => {
    if (toolbarTimer) clearTimeout(toolbarTimer)
    toolbarTimer = setTimeout(computeToolbar, 30)
  }

  const initial = props.detection
  let appliedBody = initial.envelope.body
  const serialize = () => {
    if (!editor) return
    try {
      const serialized = editor.getMarkdown()
      const envelope = props.detection.envelope
      const body = normalizeSerializedMarkdownBody(envelope, serialized)
      appliedBody = body
      props.onInput(joinMarkdownEnvelope(envelope, body))
    } catch (error) {
      props.onSerializationError(error instanceof Error ? error : new Error(String(error)))
    }
  }

  const editorAccessor = createTiptapEditor(() => ({
    element,
    editable: true,
    extensions: documentRichEditorExtensions(),
    content: initial.envelope.body,
    contentType: "markdown",
    editorProps: {
      attributes: {
        class: "tiptap",
        role: "textbox",
        "aria-label": "Document rich editor",
        spellcheck: "true",
      },
      handleKeyDown: (view, event) => {
        const modifier = event.metaKey || event.ctrlKey
        if (!modifier || event.altKey || event.shiftKey || event.key.toLowerCase() !== "a") return false
        const max = view.state.doc.content.size
        if (max < 1) return false
        const selection = view.state.selection
        const blocks: Array<{ pos: number; size: number }> = []
        view.state.doc.forEach((node, pos) => blocks.push({ pos, size: node.nodeSize }))
        const active = blocks.find((block) => selection.from >= block.pos && selection.from < block.pos + block.size)
        if (!active) return false
        const from = Math.max(1, Math.min(active.pos + 1, max))
        const to = Math.max(from, Math.min(active.pos + active.size - 1, max))
        const blockSelected = selection.from <= from && selection.to >= to
        event.preventDefault()
        view.dispatch(
          view.state.tr
            .setSelection(TextSelection.create(view.state.doc, blockSelected ? 1 : from, blockSelected ? max : to))
            .scrollIntoView(),
        )
        return true
      },
    },
    onCreate: () => rebuildToc(),
    onUpdate: () => {
      serialize()
      rebuildToc()
      scheduleToolbar()
      setTick((value) => value + 1)
    },
    onSelectionUpdate: () => {
      scheduleToolbar()
      setTick((value) => value + 1)
    },
    onBlur: () => props.onBlur(),
  }))

  createComputed(() => {
    editor = editorAccessor()
    if (!editor) return
    rebuildToc()
  })

  createComputed(() => {
    const current = editorAccessor()
    const body = props.detection.envelope.body
    if (!current || body === appliedBody) return
    closeToolbarMenus()
    const focused = current.isFocused
    const selection = current.state.selection
    const document = current.state.doc
    try {
      current.commands.setContent(body, { contentType: "markdown", emitUpdate: false })
      appliedBody = body
    } catch (error) {
      props.onSerializationError(error instanceof Error ? error : new Error(String(error)))
      return
    }
    if (focused) {
      const max = current.state.doc.content.size
      current.commands.setTextSelection({
        from: Math.max(1, Math.min(mapPositionThroughReplacement(selection.from, document, current.state.doc), max)),
        to: Math.max(1, Math.min(mapPositionThroughReplacement(selection.to, document, current.state.doc), max)),
      })
      current.commands.focus()
    }
    rebuildToc()
    scheduleToolbar()
  })

  onCleanup(() => {
    if (toolbarTimer) clearTimeout(toolbarTimer)
    editor = undefined
  })

  const applyLink = () => {
    if (!editor) return
    const href = linkValue().trim()
    if (!href) editor.chain().focus().extendMarkRange("link").unsetLink().run()
    if (href) {
      editor
        .chain()
        .focus()
        .extendMarkRange("link")
        .setLink({ href: /^[a-z][a-z\d+\-.]*:|^mailto:|^tel:/i.test(href) ? href : `https://${href}` })
        .run()
    }
    setLinkOpen(false)
  }

  const runTable = (
    command:
      | "addRowBefore"
      | "addRowAfter"
      | "deleteRow"
      | "addColumnBefore"
      | "addColumnAfter"
      | "deleteColumn"
      | "deleteTable",
  ) => {
    if (!editor) return
    const chain = editor.chain().focus()
    if (command === "addRowBefore") chain.addRowBefore().run()
    if (command === "addRowAfter") chain.addRowAfter().run()
    if (command === "deleteRow") chain.deleteRow().run()
    if (command === "addColumnBefore") chain.addColumnBefore().run()
    if (command === "addColumnAfter") chain.addColumnAfter().run()
    if (command === "deleteColumn") chain.deleteColumn().run()
    if (command === "deleteTable") chain.deleteTable().run()
    setTableOpen(false)
  }

  const jumpToc = (mark: TocMark) => {
    if (!editor) return
    const max = editor.state.doc.content.size
    const pos = Math.max(1, Math.min(mark.pos + 1, max))
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos)).scrollIntoView())
    editor.view.focus()
    setActiveToc(mark.order)
  }

  return (
    <section aria-label="Rich Markdown editor">
      <Show when={toc().length > 1}>
        <div class="notion-toc-wrap">
          <div class="notion-toc-menu">
            <div class="notion-toc-menu-title">Table of contents</div>
            <For each={toc().slice(0, 40)}>
              {(mark) => (
                <button
                  type="button"
                  class="notion-toc-menu-item"
                  classList={{ "notion-toc-menu-item-active": activeToc() === mark.order }}
                  style={{ "padding-left": `${10 + (mark.level - 1) * 12}px` }}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => jumpToc(mark)}
                >
                  {mark.title}
                </button>
              )}
            </For>
          </div>
          <div class="notion-toc-rail">
            <For each={toc().slice(0, 40)}>
              {(mark) => (
                <button
                  type="button"
                  class="notion-toc-mark"
                  classList={{ "notion-toc-mark-active": activeToc() === mark.order }}
                  style={{ width: `${Math.max(14, 26 - (mark.level - 1) * 4)}px` }}
                  title={mark.title}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => jumpToc(mark)}
                />
              )}
            </For>
          </div>
        </div>
      </Show>
      <Show when={empty()}>
        <div class="notion-body-placeholder">Press '/' for commands...</div>
      </Show>
      <div class="notion-editor" ref={element} onMouseUp={scheduleToolbar} />
      <div class="notion-bottom-space" />

      <Show when={toolbar()}>
        {(position) => (
          <div
            class="notion-floating-toolbar"
            role="toolbar"
            aria-label="Document formatting"
            style={{ left: `${position().x}px`, top: `${position().y}px` }}
            onMouseDown={(event) => event.preventDefault()}
          >
            <For each={toolbarActions}>
              {(action) => (
                <button
                  type="button"
                  class="notion-toolbar-btn"
                  classList={{ "notion-toolbar-btn-active": (tick(), editor ? action.active(editor) : false) }}
                  title={action.label}
                  aria-label={action.label}
                  style={action.style}
                  onClick={() => editor && action.run(editor)}
                >
                  {action.icon}
                </button>
              )}
            </For>
            <div class="notion-link-wrap">
              <button
                type="button"
                class="notion-toolbar-btn"
                classList={{ "notion-toolbar-btn-active": linkOpen() || Boolean(editor?.isActive("link")) }}
                aria-label="Link"
                title="Link"
                onClick={() => {
                  setLinkValue(String(editor?.getAttributes("link").href ?? ""))
                  setLinkOpen((open) => !open)
                  setBlocksOpen(false)
                  setTableOpen(false)
                }}
              >
                🔗
              </button>
              <Show when={linkOpen()}>
                <div class="notion-link-popover">
                  <div class="notion-link-title">Insert link</div>
                  <input
                    class="notion-link-input"
                    aria-label="Link URL"
                    value={linkValue()}
                    placeholder="Paste URL..."
                    onInput={(event) => setLinkValue(event.currentTarget.value)}
                    onMouseDown={(event) => event.stopPropagation()}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") applyLink()
                      if (event.key === "Escape") setLinkOpen(false)
                    }}
                  />
                  <div class="notion-link-actions">
                    <button type="button" class="notion-link-btn notion-link-btn-primary" onClick={applyLink}>
                      Apply
                    </button>
                    <button
                      type="button"
                      class="notion-link-btn"
                      onClick={() => {
                        setLinkValue("")
                        applyLink()
                      }}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              </Show>
            </div>
            <div class="notion-toolbar-more-wrap">
              <button
                type="button"
                class="notion-toolbar-btn"
                aria-label="Turn into"
                title="Turn into"
                onClick={() => {
                  setBlocksOpen((open) => !open)
                  setLinkOpen(false)
                  setTableOpen(false)
                }}
              >
                Turn into ▾
              </button>
              <Show when={blocksOpen()}>
                <div class="notion-convert-menu notion-convert-menu-below">
                  <For each={blockActions}>
                    {(action) => (
                      <button
                        type="button"
                        class="notion-convert-menu-item"
                        classList={{ "notion-convert-menu-item-active": editor ? action.active(editor) : false }}
                        onClick={() => {
                          if (editor) action.run(editor)
                          setBlocksOpen(false)
                        }}
                      >
                        <span>{action.icon}</span>
                        <span>{action.label}</span>
                      </button>
                    )}
                  </For>
                </div>
              </Show>
            </div>
            <Show when={(tick(), editor?.isActive("table"))}>
              <div class="notion-toolbar-table-wrap">
                <button
                  type="button"
                  class="notion-toolbar-btn"
                  aria-label="Table tools"
                  onClick={() => {
                    setTableOpen((open) => !open)
                    setBlocksOpen(false)
                    setLinkOpen(false)
                  }}
                >
                  Table ▾
                </button>
                <Show when={tableOpen()}>
                  <div class="notion-table-menu notion-table-menu-below">
                    <For
                      each={[
                        ["addRowBefore", "Add row above"],
                        ["addRowAfter", "Add row below"],
                        ["deleteRow", "Delete row"],
                        ["addColumnBefore", "Add column left"],
                        ["addColumnAfter", "Add column right"],
                        ["deleteColumn", "Delete column"],
                        ["deleteTable", "Delete table"],
                      ] as const}
                    >
                      {(item) => (
                        <button type="button" class="notion-table-menu-item" onClick={() => runTable(item[0])}>
                          {item[1]}
                        </button>
                      )}
                    </For>
                  </div>
                </Show>
              </div>
            </Show>
          </div>
        )}
      </Show>

    </section>
  )
}
