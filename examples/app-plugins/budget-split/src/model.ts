export const CURRENCIES = [
  { id: "EUR", label: "Euro (€)", locale: "en-IE", budgetMax: 5000, budgetStep: 50 },
  { id: "USD", label: "US dollar ($)", locale: "en-US", budgetMax: 5000, budgetStep: 50 },
  { id: "INR", label: "Indian rupee (₹)", locale: "en-IN", budgetMax: 400000, budgetStep: 1000 },
] as const

export type CurrencyId = (typeof CURRENCIES)[number]["id"]
export type Currency = (typeof CURRENCIES)[number]

export const CATEGORIES = [
  { id: "lodging", label: "Lodging" },
  { id: "food", label: "Food & drink" },
  { id: "transport", label: "Transport" },
  { id: "activities", label: "Activities" },
  { id: "other", label: "Other" },
] as const

export type CategoryId = (typeof CATEGORIES)[number]["id"]

export const MAX_PARTICIPANTS = 12
export const MAX_AMOUNT_CENTS = 1_000_000_000

export type Participant = { readonly id: string; readonly name: string }

export type Expense = {
  readonly id: string
  readonly description: string
  readonly amount: number
  readonly payer: string
  readonly splitAmong: readonly string[]
  readonly category: CategoryId
  readonly date: string
}

export type Trip = {
  readonly name: string
  readonly currency: CurrencyId
  readonly participants: readonly Participant[]
  readonly expenses: readonly Expense[]
  readonly budgets: Readonly<Record<CategoryId, number>>
  readonly nextId: number
}

export type TripResult = { readonly ok: true; readonly trip: Trip; readonly message: string } | { readonly ok: false; readonly error: string }

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value))
}

function firstChoice(value: unknown): string | undefined {
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : undefined
  return typeof value === "string" && value !== "" ? value : undefined
}

export function currencyOf(id: CurrencyId): Currency {
  return CURRENCIES.find((currency) => currency.id === id) ?? CURRENCIES[0]
}

export function categoryLabel(id: CategoryId): string {
  return CATEGORIES.find((category) => category.id === id)?.label ?? id
}

export function isCategory(value: unknown): value is CategoryId {
  return CATEGORIES.some((category) => category.id === value)
}

export function formatMoney(cents: number, currency: CurrencyId): string {
  const { locale } = currencyOf(currency)
  return new Intl.NumberFormat(locale, { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100)
}

const DECIMAL = /^(\d+)(?:\.(\d*))?$/

function normalizeSeparators(raw: string): string | undefined {
  const text = raw.trim().replace(/[\s_']/g, "")
  const comma = text.lastIndexOf(",")
  const dot = text.lastIndexOf(".")
  if (comma === -1) return text
  if (dot === -1) {
    const decimals = text.length - comma - 1
    if (text.indexOf(",") === comma && decimals > 0 && decimals <= 2) return text.replace(",", ".")
    return /^\d{1,3}(,\d{3})+$/.test(text) ? text.replaceAll(",", "") : undefined
  }
  if (comma < dot) return /^\d{1,3}(,\d{3})*\.\d*$/.test(text) ? text.replaceAll(",", "") : undefined
  return /^\d{1,3}(\.\d{3})*,\d*$/.test(text) ? text.replaceAll(".", "").replace(",", ".") : undefined
}

export function parseAmount(value: unknown): { ok: true; cents: number } | { ok: false; error: string } {
  const text = typeof value === "number" ? (Number.isFinite(value) ? value.toFixed(6) : "") : typeof value === "string" ? value : ""
  if (text.trim() === "") return { ok: false, error: "Enter an amount." }
  if (text.trim().startsWith("-")) return { ok: false, error: "The amount must be positive." }
  const normalized = normalizeSeparators(text)
  const match = normalized === undefined ? null : DECIMAL.exec(normalized)
  if (!match) return { ok: false, error: `“${text.trim()}” is not an amount.` }
  const whole = Number(match[1])
  const fraction = (match[2] ?? "").padEnd(3, "0")
  const cents = whole * 100 + Number(fraction.slice(0, 2)) + (Number(fraction[2]) >= 5 ? 1 : 0)
  if (cents <= 0) return { ok: false, error: "The amount must be at least one cent." }
  if (cents > MAX_AMOUNT_CENTS) return { ok: false, error: "That amount is too large for one expense." }
  return { ok: true, cents }
}

export function splitEvenly(cents: number, ids: readonly string[]): ReadonlyMap<string, number> {
  const shares = new Map<string, number>()
  if (ids.length === 0) return shares
  const base = Math.floor(cents / ids.length)
  const remainder = cents - base * ids.length
  ids.forEach((id, index) => shares.set(id, base + (index < remainder ? 1 : 0)))
  return shares
}

export type Balance = { readonly id: string; readonly name: string; readonly paid: number; readonly share: number; readonly net: number }

export function balances(trip: Trip): readonly Balance[] {
  const paid = new Map<string, number>()
  const share = new Map<string, number>()
  for (const expense of trip.expenses) {
    paid.set(expense.payer, (paid.get(expense.payer) ?? 0) + expense.amount)
    for (const [id, cents] of splitEvenly(expense.amount, expense.splitAmong)) share.set(id, (share.get(id) ?? 0) + cents)
  }
  return trip.participants.map((participant) => {
    const p = paid.get(participant.id) ?? 0
    const s = share.get(participant.id) ?? 0
    return { id: participant.id, name: participant.name, paid: p, share: s, net: p - s }
  })
}

export type Transfer = { readonly from: string; readonly to: string; readonly amount: number }

export function settle(balanceList: readonly Balance[]): readonly Transfer[] {
  const order = new Map(balanceList.map((balance, index) => [balance.id, index]))
  const byAmount = (a: { id: string; left: number }, b: { id: string; left: number }) => b.left - a.left || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)
  const creditors = balanceList.filter((balance) => balance.net > 0).map((balance) => ({ id: balance.id, left: balance.net }))
  const debtors = balanceList.filter((balance) => balance.net < 0).map((balance) => ({ id: balance.id, left: -balance.net }))
  const transfers: Transfer[] = []
  while (creditors.length > 0 && debtors.length > 0) {
    creditors.sort(byAmount)
    debtors.sort(byAmount)
    const creditor = creditors[0]!
    const debtor = debtors[0]!
    const amount = Math.min(creditor.left, debtor.left)
    transfers.push({ from: debtor.id, to: creditor.id, amount })
    creditor.left -= amount
    debtor.left -= amount
    if (creditor.left === 0) creditors.shift()
    if (debtor.left === 0) debtors.shift()
  }
  return transfers
}

export type CategoryTotal = { readonly id: CategoryId; readonly label: string; readonly spent: number; readonly budget: number; readonly percent: number; readonly over: boolean }

export function categoryTotals(trip: Trip): readonly CategoryTotal[] {
  return CATEGORIES.map((category) => {
    const spent = trip.expenses.filter((expense) => expense.category === category.id).reduce((sum, expense) => sum + expense.amount, 0)
    const budget = trip.budgets[category.id]
    const percent = budget === 0 ? (spent === 0 ? 0 : 100) : Math.round((spent / budget) * 100)
    return { id: category.id, label: category.label, spent, budget, percent, over: spent > budget }
  })
}

export type Tone = "neutral" | "accent" | "success" | "warning" | "danger"

export type Status = { readonly label: string; readonly tone: Tone }

export function balanceStatus(balance: Balance, currency: CurrencyId): Status {
  if (balance.net > 0) return { label: `is owed ${formatMoney(balance.net, currency)}`, tone: "success" }
  if (balance.net < 0) return { label: `owes ${formatMoney(-balance.net, currency)}`, tone: "warning" }
  return { label: "settled up", tone: "neutral" }
}

export function categoryStatus(row: CategoryTotal, currency: CurrencyId): Status {
  if (row.over) return { label: `${formatMoney(row.spent - row.budget, currency)} over`, tone: "danger" }
  return { label: `${formatMoney(row.budget - row.spent, currency)} left`, tone: row.percent >= 90 ? "warning" : "neutral" }
}

export function totalSpent(trip: Trip): number {
  return trip.expenses.reduce((sum, expense) => sum + expense.amount, 0)
}

export function participantName(trip: Trip, id: string): string {
  return trip.participants.find((participant) => participant.id === id)?.name ?? "Someone"
}

export function addParticipant(trip: Trip, raw: unknown): TripResult {
  const name = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : ""
  if (name === "") return { ok: false, error: "Type a name first." }
  if (name.length > 40) return { ok: false, error: "Keep names under 40 characters." }
  if (trip.participants.some((participant) => participant.name.toLocaleLowerCase() === name.toLocaleLowerCase())) return { ok: false, error: `${name} is already on the trip.` }
  if (trip.participants.length >= MAX_PARTICIPANTS) return { ok: false, error: `A trip holds at most ${MAX_PARTICIPANTS} people.` }
  const participant = { id: `p${trip.nextId}`, name }
  return { ok: true, trip: { ...trip, participants: [...trip.participants, participant], nextId: trip.nextId + 1 }, message: `${name} joined the trip.` }
}

export function removeParticipant(trip: Trip, id: string): TripResult {
  const participant = trip.participants.find((entry) => entry.id === id)
  if (!participant) return { ok: false, error: "That person is no longer on the trip." }
  const involved = trip.expenses.filter((expense) => expense.payer === id || expense.splitAmong.includes(id)).length
  if (involved > 0) return { ok: false, error: `${participant.name} is part of ${involved} expense${involved === 1 ? "" : "s"}. Delete or re-enter those first so the balances stay correct.` }
  return { ok: true, trip: { ...trip, participants: trip.participants.filter((entry) => entry.id !== id) }, message: `${participant.name} left the trip.` }
}

export function isIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return false
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  return date.toISOString().slice(0, 10) === value
}

export function addExpense(trip: Trip, raw: unknown): TripResult {
  const input = record(raw)
  const description = typeof input.description === "string" ? input.description.trim().replace(/\s+/g, " ") : ""
  if (description.length < 2) return { ok: false, error: "Describe the expense." }
  if (description.length > 80) return { ok: false, error: "Keep the description under 80 characters." }
  const amount = parseAmount(input.amount)
  if (!amount.ok) return { ok: false, error: amount.error }
  const payer = firstChoice(input.payer)
  if (!payer || !trip.participants.some((participant) => participant.id === payer)) return { ok: false, error: "Choose who paid." }
  const chosen = Array.isArray(input.split) ? input.split : []
  const splitAmong = trip.participants.map((participant) => participant.id).filter((id) => chosen.includes(id))
  if (splitAmong.length === 0) return { ok: false, error: "Choose at least one person to split with." }
  const category = firstChoice(input.category)
  if (!isCategory(category)) return { ok: false, error: "Choose a category." }
  const date = typeof input.date === "string" ? input.date.slice(0, 10) : ""
  if (!isIsoDate(date)) return { ok: false, error: "Choose the date of the expense." }
  const expense: Expense = { id: `e${trip.nextId}`, description, amount: amount.cents, payer, splitAmong, category, date }
  return {
    ok: true,
    trip: { ...trip, expenses: [...trip.expenses, expense], nextId: trip.nextId + 1 },
    message: `${participantName(trip, payer)} paid ${formatMoney(expense.amount, trip.currency)} for ${description}, split ${splitAmong.length} way${splitAmong.length === 1 ? "" : "s"}.`,
  }
}

export function deleteExpense(trip: Trip, id: string): TripResult {
  const expense = trip.expenses.find((entry) => entry.id === id)
  if (!expense) return { ok: false, error: "That expense no longer exists." }
  return { ok: true, trip: { ...trip, expenses: trip.expenses.filter((entry) => entry.id !== id) }, message: `Deleted ${expense.description}.` }
}

export function setBudgets(trip: Trip, rows: unknown): TripResult {
  if (!Array.isArray(rows)) return { ok: false, error: "No budgets were sent." }
  const { budgetMax } = currencyOf(trip.currency)
  const budgets = { ...trip.budgets }
  for (const row of rows) {
    const input = record(row)
    const blank = typeof input.budget === "string" && input.budget.trim() === ""
    const value = typeof input.budget === "number" ? input.budget : Number(input.budget)
    if (!isCategory(input.id) || blank || !Number.isFinite(value)) continue
    budgets[input.id] = Math.round(Math.min(budgetMax, Math.max(0, value)) * 100)
  }
  const total = CATEGORIES.reduce((sum, category) => sum + budgets[category.id], 0)
  return { ok: true, trip: { ...trip, budgets }, message: `Budgets saved: ${formatMoney(total, trip.currency)} in total.` }
}

export function setCurrency(trip: Trip, raw: unknown): TripResult {
  const id = firstChoice(raw)
  const currency = CURRENCIES.find((entry) => entry.id === id)
  if (!currency) return { ok: false, error: "Choose EUR, USD or INR." }
  return { ok: true, trip: { ...trip, currency: currency.id }, message: `Amounts now show in ${currency.label}.` }
}

function table(header: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const line = (cells: readonly string[]) => `| ${cells.map((cell) => cell.replaceAll("|", "\\|")).join(" | ")} |`
  return [line(header), line(header.map(() => "---")), ...rows.map(line)]
}

export function summaryMarkdown(trip: Trip): string {
  const money = (cents: number) => formatMoney(cents, trip.currency)
  const balanceList = balances(trip)
  const transfers = settle(balanceList)
  const total = totalSpent(trip)
  const name = (id: string) => participantName(trip, id)
  return [
    `# ${trip.name}`,
    "",
    `${trip.participants.length} people · ${trip.expenses.length} expenses · ${money(total)} total · ${money(trip.participants.length === 0 ? 0 : Math.round(total / trip.participants.length))} per person on average`,
    "",
    "## Spending by category",
    "",
    ...table(["Category", "Spent", "Budget", "Used"], categoryTotals(trip).map((row) => [row.label, money(row.spent), money(row.budget), `${row.percent}%${row.over ? " (over)" : ""}`])),
    "",
    "## Balances",
    "",
    ...table(["Person", "Paid", "Share", "Net"], balanceList.map((row) => [row.name, money(row.paid), money(row.share), `${row.net > 0 ? "+" : ""}${money(row.net)}`])),
    "",
    "## Settle up",
    "",
    ...(transfers.length === 0 ? ["Everyone is square."] : transfers.map((transfer) => `- ${name(transfer.from)} pays ${name(transfer.to)} ${money(transfer.amount)}`)),
    "",
  ].join("\n")
}

export function seedTrip(today: string): Trip {
  const day = (offset: number) => new Date(Date.parse(`${today}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10)
  const everyone = ["p1", "p2", "p3", "p4"]
  return {
    name: "Lisbon, long weekend",
    currency: "EUR",
    nextId: 20,
    participants: [
      { id: "p1", name: "Ana" },
      { id: "p2", name: "Ben" },
      { id: "p3", name: "Chloé" },
      { id: "p4", name: "Dev" },
    ],
    budgets: { lodging: 70000, food: 25000, transport: 8000, activities: 30000, other: 5000 },
    expenses: [
      { id: "e1", description: "Alfama apartment, 4 nights", amount: 64000, payer: "p1", splitAmong: everyone, category: "lodging", date: day(-4) },
      { id: "e2", description: "Airport taxi", amount: 3475, payer: "p4", splitAmong: everyone, category: "transport", date: day(-4) },
      { id: "e3", description: "Tram 28 day passes", amount: 2560, payer: "p2", splitAmong: everyone, category: "transport", date: day(-3) },
      { id: "e4", description: "Dinner at Taberna da Rua", amount: 14250, payer: "p3", splitAmong: everyone, category: "food", date: day(-3) },
      { id: "e5", description: "Pastéis de Belém", amount: 1890, payer: "p4", splitAmong: ["p1", "p2", "p4"], category: "food", date: day(-2) },
      { id: "e6", description: "Sintra day tour", amount: 18000, payer: "p2", splitAmong: ["p2", "p3", "p4"], category: "activities", date: day(-2) },
      { id: "e7", description: "Fado show", amount: 10000, payer: "p1", splitAmong: ["p1", "p3"], category: "activities", date: day(-1) },
      { id: "e8", description: "Groceries for the flat", amount: 4733, payer: "p3", splitAmong: everyone, category: "food", date: day(-1) },
    ],
  }
}
