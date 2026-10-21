import { AsyncLocalStorage } from "node:async_hooks"
import type { D1Database, D1DatabaseSession } from "@cloudflare/workers-types"
import {
  D1_BOOKMARK_COOKIE_PREFIX,
  D1_BOOKMARKS_HEADER,
  d1BookmarkCookie,
  isD1Bookmark,
  newerD1Bookmark,
  readD1Bookmarks,
  writeD1Bookmarks,
  type D1BookmarkName,
} from "@claxedo/agent-runtime-contract"

/**
 * Where a scope's D1 sessions begin.
 *
 * `primary`: the first statement goes to the primary, so every read sees every
 * write committed before it, whoever made it. `replica`: the first statement
 * may be answered by the nearest read replica no older than the bookmark the
 * caller carries, so the caller sees its own earlier writes and every change
 * a notice it acted on announced, but may miss another actor's newest ones.
 * Later statements of either go to "any replica that is consistent with the
 * bookmark maintained by the session" (workers-types `D1SessionConstraint`;
 * developers.cloudflare.com/d1/best-practices/read-replication/).
 */
export type D1SessionStart = "primary" | "replica"

type Scope = {
  start: D1SessionStart
  bookmarks: ReadonlyMap<D1BookmarkName, string>
  sessions: Map<D1BookmarkName, D1DatabaseSession>
}

const scopes = new AsyncLocalStorage<Scope>()

function sessionFor(scope: Scope, name: D1BookmarkName, database: D1Database) {
  let session = scope.sessions.get(name)
  if (!session) {
    session = database.withSession(scope.start === "primary" ? "first-primary" : (scope.bookmarks.get(name) ?? "first-unconstrained"))
    scope.sessions.set(name, session)
  }
  return session
}

/**
 * The database as the current scope's D1 session sees it, opened on the
 * scope's first statement. Outside a scope (a Durable Object's own work, a
 * test) the bare binding answers, which D1 runs on the primary. `exec` stays
 * on the bare binding: a session has none.
 */
export function requestSessionD1(database: D1Database, name: D1BookmarkName): D1Database {
  return new Proxy(database, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver)
      if (key === "prepare" || key === "batch") {
        return (...args: unknown[]) => {
          const scope = scopes.getStore()
          const runner = scope ? sessionFor(scope, name, target) : target
          return Reflect.apply(Reflect.get(runner, key), runner, args)
        }
      }
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

/** The bookmark the current scope's session of `name` has reached; nothing outside a scope or before its first statement. */
export function currentD1Bookmark(name: D1BookmarkName): string | undefined {
  return scopes.getStore()?.sessions.get(name)?.getBookmark() ?? undefined
}

/**
 * Runs `work` in the active scope, or, for work that answers no request (a
 * Durable Object's alarm), in a scope of its own started at `start`, so what
 * it reads and writes is one session per database with a bookmark to hand on.
 */
export function inD1Scope<T>(start: D1SessionStart, work: () => Promise<T>): Promise<T> {
  return scopes.getStore() ? work() : scopes.run({ start, bookmarks: new Map(), sessions: new Map() }, work)
}

/**
 * The bookmarks a request carries: the browser's cookies, and the header a
 * client without a cookie jar echoes from its last answers. Where both name a
 * database the newer wins.
 */
function requestBookmarks(request: Request) {
  const bookmarks = new Map<D1BookmarkName, string>(readD1Bookmarks(request.headers.get(D1_BOOKMARKS_HEADER) ?? ""))
  for (const pair of (request.headers.get("cookie") ?? "").split(";")) {
    const separator = pair.indexOf("=")
    const name = pair.slice(0, separator).trim()
    const value = pair.slice(separator + 1).trim()
    if (separator <= 0 || !name.startsWith(D1_BOOKMARK_COOKIE_PREFIX) || !isD1Bookmark(value)) continue
    const database = name.slice(D1_BOOKMARK_COOKIE_PREFIX.length)
    if (database !== "auth" && database !== "control") continue
    bookmarks.set(database, newerD1Bookmark(bookmarks.get(database), value))
  }
  return bookmarks
}

/** Whether the request names a bookmark in the header, which only a client that keeps the answers' bookmarks sends. */
export function echoesD1Bookmarks(request: Request) {
  return request.headers.has(D1_BOOKMARKS_HEADER)
}

function withHeaders(response: Response, headers: readonly (readonly [string, string])[]) {
  try {
    for (const [name, value] of headers) response.headers.append(name, value)
    return response
  } catch {
    const rebuilt = new Response(response.body, response)
    for (const [name, value] of headers) rebuilt.headers.append(name, value)
    return rebuilt
  }
}

/**
 * Answers `respond` with every `requestSessionD1` database it touches inside
 * one D1 session per database, started where `start` says. Every answer whose
 * sessions ran a statement names their bookmarks in `x-claxedo-d1-bookmarks`
 * for a client that keeps the newest itself. A `primary` answer also sets
 * them as host-only cookies the browser returns on every later request and
 * event stream of every tab; a `replica` answer sets none, because its
 * bookmark can be older than the one a concurrent write is about to set and
 * the browser keeps whichever cookie arrives last.
 */
export async function inD1Sessions(request: Request, start: D1SessionStart, respond: () => Promise<Response>): Promise<Response> {
  const scope: Scope = { start, bookmarks: requestBookmarks(request), sessions: new Map() }
  const response = await scopes.run(scope, respond)
  if (response.status === 101) return response
  const reached = [...scope.sessions].flatMap(([name, session]) => {
    const bookmark = session.getBookmark()
    return bookmark ? [[name, bookmark] as const] : []
  })
  if (reached.length === 0) return response
  return withHeaders(response, [
    [D1_BOOKMARKS_HEADER, writeD1Bookmarks(reached)],
    ...(start === "primary" ? reached.map(([name, bookmark]) => ["set-cookie", d1BookmarkCookie(name, bookmark)] as const) : []),
  ])
}
