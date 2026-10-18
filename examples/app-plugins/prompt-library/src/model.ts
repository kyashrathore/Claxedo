import { BUILT_IN_CATEGORIES, type PromptTemplate, type Variable } from "./library"

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

export type Library = {
  readonly templates: readonly PromptTemplate[]
  readonly favourites: readonly string[]
  readonly usage: Readonly<Record<string, number>>
}

export type Values = Readonly<Record<string, string>>

const PLACEHOLDER = /\{([A-Za-z][\w-]*)\}/g

export function placeholders(body: string): string[] {
  const names: string[] = []
  for (const match of body.matchAll(PLACEHOLDER)) if (!names.includes(match[1]!)) names.push(match[1]!)
  return names
}

export function labelFor(name: string): string {
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[-_]+/g, " ").trim().toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

export function fillPrompt(body: string, values: Values): string {
  return body.replace(PLACEHOLDER, (whole, name: string) => values[name]?.trim() || whole)
}

export function missingVariables(template: PromptTemplate, values: Values): string[] {
  return template.variables.filter((variable) => !values[variable.name]?.trim()).map((variable) => variable.name)
}

export function previewMarkdown(template: PromptTemplate, values: Values): string {
  const missing = missingVariables(template, values)
  const note = missing.length === 0 ? "_All variables filled._" : `_Still to fill: ${missing.map((name) => `\`{${name}}\``).join(", ")}_`
  const quoted = fillPrompt(template.body, values)
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n")
  return `${quoted}\n\n${note}`
}

export function categoriesOf(templates: readonly PromptTemplate[]): string[] {
  const extra = templates.map((template) => template.category).filter((category) => !BUILT_IN_CATEGORIES.includes(category))
  return [...BUILT_IN_CATEGORIES, ...new Set(extra)]
}

export function usageLabel(count: number): string {
  return count === 0 ? "Not used yet" : `Used ${count}×`
}

export type Card = {
  readonly id: string
  readonly name: string
  readonly category: string
  readonly summary: string
  readonly usage: string
  readonly favourite: boolean
}

export function card(library: Library, template: PromptTemplate): Card {
  return {
    id: template.id,
    name: template.name,
    category: template.category,
    summary: template.description.split("\n")[0] ?? "",
    usage: usageLabel(library.usage[template.id] ?? 0),
    favourite: library.favourites.includes(template.id),
  }
}

export type LibraryView = {
  readonly header: string
  readonly favouritesTitle: string
  readonly favourites: Card[]
  readonly tabs: { title: string; items: Card[] }[]
}

export function libraryView(library: Library): LibraryView {
  const uses = Object.values(library.usage).reduce((sum, count) => sum + count, 0)
  const favourites = library.templates.filter((template) => library.favourites.includes(template.id)).map((template) => card(library, template))
  return {
    header: `${library.templates.length} templates · ${favourites.length} favourites · ${uses} sent`,
    favouritesTitle: `★ Favourites (${favourites.length})`,
    favourites,
    tabs: categoriesOf(library.templates).map((category) => {
      const items = library.templates.filter((template) => template.category === category).map((template) => card(library, template))
      return { title: `${category} (${items.length})`, items }
    }),
  }
}

export type SelectedView = {
  readonly id: string
  readonly name: string
  readonly category: string
  readonly description: string
  readonly usage: string
  readonly variables: string
}

export function selectedView(library: Library, template: PromptTemplate): SelectedView {
  const count = template.variables.length
  return {
    id: template.id,
    name: template.name,
    category: template.category,
    description: template.description,
    usage: usageLabel(library.usage[template.id] ?? 0),
    variables: count === 0 ? "No variables" : `${count} variable${count === 1 ? "" : "s"}`,
  }
}

function seenFavourites(snapshot: Json | undefined, into: Map<string, boolean[]>): void {
  if (Array.isArray(snapshot)) {
    for (const item of snapshot) seenFavourites(item, into)
    return
  }
  if (!snapshot || typeof snapshot !== "object") return
  if (typeof snapshot.id === "string" && typeof snapshot.favourite === "boolean") {
    into.set(snapshot.id, [...(into.get(snapshot.id) ?? []), snapshot.favourite])
    return
  }
  for (const value of Object.values(snapshot)) seenFavourites(value, into)
}

export function syncFavourites(library: Library, snapshots: readonly (Json | undefined)[]): Library {
  const seen = new Map<string, boolean[]>()
  for (const snapshot of snapshots) seenFavourites(snapshot, seen)
  const favourites = library.templates
    .map((template) => template.id)
    .filter((id) => {
      const was = library.favourites.includes(id)
      const values = seen.get(id) ?? []
      return values.some((value) => value !== was) ? !was : was
    })
  return { ...library, favourites }
}

export function recordUse(library: Library, id: string): Library {
  return { ...library, usage: { ...library.usage, [id]: (library.usage[id] ?? 0) + 1 } }
}

export type Draft = {
  readonly name: string
  readonly category: string
  readonly newCategory: string
  readonly description: string
  readonly body: string
}

export type DraftCheck = { readonly errors: string[]; readonly variables: string[] }

export function checkDraft(draft: Draft, templates: readonly PromptTemplate[]): DraftCheck {
  const errors: string[] = []
  const name = draft.name.trim()
  if (!name) errors.push("Give the template a name.")
  else if (templates.some((template) => template.name.toLowerCase() === name.toLowerCase())) errors.push(`A template named “${name}” already exists.`)
  if (!draft.newCategory.trim() && !draft.category.trim()) errors.push("Pick a category or type a new one.")
  if (!draft.body.trim()) errors.push("Write the prompt body.")
  const malformed = [...draft.body.matchAll(/\{([^{}]*)\}/g)].map((match) => match[1]!).filter((inner) => !/^[A-Za-z][\w-]*$/.test(inner))
  if (malformed.length > 0) errors.push(`Variable names start with a letter and use letters, digits, - or _: ${malformed.map((inner) => `{${inner}}`).join(", ")}.`)
  return { errors, variables: placeholders(draft.body) }
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "template"
}

export function templateFromDraft(draft: Draft, templates: readonly PromptTemplate[]): PromptTemplate {
  const base = `custom-${slug(draft.name)}`
  const taken = new Set(templates.map((template) => template.id))
  let id = base
  for (let suffix = 2; taken.has(id); suffix++) id = `${base}-${suffix}`
  const variables: Variable[] = placeholders(draft.body).map((name) => ({ name, label: labelFor(name) }))
  return {
    id,
    name: draft.name.trim(),
    category: draft.newCategory.trim() || draft.category.trim(),
    description: draft.description.trim() || "_Your own template._",
    body: draft.body.trim(),
    variables,
  }
}

function text(value: Json | undefined): string {
  return typeof value === "string" ? value : ""
}

export function firstText(value: Json | undefined): string {
  return Array.isArray(value) ? text(value[0]) : text(value)
}

export function readValues(value: Json | undefined): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => (typeof entry === "string" ? [[key, entry]] : [])))
}

export function readDraft(context: Readonly<Record<string, Json>>): Draft {
  return {
    name: text(context.name),
    category: firstText(context.category),
    newCategory: text(context.newCategory),
    description: text(context.description),
    body: text(context.body),
  }
}

export function valuesFor(template: PromptTemplate, saved: Values): Record<string, string> {
  return Object.fromEntries(template.variables.map((variable) => [variable.name, saved[variable.name] ?? ""]))
}

export function sessionTitle(template: PromptTemplate, title: string): string {
  return title.trim() || template.name
}

export function codeSnippet(input: { projectId: string; title: string; prompt: string }): string {
  return [
    "const ref = await api.sessions.create({",
    `  projectId: ${JSON.stringify(input.projectId)},`,
    `  title: ${JSON.stringify(input.title)},`,
    `  prompt: ${JSON.stringify(input.prompt)},`,
    "})",
    "api.sessions.open(ref)",
  ].join("\n")
}

export type Patch = { readonly path: string; readonly value: Json }

function escapeKey(key: string): string {
  return key.replaceAll("~", "~0").replaceAll("/", "~1")
}

function isRecord(value: Json): value is { [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function diffPatches(path: string, previous: Json, next: Json): Patch[] {
  if (JSON.stringify(previous) === JSON.stringify(next)) return []
  if (Array.isArray(previous) && Array.isArray(next) && previous.length === next.length) {
    return next.flatMap((item, index) => diffPatches(`${path}/${index}`, previous[index]!, item))
  }
  if (isRecord(previous) && isRecord(next)) {
    const keys = Object.keys(next)
    const sameKeys = keys.length === Object.keys(previous).length && keys.every((key) => key in previous)
    if (sameKeys) return keys.flatMap((key) => diffPatches(`${path}/${escapeKey(key)}`, previous[key]!, next[key]!))
  }
  return [{ path: path || "/", value: next }]
}
