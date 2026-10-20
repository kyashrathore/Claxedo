/// <reference types="bun" />
import { expect, test } from "bun:test"
import { INTERACTIVE_AUTH_METHODS } from "@claxedo/account-contract/auth"
import { z } from "zod"
import { exactHttps, readCookieContract, readLiveBrowserAuthDescriptor } from "./browser-auth-descriptor"

const text = z.string().refine((value) => value.trim().length > 0)
const uniqueTexts = z.array(text).refine((values) => new Set(values).size === values.length)
const httpsUrl = text.refine((value) => exactHttps(value))
const zodDescriptor = z.object({
  adapter: z.literal("better-auth"),
  deploymentId: text,
  configurationVersion: text,
  expiresAt: z.number().finite().refine((value) => value > Date.now()),
  issuer: httpsUrl,
  methods: z.array(z.enum(INTERACTIVE_AUTH_METHODS)).nonempty().refine((values) => new Set(values).size === values.length),
  browser: z.object({
    transport: z.literal("cookie"),
    credentialPolicy: z.literal("reject-cookie-and-authorization"),
    trustedOrigins: uniqueTexts.refine((values) => values.every((value) => exactHttps(value, true))),
    clientId: text,
    resource: httpsUrl,
    scopes: uniqueTexts.refine((values) => values.length > 0),
    cookie: z.unknown().optional(),
  }),
})
const zodCookie = z.object({
  name: text,
  path: z.literal("/"),
  secure: z.literal(true),
  httpOnly: z.literal(true),
  hostOnly: z.literal(true),
  sameSite: z.enum(["lax", "strict"]),
})

const api = "https://api.claxedo.test"
const app = "https://app.claxedo.test"

const validCookie = () => ({ name: "session", path: "/", secure: true, httpOnly: true, hostOnly: true, sameSite: "lax" })

const valid = () => ({
  adapter: "better-auth",
  deploymentId: "deployment",
  configurationVersion: "1",
  expiresAt: Date.now() + 3_600_000,
  issuer: `${api}/api/auth`,
  methods: ["email-password", "github"],
  browser: {
    transport: "cookie",
    credentialPolicy: "reject-cookie-and-authorization",
    trustedOrigins: [app],
    clientId: "web",
    resource: api,
    scopes: ["openid"],
    cookie: validCookie(),
  },
})

class Box {
  readonly value = 1
}

const substitutes: readonly unknown[] = [
  undefined,
  null,
  0,
  1,
  -1,
  1.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  Number.MAX_SAFE_INTEGER,
  1e308,
  Date.now() - 1,
  Date.now() + 3_600_000,
  "",
  " ",
  "\t\n",
  "x",
  "better-auth",
  "cookie",
  "reject-cookie-and-authorization",
  "google",
  "/",
  "lax",
  "strict",
  "none",
  api,
  app,
  `${api}/`,
  `${api}/api/auth`,
  `${api}/api/auth/`,
  `${api}?q=1`,
  `${api}#x`,
  "https://user:pw@api.claxedo.test",
  "https://API.claxedo.test",
  "https://api.claxedo.test:443",
  "http://api.claxedo.test",
  "https://api.claxedo.test/a b",
  "not a url",
  true,
  false,
  [],
  [""],
  [" "],
  ["x"],
  ["x", "x"],
  ["x", "y"],
  ["google"],
  ["google", "google"],
  ["google", "x"],
  ["google", "github", "email-password"],
  [app],
  [app, app],
  [app, api],
  [app, `${app}/`],
  [app, "http://app.claxedo.test"],
  [1],
  [null],
  {},
  { a: 1 },
  Object.create(null),
  new Date(),
  new Map(),
  new Box(),
  new String("x"),
  new Number(1),
  Symbol("x"),
  10n,
  () => "x",
  validCookie(),
  { ...validCookie(), extra: true },
  { ...validCookie(), sameSite: "strict" },
  { ...validCookie(), sameSite: "none" },
  { ...validCookie(), secure: false },
  { ...validCookie(), httpOnly: "true" },
  { ...validCookie(), hostOnly: 1 },
  { ...validCookie(), path: "/a" },
  { ...validCookie(), name: "" },
  { ...validCookie(), name: undefined },
]

function sameVerdict(input: unknown): void {
  const zod = zodDescriptor.safeParse(input)
  const guard = readLiveBrowserAuthDescriptor(input)
  if (zod.success) expect(guard).toStrictEqual(zod.data)
  else expect(guard).toBeUndefined()
}

function sameCookieVerdict(input: unknown): void {
  const zod = zodCookie.safeParse(input)
  const guard = readCookieContract(input)
  if (zod.success) expect(guard).toStrictEqual(zod.data)
  else expect(guard).toBeUndefined()
}

function mutated<T extends Record<string, unknown>>(base: T, key: string, value: unknown): T {
  return { ...base, [key]: value }
}

function without<T extends Record<string, unknown>>(base: T, key: string): T {
  const copy = { ...base }
  delete copy[key]
  return copy
}

test("the descriptor guard accepts the live descriptor exactly as the zod schema did, stripping unknown keys", () => {
  const descriptor = valid()
  expect(zodDescriptor.safeParse(descriptor).success).toBe(true)
  sameVerdict(descriptor)
  sameVerdict({ ...descriptor, extra: 1, browser: { ...descriptor.browser, extra: 2 } })
  sameVerdict({ ...descriptor, browser: without(descriptor.browser, "cookie") })
  sameVerdict({ ...descriptor, browser: mutated(descriptor.browser, "cookie", undefined) })
  sameVerdict({ ...descriptor, browser: mutated(descriptor.browser, "cookie", null) })
  sameVerdict({ ...descriptor, browser: mutated(descriptor.browser, "cookie", "x") })
  sameVerdict(Object.assign(Object.create(null), descriptor))
  sameVerdict(Object.create(descriptor))
  sameVerdict({ ...descriptor, browser: Object.create(descriptor.browser) })
})

test("the descriptor guard refuses every whole-value substitute the zod schema refuses", () => {
  let refused = 0
  for (const value of substitutes) {
    sameVerdict(value)
    if (!readLiveBrowserAuthDescriptor(value)) refused += 1
  }
  expect(refused).toBe(substitutes.length)
})

test("the descriptor guard matches the zod schema on every top-level field substitution and deletion", () => {
  const descriptor = valid()
  let accepted = 0
  for (const key of Object.keys(descriptor)) {
    sameVerdict(without(descriptor, key))
    for (const value of substitutes) {
      const input = mutated(descriptor, key, value)
      sameVerdict(input)
      if (readLiveBrowserAuthDescriptor(input)) accepted += 1
    }
  }
  expect(accepted).toBeGreaterThan(0)
})

test("the descriptor guard matches the zod schema on every browser field substitution and deletion", () => {
  const descriptor = valid()
  let accepted = 0
  for (const key of Object.keys(descriptor.browser)) {
    sameVerdict({ ...descriptor, browser: without(descriptor.browser, key) })
    for (const value of substitutes) {
      const input = { ...descriptor, browser: mutated(descriptor.browser, key, value) }
      sameVerdict(input)
      if (readLiveBrowserAuthDescriptor(input)) accepted += 1
    }
  }
  expect(accepted).toBeGreaterThan(0)
})

test("the descriptor guard refuses an expiry at or before now and accepts one after it, like the zod schema", () => {
  const descriptor = valid()
  const now = Date.now()
  for (const expiresAt of [now - 1, now - 100_000, 0, -1, now + 100_000]) sameVerdict(mutated(descriptor, "expiresAt", expiresAt))
  expect(readLiveBrowserAuthDescriptor(mutated(descriptor, "expiresAt", now - 1))).toBeUndefined()
  expect(readLiveBrowserAuthDescriptor(mutated(descriptor, "expiresAt", now + 100_000))).toBeDefined()
})

test("the cookie guard matches the zod cookie schema on every substitute, field substitution and deletion", () => {
  const cookie = validCookie()
  sameCookieVerdict(cookie)
  sameCookieVerdict({ ...cookie, extra: 1 })
  sameCookieVerdict(Object.create(cookie))
  let accepted = 0
  for (const value of substitutes) sameCookieVerdict(value)
  for (const key of Object.keys(cookie)) {
    sameCookieVerdict(without(cookie, key))
    for (const value of substitutes) {
      const input = mutated(cookie, key, value)
      sameCookieVerdict(input)
      if (readCookieContract(input)) accepted += 1
    }
  }
  expect(accepted).toBeGreaterThan(0)
})

test("exactHttps accepts only canonical HTTPS origins and paths without credentials, query or fragment", () => {
  expect(exactHttps(api, true)).toBe(true)
  expect(exactHttps(`${api}/api/auth`)).toBe(true)
  expect(exactHttps(`${api}/api/auth`, true)).toBe(false)
  expect(exactHttps(`${api}/`)).toBe(false)
  expect(exactHttps("http://api.claxedo.test", true)).toBe(false)
  expect(exactHttps("https://API.claxedo.test", true)).toBe(false)
  expect(exactHttps(`${api}?q=1`)).toBe(false)
  expect(exactHttps(`${api}#x`)).toBe(false)
  expect(exactHttps("https://user:pw@api.claxedo.test", true)).toBe(false)
  expect(exactHttps("not a url")).toBe(false)
})
