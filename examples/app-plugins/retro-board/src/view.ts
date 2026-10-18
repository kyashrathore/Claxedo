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
type ButtonOptions = { variant?: "primary" | "default" | "borderless"; icon?: Extract<SurfaceComponent, { component: "Button" }>["icon"] }

export type Notice = { title: string; text: string }

const VOTE_CHOICES = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]
const MINUTE_CHOICES = ["1", "3", "5", "10", "15", "20", "30"]

function text(id: string, value: string | Binding, variant?: "caption" | "body"): SurfaceComponent {
  return variant ? { id, component: "Text", text: value, variant } : { id, component: "Text", text: value }
}

function button(id: string, label: string | Binding, name: string, context?: Context, options: ButtonOptions = {}): SurfaceComponent[] {
  return [{ id, component: "Button", child: `${id}-label`, action: { event: context ? { name, context } : { name } }, ...options }, text(`${id}-label`, label)]
}

function stat(id: string, label: string, key: string): SurfaceComponent {
  return { id, component: "Stat", label, value: { path: `/summary/${key}/value` }, caption: { path: `/summary/${key}/caption` } }
}

const BOARD_CONTEXT: Context = { view: { path: "/columns" }, settings: { path: "/settings" } }

const NOTE_TEMPLATE: Record<ColumnId, string> = { well: "note-well", improve: "note-improve", actions: "note-action" }

export function rootComponent(notice: boolean): SurfaceComponent {
  return { id: "root", component: "Column", children: ["header", "kpis", ...(notice ? ["board-notice"] : []), "board", "facilitation", "wrap-up"] }
}

export function noticeMessages(surfaceId: string, notice: Notice | null, wasShown: boolean): SurfaceMessage[] {
  if (!notice) return wasShown ? [components(surfaceId, [rootComponent(false)])] : []
  const callout: SurfaceComponent = { id: "board-notice", component: "Callout", tone: "warning", title: { path: "/notice/title" }, text: { path: "/notice/text" }, dismissible: true }
  return [patch(surfaceId, "/notice", notice), ...(wasShown ? [] : [components(surfaceId, [rootComponent(true), callout])])]
}

export function columnBody(column: ColumnId, hasNotes: boolean): SurfaceComponent {
  return hasNotes
    ? { id: `col-${column}-body`, component: "List", children: { componentId: NOTE_TEMPLATE[column], path: `/columns/${column}` } }
    : {
        id: `col-${column}-body`,
        component: "EmptyState",
        title: `Nothing in ${COLUMN_TITLES[column]} yet`,
        description: column === "actions" ? "Turn a to-improve note into an action with an owner and a due date." : "Write the first note below.",
      }
}

export function exportBody(exported: boolean): SurfaceComponent {
  return exported
    ? {
        id: "export-body",
        component: "Tabs",
        tabs: [
          { title: "Preview", child: "export-markdown" },
          { title: "Markdown", child: "export-code" },
        ],
      }
    : { id: "export-body", component: "EmptyState", title: "Nothing exported yet", description: "Export the board to get Markdown you can paste into your notes." }
}

export function followUpStatus(busy: boolean): SurfaceComponent {
  return busy ? { id: "follow-up-status", component: "Spinner", label: "Starting the follow-up session…" } : text("follow-up-status", { path: "/export/status" }, "caption")
}

export function columnSection(column: ColumnId, selecting: boolean): SurfaceComponent {
  return {
    id: `col-${column}`,
    component: "Section",
    title: COLUMN_TITLES[column],
    description: { path: `/counts/${column}` },
    ...(selecting ? { actions: [`col-${column}-merge`] } : {}),
    child: `col-${column}-column`,
  }
}

function columnComponents(column: ColumnId, board: Board): SurfaceComponent[] {
  const title = COLUMN_TITLES[column]
  return [
    columnSection(column, board.notes.some((item) => item.column === column && item.selected)),
    ...(column === "actions" ? [] : button(`col-${column}-merge`, "Merge selected", "merge", BOARD_CONTEXT)),
    { id: `col-${column}-column`, component: "Column", children: [`col-${column}-body`, `col-${column}-draft`, `col-${column}-footer`] },
    columnBody(column, board.notes.some((item) => item.column === column)),
    { id: `col-${column}-draft`, component: "TextField", label: `New ${title} note`, variant: "longText", value: { path: `/drafts/${column}` } },
    { id: `col-${column}-footer`, component: "Footer", end: [`col-${column}-add`] },
    ...button(`col-${column}-add`, `Add to ${title}`, "addNote", { column, text: { path: `/drafts/${column}` }, ...BOARD_CONTEXT }, { icon: "add" }),
  ]
}

function picker(id: string, label: string, path: string, choices: readonly string[], unit: string): SurfaceComponent {
  return {
    id,
    component: "ChoicePicker",
    label,
    variant: "mutuallyExclusive",
    displayStyle: "dropdown",
    options: choices.map((choice) => ({ label: `${choice} ${unit}${choice === "1" ? "" : "s"}`, value: choice })),
    value: { path },
  }
}

export function retroComponents(board: Board): SurfaceComponent[] {
  return [
    rootComponent(false),
    { id: "header", component: "Header", title: "Retro board", subtitle: { path: "/summary/subtitle" }, icon: "calendarToday", badges: ["header-votes"] },
    { id: "header-votes", component: "Badge", text: { path: "/votes/remaining" }, variant: { path: "/votes/tone" } },

    { id: "kpis", component: "Grid", columns: 4, children: ["kpi-notes", "kpi-votes", "kpi-actions", "kpi-timer"] },
    stat("kpi-notes", "Notes", "notes"),
    stat("kpi-votes", "Votes cast", "votes"),
    stat("kpi-actions", "Actions", "actions"),
    { id: "kpi-timer", component: "Stat", label: "Timebox", value: { path: "/timer/clock" }, caption: { path: "/timer/label" } },

    { id: "board", component: "Grid", columns: 3, children: COLUMN_IDS.map((column) => `col-${column}`) },
    ...COLUMN_IDS.flatMap((column) => columnComponents(column, board)),

    { id: "note-well", component: "ListItem", title: { path: "text" }, subtitle: { path: "meta" }, selected: { path: "selected" }, meta: ["note-votes"], primaryAction: "note-vote", actions: ["note-select"] },
    { id: "note-improve", component: "Column", children: ["note-well", "note-convert"] },
    { id: "note-votes", component: "Badge", text: { path: "votesLabel" }, variant: { path: "votesTone" } },
    ...button("note-select", { path: "selectLabel" }, "toggleSelect", { id: { path: "id" }, ...BOARD_CONTEXT }, { icon: "check" }),
    ...button("note-vote", "Vote", "vote", { id: { path: "id" }, ...BOARD_CONTEXT }),
    { id: "note-convert", component: "Collapsible", title: { path: "convertTitle" }, child: "note-convert-form" },
    { id: "note-convert-form", component: "Column", children: ["note-convert-fields", "note-convert-footer"] },
    { id: "note-convert-fields", component: "Grid", columns: 2, children: ["note-owner", "note-due"] },
    { id: "note-owner", component: "TextField", label: "Owner", value: { path: "ownerDraft" } },
    { id: "note-due", component: "DateTimeInput", label: "Due date", enableDate: true, enableTime: false, value: { path: "dueDraft" } },
    { id: "note-convert-footer", component: "Footer", end: ["note-make-action"] },
    ...button("note-make-action", "Make action", "convert", { id: { path: "id" }, owner: { path: "ownerDraft" }, due: { path: "dueDraft" }, ...BOARD_CONTEXT }, { icon: "check" }),
    { id: "note-action", component: "ListItem", title: { path: "text" }, subtitle: { path: "meta" }, icon: "check", actions: ["note-remove"] },
    ...button("note-remove", "Remove action", "remove", { id: { path: "id" }, text: { path: "text" }, ...BOARD_CONTEXT }, { icon: "delete" }),

    { id: "facilitation", component: "Section", title: "Timebox and voting", description: "Changes apply when you press a button here.", child: "facilitation-body" },
    { id: "facilitation-body", component: "Column", children: ["timer-progress", "settings-fields", "facilitation-footer"] },
    { id: "timer-progress", component: "Progress", value: { path: "/timer/percent" }, max: 100, label: { path: "/timer/label" } },
    { id: "settings-fields", component: "Grid", columns: 3, children: ["timer-minutes", "max-votes", "sort-votes"] },
    picker("timer-minutes", "Timebox length", "/settings/timerMinutes", MINUTE_CHOICES, "minute"),
    picker("max-votes", "Votes per person", "/settings/maxVotes", VOTE_CHOICES, "vote"),
    { id: "sort-votes", component: "Switch", label: "Sort notes by votes", value: { path: "/settings/sortByVotes" } },
    { id: "facilitation-footer", component: "Footer", start: ["apply-settings"], end: ["timer-stop", "timer-start"] },
    ...button("apply-settings", "Apply board settings", "applySettings", BOARD_CONTEXT, { variant: "borderless" }),
    ...button("timer-stop", "Stop timer", "stopTimer", BOARD_CONTEXT, { icon: "stop" }),
    ...button("timer-start", "Start timer", "startTimer", BOARD_CONTEXT, { icon: "play" }),

    { id: "wrap-up", component: "Section", title: "Wrap up", description: "Export the board, or hand the actions to an agent session.", actions: ["export", "follow-up"], child: "wrap-up-body" },
    ...button("export", "Export as Markdown", "export", BOARD_CONTEXT, { icon: "download" }),
    ...button("follow-up", "Create follow-up session", "followUp", BOARD_CONTEXT, { variant: "primary", icon: "send" }),
    { id: "wrap-up-body", component: "Column", children: ["follow-up-status", "export-body"] },
    followUpStatus(false),
    exportBody(false),
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

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`
}

export function columnsData(board: Board) {
  return Object.fromEntries(
    COLUMN_IDS.map((column) => [
      column,
      columnNotes(board, column).map((item) => ({
        id: item.id,
        text: item.text,
        meta: noteMeta(item),
        votesLabel: count(item.votes, "vote"),
        votesTone: item.votes > 0 ? "accent" : "neutral",
        selected: item.selected,
        selectLabel: `${item.selected ? "Deselect" : "Select"} “${shortText(item.text)}” to merge`,
        convertTitle: item.convertedTo ? "Action created" : "Convert to action",
        ownerDraft: item.ownerDraft,
        dueDraft: item.dueDraft,
      })),
    ]),
  )
}

export function countsData(board: Board) {
  return Object.fromEntries(COLUMN_IDS.map((column) => [column, count(board.notes.filter((item) => item.column === column).length, "note")]))
}

export function votesData(board: Board) {
  const left = remainingVotes(board)
  return { remaining: `${left} of ${board.maxVotes} votes left`, tone: left === 0 ? "warning" : "accent" }
}

export function summaryData(board: Board) {
  const inColumn = (column: ColumnId) => board.notes.filter((item) => item.column === column)
  const discussed = [...inColumn("well"), ...inColumn("improve")]
  const top = [...discussed].sort((a, b) => b.votes - a.votes)[0]
  const actions = inColumn("actions")
  return {
    subtitle: `${count(discussed.length, "note")} · ${count(actions.length, "action")} · ${board.sortByVotes ? "sorted by votes" : "in the order added"}`,
    notes: { value: String(discussed.length), caption: `${inColumn("well").length} went well · ${inColumn("improve").length} to improve` },
    votes: { value: String(board.votesUsed), caption: top && top.votes > 0 ? `Top: ${shortText(top.text)}` : "No votes yet" },
    actions: { value: String(actions.length), caption: actions.length === 0 ? "Convert a to-improve note" : `Next due ${[...actions].map((item) => item.due).sort()[0]}` },
  }
}

export function timerData(board: Board, now: number) {
  const remaining = timerRemaining(board.timer, now)
  return {
    clock: formatClock(remaining),
    percent: timerPercent(board.timer, now),
    label: board.timer.endsAt === null ? `${board.timer.durationSeconds / 60} minute timebox, not running` : remaining === 0 ? "Time is up" : "Timebox running",
  }
}

export function settingsData(board: Board) {
  return { maxVotes: [String(board.maxVotes)], sortByVotes: board.sortByVotes, timerMinutes: [String(board.timer.durationSeconds / 60)] }
}

export function boardMessages(surfaceId: string, board: Board): SurfaceMessage[] {
  return [
    patch(surfaceId, "/columns", columnsData(board)),
    patch(surfaceId, "/counts", countsData(board)),
    patch(surfaceId, "/votes", votesData(board)),
    patch(surfaceId, "/summary", summaryData(board)),
  ]
}

export function retroModel(board: Board, now: number) {
  return {
    settings: settingsData(board),
    votes: votesData(board),
    summary: summaryData(board),
    columns: columnsData(board),
    counts: countsData(board),
    drafts: { well: "", improve: "", actions: "" },
    timer: timerData(board, now),
    export: { markdown: "", status: "No follow-up session yet. It needs at least one action." },
    notice: { title: "", text: "" },
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
