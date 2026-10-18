export type ColumnId = "well" | "improve" | "actions"

export const COLUMN_IDS: readonly ColumnId[] = ["well", "improve", "actions"]
export const COLUMN_TITLES: Record<ColumnId, string> = { well: "Went well", improve: "To improve", actions: "Actions" }

export type Note = {
  id: string
  column: ColumnId
  text: string
  votes: number
  mergedCount: number
  owner: string
  due: string
  sourceId: string | null
  convertedTo: string | null
  selected: boolean
  ownerDraft: string
  dueDraft: string
}

export type RetroTimer = { durationSeconds: number; endsAt: number | null; remainingSeconds: number }

export type Board = {
  notes: Note[]
  maxVotes: number
  votesUsed: number
  sortByVotes: boolean
  timer: RetroTimer
  nextId: number
}

export type Change = { board: Board; error?: string }

const MAX_NOTE_LENGTH = 280
const VOTE_RANGE = [1, 10] as const

function note(id: string, column: ColumnId, text: string, extra: Partial<Note> = {}): Note {
  return { id, column, text, votes: 0, mergedCount: 1, owner: "", due: "", sourceId: null, convertedTo: null, selected: false, ownerDraft: "", dueDraft: "", ...extra }
}

export function isColumnId(value: unknown): value is ColumnId {
  return typeof value === "string" && (COLUMN_IDS as readonly string[]).includes(value)
}

export function createBoard(seed = true, timerMinutes = 5): Board {
  const notes = seed
    ? [
        note("note-1", "well", "Deploys were smooth all sprint"),
        note("note-2", "well", "Pairing on the parser rewrite"),
        note("note-3", "improve", "Flaky end-to-end tests slowed reviews"),
        note("note-4", "improve", "Standups run long"),
        note("note-5", "improve", "E2E suite fails randomly on CI"),
      ]
    : []
  return {
    notes,
    maxVotes: 3,
    votesUsed: 0,
    sortByVotes: false,
    timer: { durationSeconds: timerMinutes * 60, endsAt: null, remainingSeconds: timerMinutes * 60 },
    nextId: notes.length + 1,
  }
}

function updateNote(board: Board, id: string, change: (note: Note) => Note): Board {
  return { ...board, notes: board.notes.map((item) => (item.id === id ? change(item) : item)) }
}

export function findNote(board: Board, id: string): Note | undefined {
  return board.notes.find((item) => item.id === id)
}

export function remainingVotes(board: Board): number {
  return Math.max(0, board.maxVotes - board.votesUsed)
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function absorbView(board: Board, view: unknown): Board {
  if (!isRecord(view)) return board
  const fields = new Map<string, Record<string, unknown>>()
  for (const list of Object.values(view)) {
    if (!Array.isArray(list)) continue
    for (const item of list) {
      if (isRecord(item) && typeof item.id === "string") fields.set(item.id, item)
    }
  }
  return {
    ...board,
    notes: board.notes.map((item) => {
      const seen = fields.get(item.id)
      if (!seen) return item
      return {
        ...item,
        ownerDraft: typeof seen.ownerDraft === "string" ? seen.ownerDraft : item.ownerDraft,
        dueDraft: typeof seen.dueDraft === "string" ? seen.dueDraft : item.dueDraft,
      }
    }),
  }
}

function settingNumber(value: unknown): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value
  const parsed = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw
  return typeof parsed === "number" && Number.isFinite(parsed) ? Math.round(parsed) : undefined
}

export function applySettings(board: Board, raw: unknown): Board {
  const settings = isRecord(raw) ? raw : {}
  const max = settingNumber(settings.maxVotes) ?? board.maxVotes
  const pickedMinutes = settingNumber(settings.timerMinutes)
  const minutes = pickedMinutes === undefined ? board.timer.durationSeconds / 60 : Math.min(30, Math.max(1, pickedMinutes))
  const timer = board.timer.endsAt === null ? { durationSeconds: minutes * 60, endsAt: null, remainingSeconds: minutes * 60 } : board.timer
  return {
    ...board,
    maxVotes: Math.min(VOTE_RANGE[1], Math.max(VOTE_RANGE[0], max)),
    sortByVotes: typeof settings.sortByVotes === "boolean" ? settings.sortByVotes : board.sortByVotes,
    timer,
  }
}

export function addNote(board: Board, column: unknown, text: string): Change {
  if (!isColumnId(column)) return { board, error: "Unknown column." }
  const body = text.trim()
  if (!body) return { board, error: "Write the note first." }
  if (body.length > MAX_NOTE_LENGTH) return { board, error: `Keep notes under ${MAX_NOTE_LENGTH} characters.` }
  if (board.notes.some((item) => item.column === column && item.text.toLowerCase() === body.toLowerCase())) return { board, error: "That note is already in the column." }
  return { board: { ...board, notes: [...board.notes, note(`note-${board.nextId}`, column, body)], nextId: board.nextId + 1 } }
}

export function vote(board: Board, id: string): Change {
  const target = findNote(board, id)
  if (!target) return { board, error: "That note is gone." }
  if (target.column === "actions") return { board, error: "Actions are not voted on." }
  if (remainingVotes(board) === 0) return { board, error: `You have used all ${board.maxVotes} votes.` }
  return { board: { ...updateNote(board, id, (item) => ({ ...item, votes: item.votes + 1 })), votesUsed: board.votesUsed + 1 } }
}

export function toggleSelected(board: Board, id: string): Change {
  const target = findNote(board, id)
  if (!target) return { board, error: "That note is gone." }
  if (target.column === "actions") return { board, error: "Actions cannot be merged, so they are not selected." }
  return { board: updateNote(board, id, (item) => ({ ...item, selected: !item.selected })) }
}

export function mergeSelected(board: Board): Change {
  const selected = board.notes.filter((item) => item.selected)
  const [keep, drop] = selected
  if (selected.length !== 2 || !keep || !drop) return { board, error: `Select exactly two notes to merge (${selected.length} selected).` }
  if (keep.column !== drop.column) return { board, error: "Merge notes from the same column." }
  if (keep.column === "actions") return { board, error: "Actions cannot be merged." }
  const merged: Note = {
    ...keep,
    text: `${keep.text} / ${drop.text}`,
    votes: keep.votes + drop.votes,
    mergedCount: keep.mergedCount + drop.mergedCount,
    selected: false,
  }
  return { board: { ...board, notes: board.notes.filter((item) => item.id !== drop.id).map((item) => (item.id === keep.id ? merged : item)) } }
}

export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value)
}

export function convertToAction(board: Board, id: string, owner: string, due: string): Change {
  const source = findNote(board, id)
  if (!source || source.column !== "improve") return { board, error: "Only a to-improve note becomes an action." }
  if (source.convertedTo) return { board, error: "That note already has an action." }
  if (!owner.trim()) return { board, error: "Name an owner for the action." }
  if (!isIsoDate(due)) return { board, error: "Pick a due date." }
  const actionId = `note-${board.nextId}`
  const action = note(actionId, "actions", source.text, { owner: owner.trim(), due, sourceId: source.id })
  const next = updateNote(board, id, (item) => ({ ...item, convertedTo: actionId, ownerDraft: "", dueDraft: "" }))
  return { board: { ...next, notes: [...next.notes, action], nextId: board.nextId + 1 } }
}

export function removeNote(board: Board, id: string): Board {
  const target = findNote(board, id)
  if (!target) return board
  return {
    ...board,
    votesUsed: Math.max(0, board.votesUsed - target.votes),
    notes: board.notes.filter((item) => item.id !== id).map((item) => (item.convertedTo === id ? { ...item, convertedTo: null } : item)),
  }
}

export function columnNotes(board: Board, column: ColumnId): Note[] {
  const notes = board.notes.filter((item) => item.column === column)
  return board.sortByVotes ? [...notes].sort((a, b) => b.votes - a.votes) : notes
}

export function startTimer(board: Board, now: number): Board {
  return { ...board, timer: { ...board.timer, endsAt: now + board.timer.durationSeconds * 1000, remainingSeconds: board.timer.durationSeconds } }
}

export function stopTimer(board: Board): Board {
  return { ...board, timer: { ...board.timer, endsAt: null, remainingSeconds: board.timer.durationSeconds } }
}

export function timerRemaining(timer: RetroTimer, now: number): number {
  return timer.endsAt === null ? timer.remainingSeconds : Math.max(0, Math.ceil((timer.endsAt - now) / 1000))
}

export function timerPercent(timer: RetroTimer, now: number): number {
  return Math.round(((timer.durationSeconds - timerRemaining(timer, now)) / timer.durationSeconds) * 100)
}

export function formatClock(seconds: number): string {
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
}

function voteSuffix(votes: number): string {
  return votes === 0 ? "" : ` (+${votes})`
}

export function exportMarkdown(board: Board, date: string): string {
  const sections = COLUMN_IDS.map((column) => {
    const notes = board.notes.filter((item) => item.column === column).sort((a, b) => b.votes - a.votes)
    const lines = notes.map((item) =>
      column === "actions"
        ? `- [ ] ${item.text} — **${item.owner}**, due ${item.due}`
        : `- ${item.text}${voteSuffix(item.votes)}${item.convertedTo ? " → action" : ""}`,
    )
    return `## ${COLUMN_TITLES[column]}\n\n${lines.length > 0 ? lines.join("\n") : "_Nothing here._"}`
  })
  return [`# Retro ${date}`, ...sections].join("\n\n")
}

export function followUpPrompt(board: Board, date: string): string | null {
  const actions = board.notes.filter((item) => item.column === "actions")
  if (actions.length === 0) return null
  const improve = columnNotes({ ...board, sortByVotes: true }, "improve").filter((item) => item.votes > 0).slice(0, 3)
  return [
    `Our team retro on ${date} produced these action items. For each one, find where in this repository the work would happen, propose a concrete first change, and flag any item that is not a code change.`,
    actions.map((item) => `- ${item.text} (owner ${item.owner}, due ${item.due})`).join("\n"),
    improve.length > 0 ? `Most-voted problems for context:\n${improve.map((item) => `- ${item.text} (${item.votes} vote${item.votes === 1 ? "" : "s"})`).join("\n")}` : "",
    "Start with the item due first. Do not make changes yet; reply with a plan.",
  ]
    .filter(Boolean)
    .join("\n\n")
}
