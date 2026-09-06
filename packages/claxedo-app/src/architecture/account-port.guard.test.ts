import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { HOSTED_OPERATIONS as appOperations } from "../platform/account/hosted-operations"
import { HOSTED_OPERATIONS as mainOperations } from "../../../claxedo-desktop/src/main/account/hosted-operations"

/**
 * GUARD: the account boundary stays a closed, credential-free operation set.
 *
 * Four artefacts describe the same set of hosted operations — the renderer
 * port's `HostedOperationName` union, the app's decoder registry, Electron
 * main's route table, and the reviewed matrix document. Each can drift on its
 * own, and the port can quietly regain a request-shaped escape hatch
 * (`run(url, method, body)`) that turns the closed set into decoration. This
 * guard holds all four in agreement and refuses the escape hatches.
 *
 * The port is read syntactically rather than by spelling: comments, quote
 * style and layout are normalized away before the union and object members are
 * read, so a reviewer cannot hide a widened member behind a comment and a
 * formatter cannot break the guard. There is no TypeScript parser available
 * in this repository (the `typescript` package is the native TS 7 build, which
 * exposes no `createSourceFile`), so the reader is a small tokenizer scoped to
 * the three declarations it cares about and fails loudly when a declaration
 * is missing or shaped unexpectedly.
 */

const source = readFileSync(path.join(import.meta.dir, "../platform/account/account-port.ts"), "utf8")
const matrix = readFileSync(
  path.resolve(import.meta.dir, "../../../../docs/tech-docs/desktop-hosted-operation-matrix.md"),
  "utf8",
)
const matrixNames = [
  ...new Set([...matrix.matchAll(/^\| `([a-zA-Z][\w.]*\.[\w.]*)` \|/gm)].map((match) => match[1])),
].toSorted()

/** Strips comments and normalizes quotes so only syntax is left to read. */
function normalize(text: string) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^[ \t]*\/\/.*$/gm, " ")
    .replaceAll("'", '"')
}

/** The right-hand side of `export type <name> = ...`, ending at the next top-level declaration. */
function alias(text: string, name: string) {
  const pattern = new RegExp(`^export type ${name}\\b[^=]*=([\\s\\S]*?)(?=^export |^import |\\s*$(?![\\s\\S]))`, "gm")
  const matches = [...text.matchAll(pattern)]
  if (matches.length !== 1) throw new Error(`Expected one ${name} declaration`)
  return matches[0][1].trim()
}

/** Splits on `separator` only outside brackets, so `Record<string, unknown>` stays one parameter. */
function splitTopLevel(text: string, separator: string) {
  const parts: string[] = []
  let depth = 0
  let current = ""
  let previous = ""
  for (const char of text) {
    if (char === "{" || char === "(" || char === "<" || char === "[") depth += 1
    if (char === "}" || char === ")" || (char === ">" && previous !== "=") || char === "]") depth -= 1
    previous = char
    if (depth === 0 && char === separator) {
      parts.push(current)
      current = ""
      continue
    }
    current += char
  }
  parts.push(current)
  return parts.map((part) => part.trim()).filter(Boolean)
}

/** Member names of an object type literal `{ a: T; b?: U }` at brace depth one. */
function members(body: string, name: string, problems: string[]) {
  if (!body.startsWith("{") || !body.endsWith("}")) {
    problems.push(`${name} must declare its reviewed members directly`)
    return [] as { name: string; type: string }[]
  }
  const found: { name: string; type: string }[] = []
  for (const entry of splitTopLevel(body.slice(1, -1).replaceAll(";", "\n"), "\n")) {
    const match = entry.match(/^("?[A-Za-z_$][\w$]*"?)\??\s*:\s*([\s\S]+)$/)
    if (!match) {
      problems.push(`${name} has an unreviewed member`)
      continue
    }
    found.push({ name: match[1].replaceAll('"', ""), type: match[2].trim() })
  }
  return found
}

function inspectPort(text: string) {
  const clean = normalize(text)
  const problems: string[] = []

  const union = alias(clean, "HostedOperationName")
  const operations: string[] = []
  for (const raw of union.split("|")) {
    const member = raw.trim()
    if (!member) continue
    const literal = member.match(/^"([^"]+)"$/)
    if (literal) operations.push(literal[1])
    else problems.push("HostedOperationName must contain only explicit string literals")
  }
  if (!operations.length) problems.push("HostedOperationName cannot be empty")

  const reviewed = (name: string, allowed: string[]) => {
    const found = members(alias(clean, name), name, problems)
    for (const member of found) if (!allowed.includes(member.name)) problems.push(`${name}.${member.name} is unreviewed`)
    for (const expected of allowed) if (!found.some((member) => member.name === expected)) problems.push(`Missing ${expected}`)
    return found
  }
  const port = reviewed("AccountPort", ["state", "signIn", "signOut", "run"])
  const run = port.find((member) => member.name === "run")?.type ?? ""
  const runParameters = run.match(/^<[^>]*>\s*\(([\s\S]*?)\)\s*=>/)?.[1] ?? run.match(/^\(([\s\S]*?)\)\s*=>/)?.[1]
  const parameters = splitTopLevel(runParameters ?? "", ",")
  if (parameters.length !== 2 || !/^operation\s*:\s*HostedOperationName$/.test(parameters[0] ?? "")) {
    problems.push("AccountPort.run must accept a HostedOperationName and operation input")
  }
  for (const member of reviewed("AccountIdentity", ["userId", "displayName", "email", "orgId", "orgName", "method"])) {
    if (member.type !== "string") problems.push("AccountIdentity values must be display strings")
  }

  return { problems, operations: [...new Set(operations)].toSorted() }
}

function mutate(before: string, after: string) {
  if (!source.includes(before)) throw new Error(`Mutation anchor missing: ${before}`)
  return source.replace(before, after)
}

describe("the reviewed account boundary", () => {
  test("the closed port, app decoders, main routes and reviewed matrix name the same operations", () => {
    const result = inspectPort(source)
    expect(result.problems).toEqual([])
    expect(matrixNames.length).toBeGreaterThan(0)
    expect(result.operations).toEqual(matrixNames)
    expect(Object.keys(appOperations).toSorted()).toEqual(matrixNames)
    expect(Object.keys(mainOperations).toSorted()).toEqual(matrixNames)
  })

  test("app registry rows express decoding and retry safety only", () => {
    for (const [name, operation] of Object.entries(appOperations)) {
      expect(Object.keys(operation).toSorted(), name).toEqual(["decode", "safe"])
      expect(typeof operation.decode, name).toBe("function")
      expect(typeof operation.safe, name).toBe("boolean")
    }
  })

  test.each(["string", "any", "unknown", "`workspace.${number}`", "`arbitrary.operation`", "UnreviewedNames"])(
    "rejects a union widened with %s",
    (type) => {
      const result = inspectPort(mutate('  | "account.mode"', `  | "account.mode"\n  | ${type}`))
      expect(result.problems).toContain("HostedOperationName must contain only explicit string literals")
    },
  )

  test("detects a new closed operation absent from the reviewed matrix", () => {
    const result = inspectPort(mutate('  | "account.mode"', '  | "account.mode"\n  | "hostedFetch.any"'))
    expect(result.problems).toEqual([])
    expect(result.operations.filter((name) => !matrixNames.includes(name))).toEqual(["hostedFetch.any"])
  })

  test("runs the credential guard on same-line port and identity additions", () => {
    expect(
      inspectPort(mutate("signOut: () => Promise<void>", "signOut: () => Promise<void>; getToken: () => string")).problems,
    ).toContain("AccountPort.getToken is unreviewed")
    expect(inspectPort(mutate("userId: string", "userId: string; token: string")).problems).toContain(
      "AccountIdentity.token is unreviewed",
    )
  })

  test("rejects a non-string identity value", () => {
    expect(inspectPort(mutate("email?: string", "email?: { address: string; token: string }")).problems).toContain(
      "AccountIdentity values must be display strings",
    )
  })

  test("rejects request-shaped run signatures and index-signature escape hatches", () => {
    expect(inspectPort(mutate("operation: HostedOperationName", "url: string")).problems).toContain(
      "AccountPort.run must accept a HostedOperationName and operation input",
    )
    expect(inspectPort(mutate("export type AccountPort = {", "export type AccountPort = { [key: string]: unknown;")).problems).toContain(
      "AccountPort has an unreviewed member",
    )
  })

  test("missing declarations cannot silently produce an empty passing inventory", () => {
    expect(() =>
      inspectPort(source.replace("export type HostedOperationName =", "export type RemovedOperationName =")),
    ).toThrow("Expected one HostedOperationName declaration")
  })

  test("a comment cannot hide a widened member", () => {
    const hidden = mutate('  | "account.mode"', '  | "account.mode"\n  | string // reviewed, honest')
    expect(inspectPort(hidden).problems).toContain("HostedOperationName must contain only explicit string literals")
  })

  test("accepts equivalent quotes, comments and layout", () => {
    const formatted = source
      .replaceAll(/"([^"\n]*)"/g, "'$1'")
      .replace("export type HostedOperationName =", "export type HostedOperationName /* closed */ =")
    expect(inspectPort(formatted)).toEqual(inspectPort(source))
  })
})
