export const COLUMNS = [
  { id: "backlog", title: "Backlog" },
  { id: "progress", title: "In progress" },
  { id: "review", title: "Review" },
  { id: "done", title: "Done" },
] as const

export type ColumnId = (typeof COLUMNS)[number]["id"]

export const PRIORITIES = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "critical", label: "Critical" },
] as const

export type Priority = (typeof PRIORITIES)[number]["id"]

export const STORY_POINTS = [1, 2, 3, 5, 8, 13] as const

export const WIP_LIMIT_RANGE = { min: 1, max: 20 } as const

export type Owner = { readonly id: string; readonly name: string }

export const TEAM: readonly Owner[] = [
  { id: "maya", name: "Maya Chen" },
  { id: "luis", name: "Luis Ortega" },
  { id: "priya", name: "Priya Nair" },
  { id: "sam", name: "Sam Okafor" },
  { id: "jonas", name: "Jonas Weber" },
]

export type Task = {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly owner: string
  readonly priority: Priority
  readonly points: number
  readonly due: string
  readonly column: ColumnId
  readonly doneOn?: string
}

export type WipLimit = { readonly enforce: boolean; readonly limit: number }

export type Sprint = { readonly name: string; readonly goal: string; readonly start: string; readonly days: number }

export type Board = {
  readonly sprint: Sprint
  readonly tasks: readonly Task[]
  readonly wip: Readonly<Record<ColumnId, WipLimit>>
  readonly nextId: number
}

export type BoardResult = { readonly ok: true; readonly board: Board; readonly message: string } | { readonly ok: false; readonly error: string }

export type TaskDraft = Omit<Task, "id" | "column" | "doneOn">

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const DAY_MS = 86_400_000

export function isIsoDate(value: string): boolean {
  const match = ISO_DATE.exec(value)
  if (!match) return false
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

function dayNumber(iso: string): number {
  return Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY_MS)
}

export function addDays(iso: string, days: number): string {
  return new Date((dayNumber(iso) + days) * DAY_MS).toISOString().slice(0, 10)
}

export function daysBetween(from: string, to: string): number {
  return dayNumber(to) - dayNumber(from)
}

export function localIsoDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function columnTitle(column: ColumnId): string {
  return COLUMNS.find((entry) => entry.id === column)?.title ?? column
}

export function ownerName(id: string): string {
  return TEAM.find((owner) => owner.id === id)?.name ?? "Unassigned"
}

export function priorityLabel(priority: Priority): string {
  return PRIORITIES.find((entry) => entry.id === priority)?.label ?? priority
}

export function isUrgent(priority: Priority): boolean {
  return priority === "high" || priority === "critical"
}

export function snapToStoryPoints(value: number): number {
  if (!Number.isFinite(value)) return STORY_POINTS[0]
  let best: number = STORY_POINTS[0]
  for (const points of STORY_POINTS) {
    if (Math.abs(points - value) <= Math.abs(best - value)) best = points
  }
  return best
}

function firstChoice(value: unknown): string | undefined {
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : undefined
  return typeof value === "string" && value !== "" ? value : undefined
}

function isPriority(value: string | undefined): value is Priority {
  return PRIORITIES.some((entry) => entry.id === value)
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value))
}

export function parseTaskDraft(value: unknown, sprint: Sprint): { ok: true; draft: TaskDraft } | { ok: false; error: string } {
  const input = record(value)
  const title = typeof input.title === "string" ? input.title.trim().replace(/\s+/g, " ") : ""
  if (title.length < 3) return { ok: false, error: "Give the task a title of at least 3 characters." }
  if (title.length > 120) return { ok: false, error: "Keep the title under 120 characters." }
  const description = typeof input.description === "string" ? input.description.trim() : ""
  if (description.length > 2000) return { ok: false, error: "Keep the description under 2000 characters." }
  const owner = firstChoice(input.owner)
  if (!owner || !TEAM.some((member) => member.id === owner)) return { ok: false, error: "Choose an owner from the team." }
  const priority = firstChoice(input.priority)
  if (!isPriority(priority)) return { ok: false, error: "Choose a priority." }
  const rawPoints = typeof input.points === "number" ? input.points : Number(firstChoice(input.points))
  const due = typeof input.due === "string" ? input.due.slice(0, 10) : ""
  if (due !== "" && !isIsoDate(due)) return { ok: false, error: "The due date is not a valid date." }
  if (due !== "" && daysBetween(sprint.start, due) < 0) return { ok: false, error: "The due date falls before the sprint starts." }
  return { ok: true, draft: { title, description, owner, priority, points: snapToStoryPoints(rawPoints), due } }
}

function tasksIn(board: Board, column: ColumnId): readonly Task[] {
  return board.tasks.filter((task) => task.column === column)
}

function wipRefusal(board: Board, column: ColumnId): string | undefined {
  const wip = board.wip[column]
  const count = tasksIn(board, column).length
  if (!wip.enforce || count < wip.limit) return undefined
  return `${columnTitle(column)} is at its WIP limit (${count}/${wip.limit}). Finish or move a task out first.`
}

export function addTask(board: Board, draft: TaskDraft): BoardResult {
  const refusal = wipRefusal(board, "backlog")
  if (refusal) return { ok: false, error: refusal }
  const task: Task = { ...draft, id: `T-${board.nextId}`, column: "backlog" }
  return { ok: true, board: { ...board, tasks: [...board.tasks, task], nextId: board.nextId + 1 }, message: `Added ${task.id} “${task.title}” to Backlog.` }
}

export function moveTask(board: Board, id: string, step: number, today: string): BoardResult {
  const task = board.tasks.find((entry) => entry.id === id)
  if (!task) return { ok: false, error: "That task no longer exists." }
  const from = COLUMNS.findIndex((column) => column.id === task.column)
  const target = COLUMNS[from + Math.sign(step)]
  if (step === 0 || !target) return { ok: false, error: `“${task.title}” cannot move further that way.` }
  const refusal = wipRefusal(board, target.id)
  if (refusal) return { ok: false, error: refusal }
  const { doneOn: _previous, ...rest } = task
  const moved: Task = target.id === "done" ? { ...rest, column: target.id, doneOn: today } : { ...rest, column: target.id }
  return {
    ok: true,
    board: { ...board, tasks: board.tasks.map((entry) => (entry.id === id ? moved : entry)) },
    message: `Moved “${task.title}” to ${target.title}.`,
  }
}

export function deleteTask(board: Board, id: string): BoardResult {
  const task = board.tasks.find((entry) => entry.id === id)
  if (!task) return { ok: false, error: "That task no longer exists." }
  return { ok: true, board: { ...board, tasks: board.tasks.filter((entry) => entry.id !== id) }, message: `Deleted “${task.title}”.` }
}

export function setWipLimit(board: Board, column: string, enforce: unknown, limit: unknown): BoardResult {
  const entry = COLUMNS.find((candidate) => candidate.id === column)
  if (!entry) return { ok: false, error: "Unknown column." }
  const numeric = typeof limit === "number" ? limit : Number(limit)
  if (!Number.isFinite(numeric)) return { ok: false, error: "The WIP limit must be a number." }
  const clamped = Math.min(WIP_LIMIT_RANGE.max, Math.max(WIP_LIMIT_RANGE.min, Math.round(numeric)))
  const wip: WipLimit = { enforce: enforce === true, limit: clamped }
  const count = tasksIn(board, entry.id).length
  const over = count > clamped ? ` ${entry.title} already holds ${count}, so it shows a warning until tasks move out.` : ""
  return {
    ok: true,
    board: { ...board, wip: { ...board.wip, [entry.id]: wip } },
    message: `${entry.title}: limit ${clamped}, ${wip.enforce ? "enforced" : "advisory"}.${over}`,
  }
}

export type Tone = "neutral" | "accent" | "success" | "warning" | "danger"

export function priorityTone(priority: Priority): Tone {
  if (priority === "critical") return "danger"
  return priority === "high" ? "warning" : "neutral"
}

export type WipStatus = { readonly count: number; readonly limit: number; readonly enforce: boolean; readonly exceeded: boolean; readonly full: boolean }

export function wipStatus(board: Board, column: ColumnId): WipStatus {
  const wip = board.wip[column]
  const count = tasksIn(board, column).length
  return { count, limit: wip.limit, enforce: wip.enforce, exceeded: count > wip.limit, full: count === wip.limit }
}

export function wipTone(status: WipStatus): Tone {
  if (status.exceeded) return "danger"
  return status.full && status.enforce ? "warning" : "neutral"
}

export function wipLabel(status: WipStatus): string {
  const base = `${status.count} / ${status.limit}`
  if (status.exceeded) return `${base} · over limit`
  if (status.full && status.enforce) return `${base} · at limit`
  return status.enforce ? base : `${base} advisory`
}

export function filterByOwners(tasks: readonly Task[], owners: readonly string[]): readonly Task[] {
  return owners.length === 0 ? tasks : tasks.filter((task) => owners.includes(task.owner))
}

export function parseOwnerFilter(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return TEAM.map((owner) => owner.id).filter((id) => value.includes(id))
}

export type SprintProgress = { readonly done: number; readonly total: number; readonly percent: number }

export function sprintProgress(board: Board): SprintProgress {
  const total = board.tasks.reduce((sum, task) => sum + task.points, 0)
  const done = tasksIn(board, "done").reduce((sum, task) => sum + task.points, 0)
  return { done, total, percent: total === 0 ? 0 : Math.round((done / total) * 100) }
}

export function sprintDay(sprint: Sprint, today: string): number {
  return Math.min(sprint.days, Math.max(1, daysBetween(sprint.start, today) + 1))
}

export type BurndownDay = {
  readonly day: number
  readonly date: string
  readonly ideal: number
  readonly remaining: number | undefined
  readonly completed: number
}

export function burndown(board: Board, today: string): readonly BurndownDay[] {
  const { total } = sprintProgress(board)
  const done = tasksIn(board, "done")
  const last = Math.max(1, board.sprint.days - 1)
  return Array.from({ length: board.sprint.days }, (_, index) => {
    const date = addDays(board.sprint.start, index)
    const completed = done.filter((task) => task.doneOn === date).reduce((sum, task) => sum + task.points, 0)
    const burned = done.filter((task) => task.doneOn !== undefined && task.doneOn <= date).reduce((sum, task) => sum + task.points, 0)
    const ideal = Math.round(total * (1 - index / last) * 10) / 10
    return { day: index + 1, date, ideal, remaining: date > today ? undefined : total - burned, completed }
  })
}

export type SprintHealth = { readonly label: string; readonly tone: Tone; readonly day: BurndownDay | undefined }

export function sprintHealth(days: readonly BurndownDay[]): SprintHealth {
  const day = [...days].reverse().find((entry) => entry.remaining !== undefined)
  if (!day || day.remaining === undefined) return { label: "Not started", tone: "neutral", day }
  return day.remaining > day.ideal ? { label: "Behind", tone: "warning", day } : { label: "On track", tone: "success", day }
}

export type DueStatus = { readonly label: string; readonly overdue: boolean }

export function dueStatus(task: Task, today: string): DueStatus {
  if (task.due === "") return { label: "No due date", overdue: false }
  if (task.column === "done") return { label: `Was due ${task.due}`, overdue: false }
  const days = daysBetween(today, task.due)
  if (days < 0) return { label: `Overdue by ${-days} day${days === -1 ? "" : "s"}`, overdue: true }
  if (days === 0) return { label: "Due today", overdue: false }
  return { label: days === 1 ? "Due tomorrow" : `Due in ${days} days`, overdue: false }
}

export function seedBoard(today: string): Board {
  const start = addDays(today, -5)
  const task = (id: number, column: ColumnId, title: string, owner: string, priority: Priority, points: number, dueOffset: number, description: string, doneOffset?: number): Task => ({
    id: `T-${id}`,
    title,
    description,
    owner,
    priority,
    points,
    due: addDays(start, dueOffset),
    column,
    ...(doneOffset === undefined ? {} : { doneOn: addDays(start, doneOffset) }),
  })
  return {
    sprint: { name: "Sprint 42", goal: "Ship the checkout revamp to 100% of web traffic", start, days: 10 },
    nextId: 111,
    wip: {
      backlog: { enforce: false, limit: 12 },
      progress: { enforce: true, limit: 3 },
      review: { enforce: true, limit: 2 },
      done: { enforce: false, limit: 20 },
    },
    tasks: [
      task(101, "progress", "Tokenize saved cards with the vault API", "maya", "high", 8, 7, "Replace raw PAN storage with vault tokens; migrate 1.2M saved cards in batches."),
      task(102, "review", "Inline address validation in checkout", "luis", "medium", 5, 6, "Validate postcode and street against the address service before the payment step."),
      task(103, "backlog", "Apple Pay button on the cart drawer", "priya", "high", 5, 8, "Show the express button only when the device reports an active wallet."),
      task(104, "done", "Fix double submit on the pay button", "sam", "critical", 3, 2, "Disable the button and dedupe on the idempotency key.", 1),
      task(105, "done", "Promo codes accept lowercase input", "jonas", "low", 1, 3, "Normalize codes before lookup.", 2),
      task(106, "progress", "Order confirmation email redesign", "priya", "medium", 3, 9, "New template with itemized taxes and the delivery window."),
      task(107, "review", "3-D Secure challenge fallback for Safari", "maya", "critical", 8, 4, "Safari blocks the challenge iframe's third-party cookies; fall back to a redirect flow."),
      task(108, "backlog", "Load test the payment gateway at 3x peak", "sam", "high", 5, 9, "k6 scenario against staging with production-sized catalog."),
      task(109, "done", "Analytics events for checkout funnel steps", "jonas", "medium", 3, 5, "Emit step_viewed and step_completed with the cart value.", 4),
      task(110, "backlog", "Remove the legacy PayPal v1 SDK", "luis", "low", 2, 9, "Delete the v1 loader once the v2 rollout reaches 100%."),
    ],
  }
}
