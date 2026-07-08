/**
 * Tiptap lazy loader for the page editor.
 *
 * Dynamic-imports tiptap/solid-tiptap and returns the full dependency set
 * used by PageEditorLoaded. Extracted from page-editor.tsx (Plan 005).
 */

export type TiptapDeps = {
  createTiptapEditor: typeof import("solid-tiptap").createTiptapEditor
  useEditorJSON: typeof import("solid-tiptap").useEditorJSON
  StarterKit: typeof import("@tiptap/starter-kit").default
  Link: typeof import("@tiptap/extension-link").default
  Underline: typeof import("@tiptap/extension-underline").default
  Highlight: typeof import("@tiptap/extension-highlight").default
  TextStyle: typeof import("@tiptap/extension-text-style").TextStyle
  Color: typeof import("@tiptap/extension-color").default
  Image: typeof import("@tiptap/extension-image").default
  Table: typeof import("@tiptap/extension-table").Table
  TableRow: typeof import("@tiptap/extension-table-row").default
  TableHeader: typeof import("@tiptap/extension-table-header").default
  TableCell: typeof import("@tiptap/extension-table-cell").default
  TaskList: typeof import("@tiptap/extension-task-list").default
  TaskItem: typeof import("@tiptap/extension-task-item").default
  TextSelection: typeof import("@tiptap/pm/state").TextSelection
}

let tiptapp: Promise<TiptapDeps> | undefined

export const loadTiptap = () =>
  (tiptapp ??= Promise.all([
    import("solid-tiptap"),
    import("@tiptap/starter-kit"),
    import("@tiptap/extension-link"),
    import("@tiptap/extension-underline"),
    import("@tiptap/extension-highlight"),
    import("@tiptap/extension-text-style"),
    import("@tiptap/extension-color"),
    import("@tiptap/extension-image"),
    import("@tiptap/extension-table"),
    import("@tiptap/extension-table-row"),
    import("@tiptap/extension-table-header"),
    import("@tiptap/extension-table-cell"),
    import("@tiptap/extension-task-list"),
    import("@tiptap/extension-task-item"),
    import("@tiptap/pm/state"),
  ]).then(([solid, starter, link, underline, highlight, textStyle, color, image, table, tableRow, tableHeader, tableCell, taskList, taskItem, state]) => ({
    createTiptapEditor: solid.createTiptapEditor,
    useEditorJSON: solid.useEditorJSON,
    StarterKit: starter.default,
    Link: link.default,
    Underline: underline.default,
    Highlight: highlight.default,
    TextStyle: textStyle.TextStyle,
    Color: color.default,
    Image: image.default,
    Table: table.Table,
    TableRow: tableRow.default,
    TableHeader: tableHeader.default,
    TableCell: tableCell.default,
    TaskList: taskList.default,
    TaskItem: taskItem.default,
    TextSelection: state.TextSelection,
  })))
