import type { SurfaceComponent, SurfaceMessage } from "@claxedo/plugin-api"
import {
  COLUMN_IDS,
  COLUMN_TITLES,
  columnNotes,
  formatClock,
  remainingVotes,
  timerPercent,
  timerRemaining,
  type Board,
  type ColumnId,
  type Note,
} from "./model"

export const CATALOG_ID = "https://claxedo.dev/a2ui/v0.9/catalog.json"
const VERSION = "v0.9"

type Binding = { path: string }
type Context = Record<string, Binding | string>
type DataValue = Extract<SurfaceMessage, { updateDataModel: unknown }>["updateDataModel"]["value"]

function text(id: string, value: string | Binding, variant?: "h1" | "h2" | "h3" | "h4" | "h5" | "caption" | "body"): SurfaceComponent {
  return variant ? { id, component: "Text", text: value, variant } : { id, component: "Text", text: value }
}

function button(id: string, label: string, name: string, context?: Context, variant?: "primary" | "default" | "borderless"): SurfaceComponent[] {
  return [
    { id, component: "Button", child: `${id}-label`, action: { event: context ? { name, context } : { name } }, ...(variant ? { variant } : {}) },
    text(`${id}-label`, label),
  ]
}

const BOARD_CONTEXT: Context = { view: { path: "/columns" }, settings: { path: "/settings" } }

const NOTE_TEMPLATE: Record<ColumnId, string> = { well: "note-well", improve: "note-improve", actions: "note-action" }

export function columnBody(column: ColumnId, hasNotes: boolean): SurfaceComponent {
  return hasNotes
    ? { id: `col-${column}-body`, component: "List", children: { componentId: NOTE_TEMPLATE[column], path: `/columns/${column}` } }
    : {
        id: `col-${column}-body`,
        component: "EmptyState",
        title: `Nothing in ${COLUMN_TITLES[column]} yet`,
        description: column === "actions" ? "Turn a to-improve note into an action with an owner and a due date." : "Add the first note above.",
      }
}

export function followUpStatus(busy: boolean): SurfaceComponent {
  return busy
    ? { id: "follow-up-status", component: "Spinner", label: "Starting the follow-up session" }
    : { ...text("follow-up-status", { path: "/export/status" }, "caption"), weight: 1 }
}

function columnComponents(column: ColumnId, board: Board): SurfaceComponent[] {
  const title = COLUMN_TITLES[column]
  return [
    { id: `col-${column}`, component: "Card", child: `col-${column}-column`, weight: 1 },
    { id: `col-${column}-column`, component: "Column", children: [`col-${column}-head`, `col-${column}-draft`, `col-${column}-add`, `col-${column}-body`] },
    { id: `col-${column}-head`, component: "Row", align: "center", children: [`col-${column}-title`, `col-${column}-count`] },
    { ...text(`col-${column}-title`, title, "h3"), weight: 1 },
    { id: `col-${column}-count`, component: "Badge", text: { path: `/counts/${column}` } },
    { id: `col-${column}-draft`, component: "TextField", label: `New ${title} note`, variant: "longText", value: { path: `/drafts/${column}` } },
    ...button(`col-${column}-add`, `Add to ${title}`, "addNote", { column, text: { path: `/drafts/${column}` }, ...BOARD_CONTEXT }),
    columnBody(column, board.notes.some((item) => item.column === column)),
  ]
}

export function retroComponents(board: Board): SurfaceComponent[] {
  return [
    { id: "root", component: "Column", children: ["header", "toolbar", "board", "timer-card", "export-card"] },
    { id: "header", component: "Row", align: "center", children: ["header-icon", "header-title", "header-votes"] },
    { id: "header-icon", component: "Icon", name: "favorite" },
    { ...text("header-title", "Retro board", "h2"), weight: 1 },
    { id: "header-votes", component: "Badge", text: { path: "/votes/remaining" }, variant: "accent" },

    { id: "toolbar", component: "Card", child: "toolbar-row" },
    { id: "toolbar-row", component: "Row", align: "end", children: ["max-votes", "sort-votes", "apply-settings", "merge"] },
    { id: "max-votes", component: "Slider", label: "Max votes per person", min: 1, max: 10, value: { path: "/settings/maxVotes" }, weight: 1 },
    { id: "sort-votes", component: "Switch", label: "Sort by votes", value: { path: "/settings/sortByVotes" } },
    ...button("apply-settings", "Apply board settings", "applySettings", BOARD_CONTEXT),
    ...button("merge", "Merge selected", "merge", BOARD_CONTEXT),

    { id: "board", component: "Row", align: "start", children: COLUMN_IDS.map((column) => `col-${column}`) },
    ...COLUMN_IDS.flatMap((column) => columnComponents(column, board)),

    { id: "note-well", component: "Card", child: "note-well-body" },
    { id: "note-well-body", component: "Column", children: ["note-text", "note-meta", "note-vote-row"] },
    { id: "note-improve", component: "Card", child: "note-improve-body" },
    { id: "note-improve-body", component: "Column", children: ["note-text", "note-meta", "note-vote-row", "note-convert"] },
    text("note-text", { path: "text" }, "body"),
    text("note-meta", { path: "meta" }, "caption"),
    { id: "note-vote-row", component: "Row", align: "center", children: ["note-votes", "note-vote", "note-select"] },
    { id: "note-votes", component: "Badge", text: { path: "votesLabel" } },
    ...button("note-vote", "+1", "vote", { id: { path: "id" }, ...BOARD_CONTEXT }, "borderless"),
    { id: "note-select", component: "CheckBox", label: { path: "selectLabel" }, value: { path: "selected" } },
    { id: "note-convert", component: "Collapsible", title: { path: "convertTitle" }, child: "note-convert-form" },
    { id: "note-convert-form", component: "Column", children: ["note-owner", "note-due", "note-make-action"] },
    { id: "note-owner", component: "TextField", label: "Owner", value: { path: "ownerDraft" } },
    { id: "note-due", component: "DateTimeInput", label: "Due date", enableDate: true, enableTime: false, value: { path: "dueDraft" } },
    ...button("note-make-action", "Make action", "convert", { id: { path: "id" }, owner: { path: "ownerDraft" }, due: { path: "dueDraft" }, ...BOARD_CONTEXT }, "primary"),
    { id: "note-action", component: "Card", child: "note-action-body" },
    { id: "note-action-body", component: "Column", children: ["note-action-head", "note-meta"] },
    { id: "note-action-head", component: "Row", align: "center", children: ["note-action-icon", "note-action-text", "note-remove"] },
    { id: "note-action-icon", component: "Icon", name: "check" },
    { ...text("note-action-text", { path: "text" }, "body"), weight: 1 },
    ...button("note-remove", "Remove", "remove", { id: { path: "id" }, text: { path: "text" }, ...BOARD_CONTEXT }, "borderless"),

    { id: "timer-card", component: "Card", child: "timer-column" },
    { id: "timer-column", component: "Column", children: ["timer-head", "timer-progress", "timer-controls"] },
    { id: "timer-head", component: "Row", align: "center", children: ["timer-title", "timer-clock"] },
    { ...text("timer-title", "Timebox", "h3"), weight: 1 },
    text("timer-clock", { path: "/timer/clock" }, "h2"),
    { id: "timer-progress", component: "Progress", value: { path: "/timer/percent" }, max: 100, label: { path: "/timer/label" } },
    { id: "timer-controls", component: "Row", align: "end", children: ["timer-minutes", "timer-start", "timer-stop"] },
    { id: "timer-minutes", component: "Slider", label: "Timer minutes", min: 1, max: 30, value: { path: "/settings/timerMinutes" }, weight: 1 },
    ...button("timer-start", "Start timer", "startTimer", BOARD_CONTEXT, "primary"),
    ...button("timer-stop", "Stop timer", "stopTimer", BOARD_CONTEXT),

    { id: "export-card", component: "Card", child: "export-column" },
    { id: "export-column", component: "Column", children: ["export-actions", "export-views"] },
    { id: "export-actions", component: "Row", align: "center", children: ["export", "follow-up", "follow-up-status"] },
    ...button("export", "Export as Markdown", "export", BOARD_CONTEXT),
    ...button("follow-up", "Create follow-up session", "followUp", BOARD_CONTEXT, "primary"),
    followUpStatus(false),
    {
      id: "export-views",
      component: "Tabs",
      tabs: [
        { title: "Preview", child: "export-markdown" },
        { title: "Markdown", child: "export-code" },
      ],
    },
    { id: "export-markdown", component: "Markdown", text: { path: "/export/markdown" } },
    { id: "export-code", component: "Code", language: "markdown", text: { path: "/export/markdown" } },
  ]
}

function noteMeta(item: Note): string {
  if (item.column === "actions") return `Owner ${item.owner} · due ${item.due}`
  const parts = [item.mergedCount > 1 ? `Merged from ${item.mergedCount} notes` : "", item.convertedTo ? "Has an action" : ""].filter(Boolean)
  return parts.join(" · ")
}

function shortText(value: string): string {
  return value.length > 32 ? `${value.slice(0, 31)}…` : value
}

export function columnsData(board: Board) {
  return Object.fromEntries(
    COLUMN_IDS.map((column) => [
      column,
      columnNotes(board, column).map((item) => ({
        id: item.id,
        text: item.text,
        meta: noteMeta(item),
        votesLabel: `${item.votes} vote${item.votes === 1 ? "" : "s"}`,
        selected: item.selected,
        selectLabel: `Select "${shortText(item.text)}"`,
        convertTitle: item.convertedTo ? "Action created" : "Convert to action",
        ownerDraft: item.ownerDraft,
        dueDraft: item.dueDraft,
      })),
    ]),
  )
}

export function countsData(board: Board) {
  return Object.fromEntries(
    COLUMN_IDS.map((column) => {
      const count = board.notes.filter((item) => item.column === column).length
      return [column, `${count} ${count === 1 ? "note" : "notes"}`]
    }),
  )
}

export function votesData(board: Board) {
  const left = remainingVotes(board)
  return { remaining: `${left} of ${board.maxVotes} votes left` }
}

export function timerData(board: Board, now: number) {
  const remaining = timerRemaining(board.timer, now)
  return {
    clock: formatClock(remaining),
    percent: timerPercent(board.timer, now),
    label: board.timer.endsAt === null ? `Timebox of ${board.timer.durationSeconds / 60} minutes, not running` : remaining === 0 ? "Time is up" : "Timebox running",
  }
}

export function boardMessages(surfaceId: string, board: Board): SurfaceMessage[] {
  return [patch(surfaceId, "/columns", columnsData(board)), patch(surfaceId, "/counts", countsData(board)), patch(surfaceId, "/votes", votesData(board))]
}

export function retroModel(board: Board, now: number) {
  return {
    settings: { maxVotes: board.maxVotes, sortByVotes: board.sortByVotes, timerMinutes: board.timer.durationSeconds / 60 },
    votes: votesData(board),
    columns: columnsData(board),
    counts: countsData(board),
    drafts: { well: "", improve: "", actions: "" },
    timer: timerData(board, now),
    export: { markdown: "_Export the retro to see it here._", status: "No follow-up session yet" },
  }
}

export function patch(surfaceId: string, path: string, value: DataValue): SurfaceMessage {
  return { version: VERSION, updateDataModel: { surfaceId, path, value } }
}

export function components(surfaceId: string, list: SurfaceComponent[]): SurfaceMessage {
  return { version: VERSION, updateComponents: { surfaceId, components: list } }
}

export function openMessages(surfaceId: string, board: Board, now: number): SurfaceMessage[] {
  return [
    { version: VERSION, createSurface: { surfaceId, catalogId: CATALOG_ID } },
    components(surfaceId, retroComponents(board)),
    patch(surfaceId, "/", retroModel(board, now)),
  ]
}
