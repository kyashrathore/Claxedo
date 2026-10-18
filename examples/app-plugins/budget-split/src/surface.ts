import type { SurfaceComponent, SurfaceMessage } from "@claxedo/plugin-api"
import {
  CATEGORIES,
  CURRENCIES,
  balances,
  categoryLabel,
  categoryTotals,
  currencyOf,
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

function when<Item extends Json>(condition: boolean, item: Item): Item[] {
  return condition ? [item] : []
}

function text(id: string, value: string, variant?: "h1" | "h2" | "h3" | "h4" | "h5" | "caption" | "body"): SurfaceComponent {
  return variant ? { id, component: "Text", text: value, variant } : { id, component: "Text", text: value }
}

function button(id: string, label: string, name: string, context: Record<string, { path: string }>, variant: "default" | "primary" | "borderless" = "default"): SurfaceComponent[] {
  return [{ id, component: "Button", variant, child: `${id}-label`, action: { event: { name, context } } }, text(`${id}-label`, label)]
}

export function participantPickers(trip: Trip): SurfaceComponent[] {
  const options = trip.participants.length === 0 ? [{ label: "Add a participant first", value: "" }] : trip.participants.map((participant) => ({ label: participant.name, value: participant.id }))
  return [
    { id: "draft-payer", component: "ChoicePicker", weight: 1, label: "Paid by", variant: "mutuallyExclusive", displayStyle: "dropdown", options, value: { path: "/draft/payer" } },
    { id: "draft-split", component: "ChoicePicker", label: "Split among", variant: "multipleSelection", displayStyle: "chips", options, value: { path: "/draft/split" } },
  ]
}

export function budgetSlider(trip: Trip): SurfaceComponent {
  const currency = currencyOf(trip.currency)
  return { id: "category-budget", component: "Slider", label: `Budget (${currency.id})`, min: 0, max: currency.budgetMax, step: currency.budgetStep, value: { path: "budget" } }
}

export function budgetComponents(trip: Trip): SurfaceComponent[] {
  return [
    { id: "root", component: "Column", children: ["header", "people-card", "expense-form", "expenses-card", "categories-card", "money-row", "export"] },

    { id: "header", component: "Row", align: "center", children: ["header-icon", "header-titles", "header-total", "currency-picker", "currency-apply"] },
    { id: "header-icon", component: "Icon", name: "payment" },
    { id: "header-titles", component: "Column", weight: 1, children: ["header-title", "header-subtitle"] },
    { id: "header-title", component: "Text", variant: "h1", text: { path: "/header/title" } },
    { id: "header-subtitle", component: "Text", variant: "caption", text: { path: "/header/subtitle" } },
    { id: "header-total", component: "Badge", variant: "accent", text: { path: "/header/total" } },
    {
      id: "currency-picker",
      component: "ChoicePicker",
      label: "Currency",
      variant: "mutuallyExclusive",
      displayStyle: "dropdown",
      options: CURRENCIES.map((currency) => ({ label: currency.label, value: currency.id })),
      value: { path: "/currency" },
    },
    ...button("currency-apply", "Use currency", "setCurrency", { currency: { path: "/currency" } }),

    { id: "people-card", component: "Card", child: "people-body" },
    { id: "people-body", component: "Column", children: ["people-title", "people-list", "people-empty", "people-add"] },
    text("people-title", "Participants", "h3"),
    { id: "people-list", component: "List", children: { componentId: "person-row", path: "/participants" } },
    { id: "person-row", component: "Row", align: "center", children: ["person-icon", "person-name", "person-paid", "person-remove"] },
    { id: "person-icon", component: "Icon", name: "person" },
    { id: "person-name", component: "Text", weight: 1, text: { path: "name" } },
    { id: "person-paid", component: "Badge", text: { path: "paidLabel" } },
    ...button("person-remove", "Remove", "removeParticipant", { id: { path: "id" }, payer: { path: "/draft/payer" }, split: { path: "/draft/split" } }, "borderless"),
    { id: "people-empty", component: "List", children: { componentId: "empty-state", path: "/participantsEmpty" } },
    { id: "people-add", component: "Row", align: "end", children: ["new-participant", "add-participant"] },
    { id: "new-participant", component: "TextField", weight: 1, label: "New participant", value: { path: "/newParticipant" } },
    ...button("add-participant", "Add participant", "addParticipant", { name: { path: "/newParticipant" } }),
    { id: "empty-state", component: "EmptyState", title: { path: "title" }, description: { path: "description" } },

    { id: "expense-form", component: "Collapsible", title: "New expense", open: true, child: "form-body" },
    { id: "form-body", component: "Column", children: ["form-row-1", "form-row-2", "draft-split", "draft-category", "form-actions"] },
    { id: "form-row-1", component: "Row", align: "end", children: ["draft-description", "draft-amount"] },
    { id: "draft-description", component: "TextField", weight: 2, label: "Description", value: { path: "/draft/description" } },
    { id: "draft-amount", component: "TextField", weight: 1, label: "Amount", variant: "number", value: { path: "/draft/amount" } },
    { id: "form-row-2", component: "Row", align: "end", children: ["draft-payer", "draft-date"] },
    ...participantPickers(trip),
    { id: "draft-date", component: "DateTimeInput", weight: 1, label: "Date", enableDate: true, enableTime: false, value: { path: "/draft/date" } },
    {
      id: "draft-category",
      component: "ChoicePicker",
      label: "Category",
      variant: "mutuallyExclusive",
      displayStyle: "chips",
      options: CATEGORIES.map((category) => ({ label: category.label, value: category.id })),
      value: { path: "/draft/category" },
    },
    { id: "form-actions", component: "Row", align: "center", children: ["add-expense", "form-hint"] },
    ...button("add-expense", "Add expense", "addExpense", { draft: { path: "/draft" } }, "primary"),
    text("form-hint", "Shares are exact to the cent: leftover cents go to the first people in the list.", "caption"),

    { id: "expenses-card", component: "Card", child: "expenses-body" },
    { id: "expenses-body", component: "Column", children: ["expenses-head", "expenses-empty", "expenses-table", "expenses-manage"] },
    { id: "expenses-head", component: "Row", align: "center", children: ["expenses-title", "expenses-count"] },
    { ...text("expenses-title", "Expenses", "h3"), weight: 1 },
    { id: "expenses-count", component: "Badge", text: { path: "/expenses/count" } },
    { id: "expenses-empty", component: "List", children: { componentId: "empty-state", path: "/expenses/empty" } },
    {
      id: "expenses-table",
      component: "Table",
      columns: [
        { key: "date", title: "Date" },
        { key: "description", title: "Description" },
        { key: "category", title: "Category" },
        { key: "payer", title: "Paid by" },
        { key: "split", title: "Split among" },
        { key: "amount", title: "Amount" },
        { key: "each", title: "Per person" },
      ],
      rows: { path: "/expenses/table" },
    },
    { id: "expenses-manage", component: "Collapsible", title: "Delete an expense", child: "expenses-items" },
    { id: "expenses-items", component: "List", children: { componentId: "expense-item", path: "/expenses/items" } },
    { id: "expense-item", component: "Row", align: "center", children: ["expense-item-label", "expense-delete"] },
    { id: "expense-item-label", component: "Text", weight: 1, text: { path: "label" } },
    ...button("expense-delete", "Delete", "deleteExpense", { id: { path: "id" } }, "borderless"),

    { id: "categories-card", component: "Card", child: "categories-body" },
    { id: "categories-body", component: "Column", children: ["categories-title", "overall-progress", "categories-divider", "categories-list", "save-budgets"] },
    text("categories-title", "Budgets by category", "h3"),
    { id: "overall-progress", component: "Progress", value: { path: "/overall/percent" }, max: 100, label: { path: "/overall/label" } },
    { id: "categories-divider", component: "Divider" },
    { id: "categories-list", component: "List", children: { componentId: "category-row", path: "/categories" } },
    { id: "category-row", component: "Column", children: ["category-head", "category-progress", "category-budget"] },
    { id: "category-head", component: "Row", align: "center", children: ["category-label", "category-over", "category-status"] },
    { id: "category-label", component: "Text", variant: "h5", weight: 1, text: { path: "label" } },
    { id: "category-over", component: "List", direction: "horizontal", children: { componentId: "category-over-badge", path: "over" } },
    { id: "category-over-badge", component: "Badge", variant: "accent", text: { path: "text" } },
    { id: "category-status", component: "Text", variant: "caption", text: { path: "status" } },
    { id: "category-progress", component: "Progress", value: { path: "percent" }, max: 100, label: { path: "progressLabel" } },
    budgetSlider(trip),
    ...button("save-budgets", "Save budgets", "saveBudgets", { categories: { path: "/categories" } }),

    { id: "money-row", component: "Row", align: "start", children: ["balances-card", "settle-card"] },
    { id: "balances-card", component: "Card", weight: 1, child: "balances-body" },
    { id: "balances-body", component: "Column", children: ["balances-title", "balances-list"] },
    text("balances-title", "Balances", "h3"),
    { id: "balances-list", component: "List", children: { componentId: "balance-row", path: "/balances" } },
    { id: "balance-row", component: "Row", align: "center", children: ["balance-icon", "balance-text", "balance-owed", "balance-owes"] },
    { id: "balance-icon", component: "Icon", name: "accountCircle" },
    { id: "balance-text", component: "Column", weight: 1, children: ["balance-name", "balance-detail"] },
    { id: "balance-name", component: "Text", variant: "h5", text: { path: "name" } },
    { id: "balance-detail", component: "Text", variant: "caption", text: { path: "detail" } },
    { id: "balance-owed", component: "List", direction: "horizontal", children: { componentId: "balance-owed-badge", path: "owed" } },
    { id: "balance-owed-badge", component: "Badge", variant: "accent", text: { path: "text" } },
    { id: "balance-owes", component: "List", direction: "horizontal", children: { componentId: "balance-owes-badge", path: "owes" } },
    { id: "balance-owes-badge", component: "Badge", variant: "neutral", text: { path: "text" } },
    { id: "settle-card", component: "Card", weight: 1, child: "settle-body" },
    { id: "settle-body", component: "Column", children: ["settle-title", "settle-caption", "settle-list", "settle-empty"] },
    text("settle-title", "Settle up", "h3"),
    { id: "settle-caption", component: "Text", variant: "caption", text: { path: "/settleCaption" } },
    { id: "settle-list", component: "List", children: { componentId: "transfer-row", path: "/transfers" } },
    { id: "transfer-row", component: "Row", align: "center", children: ["transfer-icon", "transfer-text"] },
    { id: "transfer-icon", component: "Icon", name: "send" },
    { id: "transfer-text", component: "Text", text: { path: "text" } },
    { id: "settle-empty", component: "List", children: { componentId: "empty-state", path: "/transfersEmpty" } },

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
  return CATEGORIES.map((category) => trip.budgets[category.id] / 100)
}

export function displayEntries(trip: Trip, formatDate: (iso: string) => string): Map<string, Json> {
  const money = (cents: number) => formatMoney(cents, trip.currency)
  const total = totalSpent(trip)
  const balanceList = balances(trip)
  const transfers = settle(balanceList)
  const totals = categoryTotals(trip)
  const budgetTotal = totals.reduce((sum, row) => sum + row.budget, 0)
  const entries = new Map<string, Json>()
  entries.set("/header", {
    title: trip.name,
    subtitle: `${trip.participants.length} people · ${trip.expenses.length} expenses · ${money(trip.participants.length === 0 ? 0 : Math.round(total / trip.participants.length))} per person on average`,
    total: `${money(total)} spent`,
  })
  entries.set(
    "/participants",
    balanceList.map((balance) => ({ id: balance.id, name: balance.name, paidLabel: `paid ${money(balance.paid)}` })),
  )
  entries.set("/participantsEmpty", when(trip.participants.length === 0, { title: "Nobody yet", description: "Add the people sharing costs on this trip." }))
  entries.set("/expenses/count", `${trip.expenses.length} expense${trip.expenses.length === 1 ? "" : "s"}`)
  entries.set("/expenses/empty", when(trip.expenses.length === 0, { title: "No expenses yet", description: "Add the first expense with the form above." }))
  const sorted = [...trip.expenses].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))
  entries.set(
    "/expenses/table",
    sorted.map((expense) => {
      const shares = [...splitEvenly(expense.amount, expense.splitAmong).values()]
      const min = Math.min(...shares)
      const max = Math.max(...shares)
      return {
        date: formatDate(expense.date),
        description: expense.description,
        category: categoryLabel(expense.category),
        payer: participantName(trip, expense.payer),
        split: expense.splitAmong.length === trip.participants.length ? "Everyone" : expense.splitAmong.map((id) => participantName(trip, id)).join(", "),
        amount: money(expense.amount),
        each: min === max ? money(min) : `${money(min)}–${money(max)}`,
      }
    }),
  )
  entries.set(
    "/expenses/items",
    sorted.map((expense) => ({ id: expense.id, label: `${formatDate(expense.date)} · ${expense.description} · ${money(expense.amount)}` })),
  )
  entries.set("/overall", {
    percent: Math.min(100, budgetTotal === 0 ? 0 : Math.round((total / budgetTotal) * 100)),
    label: `${money(total)} of ${money(budgetTotal)} total budget`,
  })
  totals.forEach((row, index) => {
    entries.set(`/categories/${index}/id`, row.id)
    entries.set(`/categories/${index}/label`, row.label)
    entries.set(`/categories/${index}/percent`, Math.min(100, row.percent))
    entries.set(`/categories/${index}/progressLabel`, `${money(row.spent)} of ${money(row.budget)} (${row.percent}%)`)
    entries.set(`/categories/${index}/status`, row.over ? `${money(row.spent - row.budget)} over` : `${money(row.budget - row.spent)} left`)
    entries.set(`/categories/${index}/over`, when(row.over, { text: "Over budget" }))
  })
  entries.set(
    "/balances",
    balanceList.map((balance) => ({
      name: balance.name,
      detail: `paid ${money(balance.paid)} · share ${money(balance.share)}`,
      owed: when(balance.net > 0, { text: `is owed ${money(balance.net)}` }),
      owes: balance.net < 0 ? [{ text: `owes ${money(-balance.net)}` }] : when(balance.net === 0, { text: "settled up" }),
    })),
  )
  entries.set("/settleCaption", transfers.length === 0 ? "No transfers needed." : `${transfers.length} transfer${transfers.length === 1 ? "" : "s"} settle every balance, largest debts first.`)
  entries.set(
    "/transfers",
    transfers.map((transfer) => ({ text: `${participantName(trip, transfer.from)} pays ${participantName(trip, transfer.to)} ${money(transfer.amount)}` })),
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
  let data: Json = { currency: [trip.currency], newParticipant: "", draft: emptyDraft(trip, today) }
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
    if (JSON.stringify(shown.get(pointer)) !== JSON.stringify(value)) messages.push(update(surfaceId, pointer, value))
  }
  return messages
}
