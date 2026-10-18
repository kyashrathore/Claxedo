import type { SurfaceComponent, SurfaceMessage } from "@claxedo/plugin-api"
import {
  CATEGORIES,
  CURRENCIES,
  balanceStatus,
  balances,
  categoryLabel,
  categoryStatus,
  categoryTotals,
  formatMoney,
  participantName,
  settle,
  splitEvenly,
  summaryMarkdown,
  totalSpent,
  type Trip,
} from "./model"

export const SURFACE_CATALOG_ID = "https://claxedo.dev/a2ui/v0.9/catalog.json"
const VERSION = "v0.9" as const

type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

type ButtonVariant = "default" | "primary" | "borderless"

type IconName = Extract<SurfaceComponent, { component: "Button" }>["icon"]

export type ErrorSlot = "form" | "expenses" | "people" | "budgets"

export const ERROR_SLOTS: readonly ErrorSlot[] = ["form", "expenses", "people", "budgets"]

function when<Item extends Json>(condition: boolean, item: Item): Item[] {
  return condition ? [item] : []
}

function text(id: string, value: string, variant?: "caption" | "body"): SurfaceComponent {
  return variant ? { id, component: "Text", text: value, variant } : { id, component: "Text", text: value }
}

function button(id: string, label: string, name: string, context: Record<string, { path: string }>, options: { variant?: ButtonVariant; icon?: IconName } = {}): SurfaceComponent[] {
  return [
    { id, component: "Button", ...(options.variant ? { variant: options.variant } : {}), ...(options.icon ? { icon: options.icon } : {}), child: `${id}-label`, action: { event: { name, context } } },
    text(`${id}-label`, label),
  ]
}

function stat(id: string, title: string): SurfaceComponent {
  return { id, component: "Stat", label: title, value: { path: `/kpis/${id}/value` }, caption: { path: `/kpis/${id}/caption` } }
}

const SLOT_CHILDREN: Readonly<Record<ErrorSlot, { readonly id: string; readonly before: readonly string[]; readonly after: readonly string[] }>> = {
  form: { id: "form-body", before: ["form-fields", "draft-category", "draft-split"], after: ["form-footer"] },
  expenses: { id: "expenses-body", before: [], after: ["expenses-empty", "expenses-list"] },
  people: { id: "people-body", before: ["people-list", "people-empty", "new-participant"], after: ["people-footer"] },
  budgets: { id: "budgets-edit-body", before: ["budget-fields"], after: ["budgets-footer"] },
}

export function slotBody(slot: ErrorSlot, error: boolean): SurfaceComponent {
  const { id, before, after } = SLOT_CHILDREN[slot]
  return { id, component: "Column", children: [...before, ...(error ? [`${slot}-error`] : []), ...after] }
}

const REFUSAL_SLOTS: ReadonlySet<ErrorSlot> = new Set(["expenses", "people"])

function errorCallout(slot: ErrorSlot): SurfaceComponent {
  const content = { id: `${slot}-error`, title: { path: `/errors/${slot}/title` }, text: { path: `/errors/${slot}/text` } }
  return REFUSAL_SLOTS.has(slot) ? { ...content, component: "Callout", tone: "warning", dismissible: true } : { ...content, component: "Callout", tone: "danger" }
}

export function participantPickers(trip: Trip): SurfaceComponent[] {
  const options = trip.participants.length === 0 ? [{ label: "Add a participant first", value: "" }] : trip.participants.map((participant) => ({ label: participant.name, value: participant.id }))
  return [
    { id: "draft-payer", component: "ChoicePicker", label: "Paid by", variant: "mutuallyExclusive", displayStyle: "dropdown", options, value: { path: "/draft/payer" } },
    { id: "draft-split", component: "ChoicePicker", label: "Split among", variant: "multipleSelection", displayStyle: "chips", options, value: { path: "/draft/split" } },
  ]
}

export function budgetComponents(trip: Trip): SurfaceComponent[] {
  return [
    { id: "root", component: "Column", children: ["header", "kpis", "form", "expenses", "money", "budgets", "export"] },

    { id: "header", component: "Header", title: { path: "/header/title" }, subtitle: { path: "/header/subtitle" }, icon: "payment", badges: ["header-total"] },
    { id: "header-total", component: "Badge", variant: "accent", text: { path: "/header/total" } },

    { id: "kpis", component: "Grid", columns: 4, children: ["spent", "average", "budget", "transfers"] },
    stat("spent", "Spent"),
    stat("average", "Per person"),
    stat("budget", "Budget used"),
    stat("transfers", "To settle"),

    { id: "form", component: "Section", title: "New expense", description: "Shares are exact to the cent: leftover cents go to the first people in the list.", child: "form-body" },
    slotBody("form", false),
    { id: "form-fields", component: "Grid", columns: 2, children: ["draft-description", "draft-amount", "draft-payer", "draft-date"] },
    { id: "draft-description", component: "TextField", label: "Description", value: { path: "/draft/description" } },
    { id: "draft-amount", component: "TextField", label: "Amount", variant: "number", value: { path: "/draft/amount" } },
    ...participantPickers(trip),
    { id: "draft-date", component: "DateTimeInput", label: "Date", enableDate: true, enableTime: false, value: { path: "/draft/date" } },
    {
      id: "draft-category",
      component: "ChoicePicker",
      label: "Category",
      variant: "mutuallyExclusive",
      displayStyle: "chips",
      options: CATEGORIES.map((category) => ({ label: category.label, value: category.id })),
      value: { path: "/draft/category" },
    },
    errorCallout("form"),
    { id: "form-footer", component: "Footer", end: ["add-expense"] },
    ...button("add-expense", "Add expense", "addExpense", { draft: { path: "/draft" } }, { variant: "primary", icon: "add" }),

    { id: "expenses", component: "Section", title: "Expenses", description: { path: "/expenses/count" }, child: "expenses-body" },
    slotBody("expenses", false),
    errorCallout("expenses"),
    { id: "expenses-empty", component: "List", children: { componentId: "empty-state", path: "/expenses/empty" } },
    { id: "expenses-list", component: "List", children: { componentId: "expense", path: "/expenses/items" } },
    { id: "expense", component: "ListItem", icon: "shoppingCart", title: { path: "description" }, subtitle: { path: "detail" }, meta: ["expense-amount"], actions: ["expense-delete"] },
    { id: "expense-amount", component: "Badge", text: { path: "amount" } },
    ...button("expense-delete", "Delete expense", "deleteExpense", { id: { path: "id" } }, { icon: "delete" }),
    { id: "empty-state", component: "EmptyState", title: { path: "title" }, description: { path: "description" } },

    { id: "money", component: "Grid", columns: 2, children: ["people", "settle"] },
    { id: "people", component: "Section", title: "People", description: "What each person paid and their share", child: "people-body" },
    slotBody("people", false),
    { id: "people-list", component: "List", children: { componentId: "person", path: "/people" } },
    { id: "person", component: "ListItem", icon: "person", title: { path: "name" }, subtitle: { path: "detail" }, meta: ["person-balance"], actions: ["person-remove"] },
    { id: "person-balance", component: "Badge", text: { path: "balance" }, variant: { path: "tone" } },
    ...button("person-remove", "Remove person", "removeParticipant", { id: { path: "id" }, payer: { path: "/draft/payer" }, split: { path: "/draft/split" } }, { icon: "delete" }),
    { id: "people-empty", component: "List", children: { componentId: "empty-state", path: "/peopleEmpty" } },
    errorCallout("people"),
    { id: "new-participant", component: "TextField", label: "New participant", value: { path: "/newParticipant" } },
    { id: "people-footer", component: "Footer", end: ["add-participant"] },
    ...button("add-participant", "Add participant", "addParticipant", { name: { path: "/newParticipant" } }, { icon: "add" }),

    { id: "settle", component: "Section", title: "Settle up", description: { path: "/settleCaption" }, child: "settle-body" },
    { id: "settle-body", component: "Column", children: ["settle-list", "settle-empty"] },
    { id: "settle-list", component: "List", children: { componentId: "transfer", path: "/transfers" } },
    { id: "transfer", component: "ListItem", icon: "send", title: { path: "title" }, meta: ["transfer-amount"] },
    { id: "transfer-amount", component: "Badge", text: { path: "amount" } },
    { id: "settle-empty", component: "List", children: { componentId: "empty-state", path: "/transfersEmpty" } },

    { id: "budgets", component: "Section", title: "Budgets by category", description: { path: "/overall/label" }, child: "budgets-body" },
    { id: "budgets-body", component: "Column", children: ["overall-progress", "categories-list", "budgets-edit"] },
    { id: "overall-progress", component: "Progress", value: { path: "/overall/percent" }, max: 100, label: { path: "/overall/progressLabel" } },
    { id: "categories-list", component: "List", children: { componentId: "category", path: "/categories" } },
    { id: "category", component: "ListItem", title: { path: "label" }, subtitle: { path: "progressLabel" }, meta: ["category-status"] },
    { id: "category-status", component: "Badge", text: { path: "status" }, variant: { path: "tone" } },
    { id: "budgets-edit", component: "Collapsible", title: "Edit budgets and currency", child: "budgets-edit-body" },
    slotBody("budgets", false),
    { id: "budget-fields", component: "Grid", columns: 3, children: [...CATEGORIES.map((category) => `budget-${category.id}`), "currency-picker"] },
    ...CATEGORIES.map((category, index): SurfaceComponent => ({
      id: `budget-${category.id}`,
      component: "TextField",
      label: { path: `/categories/${index}/budgetLabel` },
      variant: "number",
      validationRegexp: "[0-9]+([.,][0-9]{1,2})?",
      value: { path: `/categories/${index}/budget` },
    })),
    {
      id: "currency-picker",
      component: "ChoicePicker",
      label: "Currency",
      variant: "mutuallyExclusive",
      displayStyle: "dropdown",
      options: CURRENCIES.map((currency) => ({ label: currency.label, value: currency.id })),
      value: { path: "/currency" },
    },
    errorCallout("budgets"),
    { id: "budgets-footer", component: "Footer", start: ["currency-apply"], end: ["save-budgets"] },
    ...button("currency-apply", "Use currency", "setCurrency", { currency: { path: "/currency" } }, { variant: "borderless" }),
    ...button("save-budgets", "Save budgets", "saveBudgets", { categories: { path: "/categories" } }),

    { id: "export", component: "Collapsible", title: "Export summary", child: "export-body" },
    { id: "export-body", component: "Column", children: ["export-caption", "export-code"] },
    text("export-caption", "Markdown you can paste into a chat or a note. It updates with every change.", "caption"),
    { id: "export-code", component: "Code", language: "markdown", text: { path: "/export" } },
  ]
}

export function emptyDraft(trip: Trip, today: string): Record<string, Json> {
  return {
    description: "",
    amount: "",
    payer: trip.participants.slice(0, 1).map((participant) => participant.id),
    split: trip.participants.map((participant) => participant.id),
    category: ["food"],
    date: today,
  }
}

export function categoryBudgets(trip: Trip): Json[] {
  return CATEGORIES.map((category) => String(trip.budgets[category.id] / 100))
}

function plural(count: number, noun: string, many = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : many}`
}

export function displayEntries(trip: Trip, formatDate: (iso: string) => string): Map<string, Json> {
  const money = (cents: number) => formatMoney(cents, trip.currency)
  const total = totalSpent(trip)
  const average = trip.participants.length === 0 ? 0 : Math.round(total / trip.participants.length)
  const balanceList = balances(trip)
  const transfers = settle(balanceList)
  const totals = categoryTotals(trip)
  const budgetTotal = totals.reduce((sum, row) => sum + row.budget, 0)
  const used = budgetTotal === 0 ? 0 : Math.round((total / budgetTotal) * 100)
  const sorted = [...trip.expenses].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))
  const entries = new Map<string, Json>()
  entries.set("/header", {
    title: trip.name,
    subtitle: `${plural(trip.participants.length, "person", "people")} · amounts in ${trip.currency}, split to the cent`,
    total: `${money(total)} spent`,
  })
  entries.set("/kpis", {
    spent: { value: money(total), caption: sorted[0] ? `Since ${formatDate(sorted[0].date)}` : "No expenses yet" },
    average: { value: money(average), caption: `Average share of ${plural(trip.participants.length, "person", "people")}` },
    budget: { value: `${used}%`, caption: `of ${money(budgetTotal)} in budgets` },
    transfers: {
      value: transfers.length === 0 ? "All square" : plural(transfers.length, "transfer"),
      caption: transfers.length === 0 ? "Nobody owes anybody" : `${money(transfers.reduce((sum, transfer) => sum + transfer.amount, 0))} changes hands`,
    },
  })
  entries.set(
    "/people",
    balanceList.map((balance) => {
      const status = balanceStatus(balance, trip.currency)
      return { id: balance.id, name: balance.name, detail: `paid ${money(balance.paid)} · share ${money(balance.share)}`, balance: status.label, tone: status.tone }
    }),
  )
  entries.set("/peopleEmpty", when(trip.participants.length === 0, { title: "Nobody yet", description: "Add the people sharing costs on this trip." }))
  entries.set("/expenses/count", plural(trip.expenses.length, "expense"))
  entries.set("/expenses/empty", when(trip.expenses.length === 0, { title: "No expenses yet", description: "Add the first expense with the form above." }))
  entries.set(
    "/expenses/items",
    sorted.map((expense) => {
      const shares = [...splitEvenly(expense.amount, expense.splitAmong).values()]
      const min = Math.min(...shares)
      const max = Math.max(...shares)
      const among = expense.splitAmong.length === trip.participants.length ? "everyone" : expense.splitAmong.map((id) => participantName(trip, id)).join(", ")
      return {
        id: expense.id,
        description: expense.description,
        detail: `${formatDate(expense.date)} · ${categoryLabel(expense.category)} · ${participantName(trip, expense.payer)} paid · split among ${among}, ${min === max ? money(min) : `${money(min)}–${money(max)}`} each`,
        amount: money(expense.amount),
      }
    }),
  )
  entries.set("/overall", {
    percent: Math.min(100, used),
    label: `${money(total)} of ${money(budgetTotal)} total budget`,
    progressLabel: `${used}% of the total budget used`,
  })
  totals.forEach((row, index) => {
    const status = categoryStatus(row, trip.currency)
    entries.set(`/categories/${index}/id`, row.id)
    entries.set(`/categories/${index}/label`, row.label)
    entries.set(`/categories/${index}/budgetLabel`, `${row.label} (${trip.currency})`)
    entries.set(`/categories/${index}/progressLabel`, `${money(row.spent)} of ${money(row.budget)} (${row.percent}%)`)
    entries.set(`/categories/${index}/status`, status.label)
    entries.set(`/categories/${index}/tone`, status.tone)
  })
  entries.set("/settleCaption", transfers.length === 0 ? "No transfers needed." : `${plural(transfers.length, "transfer")} settle every balance, largest debts first.`)
  entries.set(
    "/transfers",
    transfers.map((transfer) => ({
      title: `${participantName(trip, transfer.from)} pays ${participantName(trip, transfer.to)}`,
      amount: money(transfer.amount),
    })),
  )
  entries.set("/transfersEmpty", when(transfers.length === 0, { title: "All square", description: "Nobody owes anybody." }))
  entries.set("/export", summaryMarkdown(trip))
  return entries
}

function isObject(value: Json | undefined): value is { [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function withValue(node: Json | undefined, segments: readonly string[], value: Json): Json {
  const [head, ...rest] = segments
  if (head === undefined) return value
  if (Array.isArray(node) || (node === undefined && /^\d+$/.test(head))) {
    const list = Array.isArray(node) ? [...node] : []
    list[Number(head)] = withValue(list[Number(head)], rest, value)
    return list
  }
  const object = isObject(node) ? { ...node } : {}
  object[head] = withValue(object[head], rest, value)
  return object
}

function pointerSegments(pointer: string): string[] {
  return pointer.slice(1).split("/")
}

export function initialData(trip: Trip, entries: Map<string, Json>, today: string): { [key: string]: Json } {
  const errors = Object.fromEntries(ERROR_SLOTS.map((slot) => [slot, { title: "", text: "" }]))
  let data: Json = { currency: [trip.currency], newParticipant: "", draft: emptyDraft(trip, today), errors }
  for (const [pointer, value] of entries) data = withValue(data, pointerSegments(pointer), value)
  categoryBudgets(trip).forEach((budget, index) => {
    data = withValue(data, ["categories", String(index), "budget"], budget)
  })
  return isObject(data) ? data : {}
}

export function update(surfaceId: string, path: string, value: Json): SurfaceMessage {
  return { version: VERSION, updateDataModel: { surfaceId, path, value } }
}

export function replaceComponents(surfaceId: string, components: SurfaceComponent[]): SurfaceMessage {
  return { version: VERSION, updateComponents: { surfaceId, components } }
}

export function openingMessages(surfaceId: string, trip: Trip, data: Record<string, Json>): SurfaceMessage[] {
  return [
    { version: VERSION, createSurface: { surfaceId, catalogId: SURFACE_CATALOG_ID } },
    replaceComponents(surfaceId, budgetComponents(trip)),
    update(surfaceId, "/", data),
  ]
}

export function changedEntries(surfaceId: string, shown: Map<string, Json>, next: Map<string, Json>): SurfaceMessage[] {
  const messages: SurfaceMessage[] = []
  for (const [pointer, value] of next) {
    const before = shown.get(pointer)
    if (JSON.stringify(before) === JSON.stringify(value)) continue
    if (isObject(before) && isObject(value)) {
      for (const [key, field] of Object.entries(value)) {
        if (JSON.stringify(before[key]) !== JSON.stringify(field)) messages.push(update(surfaceId, `${pointer}/${key}`, field))
      }
    } else messages.push(update(surfaceId, pointer, value))
  }
  return messages
}
