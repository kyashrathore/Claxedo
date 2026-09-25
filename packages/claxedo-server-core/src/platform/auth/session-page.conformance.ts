import type { SignedControlPlaneAuth } from "./auth"
import type { PrivateSessionAuthority, PrivateSessionRuntimePrincipal } from "./private-session-authority"
import type { SessionTurnAuthority } from "./session-turn-authority"
import {
  buildSessionListResponse,
  compareSessionOrder,
  sessionOrderKey,
  parseSessionListQuery,
  sessionListKeysetPage,
  type SessionNavigationRow,
} from "../../session/navigation-list"

export type SessionPageConformanceUser = {
  auth: SignedControlPlaneAuth
  runtime: Extract<PrivateSessionRuntimePrincipal, { principalKind: "user" }>
}

/**
 * `reader` and `colleague` stand in one organization and may both create
 * sessions in `workspaceIds`, which all belong to `projectId`. `stranger`
 * belongs to another organization, with its own workspace and project.
 */
export type SessionPageConformanceHarness = {
  authority: PrivateSessionAuthority & SessionTurnAuthority
  projectId: string
  workspaceIds: [string, string]
  reader: SessionPageConformanceUser
  colleague: SessionPageConformanceUser
  stranger: SessionPageConformanceUser & { projectId: string; workspaceId: string }
}

export type SessionPageConformanceReport = {
  pages: number
  walked: string[]
  strangerSees: string[]
  readerSeesOfStrangersProject: string[]
}

/**
 * The session list's keyset read, through the port alone: a page holds only
 * the rows the caller may read, and walking pages while sessions are created
 * and prompted between reads gives each row once, in order, with none skipped
 * but the ones whose order key moved above the cursor.
 */
export async function exerciseSessionPageConformance(
  harness: SessionPageConformanceHarness,
): Promise<SessionPageConformanceReport> {
  const { authority, reader, colleague, stranger, workspaceIds, projectId } = harness
  let sequence = 0
  const create = async (user: SessionPageConformanceUser, workspaceId: string) => {
    const sessionId = `ses_page_${String(++sequence).padStart(2, "0")}`
    const operationId = `op_page_${sequence}`
    await authority.reserveSession(user.auth, { operationId, sessionId, workspaceId, kind: "create", title: sessionId })
    await authority.registerRuntimeSession({ ...user.runtime, operationId, sessionId, workspaceId, title: sessionId })
    return sessionId
  }
  const prompt = async (user: SessionPageConformanceUser, sessionId: string, workspaceId: string) => {
    const turnId = `turn_${sessionId}_${++sequence}`
    const runtime = { ...user.runtime, sessionId, workspaceId }
    const lease = await authority.acquireSessionTurn({ ...runtime, turnId })
    await authority.releaseSessionTurn({ ...runtime, turnId, leaseId: lease.leaseId, fencingToken: lease.fencingToken })
  }

  const readers: string[] = []
  for (let index = 0; index < 7; index++) {
    const workspaceId = workspaceIds[index % 2]!
    readers.push(await create(reader, workspaceId))
  }
  await prompt(reader, readers[1]!, workspaceIds[1])
  await prompt(reader, readers[4]!, workspaceIds[0])
  const colleagues = [await create(colleague, workspaceIds[0]), await create(colleague, workspaceIds[1])]
  await prompt(colleague, colleagues[0]!, workspaceIds[0])
  const strangers = [await create(stranger, stranger.workspaceId)]

  const whole = await readListPage(authority, reader.auth, `scope=project&projectId=${projectId}&limit=100`)
  const wholeIds = whole.rows.map((row) => row.sessionId)
  conform(sameSet(wholeIds, readers), "the project page did not hold exactly the reader's own sessions")
  conform(wholeIds[0] === readers[4] && wholeIds[1] === readers[1], "prompted sessions did not lead in turn order")
  conform(isStrictlyOrdered(whole.rows), "the project page was not in the list's order")

  const walked: SessionNavigationRow[] = []
  let cursor: string | undefined
  let pages = 0
  const inserted: string[] = []
  const moved: string[] = []
  do {
    const next = await readListPage(
      authority,
      reader.auth,
      `scope=project&projectId=${projectId}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    )
    walked.push(...next.rows)
    cursor = next.nextCursor
    pages++
    if (pages === 1) {
      inserted.push(await create(reader, workspaceIds[0]))
      moved.push(readers[0]!)
      await prompt(reader, readers[0]!, workspaceIds[0])
    }
    if (pages === 2) inserted.push(await create(colleague, workspaceIds[1]))
  } while (cursor && pages < 20)

  const walkedIds = walked.map((row) => row.sessionId)
  conform(pages >= 3, "the walk did not span three pages")
  conform(new Set(walkedIds).size === walkedIds.length, "a row came back on two pages")
  conform(isStrictlyOrdered(walked), "the pages together were not in the list's order")
  for (const sessionId of readers.filter((id) => !moved.includes(id))) {
    conform(walkedIds.includes(sessionId), `row ${sessionId} was skipped by the walk`)
  }
  conform(walkedIds.includes(inserted[0]!), "a row created behind the cursor was not reached")
  conform(!walkedIds.includes(moved[0]!), "a row prompted above the cursor came back below it")
  conform(!walkedIds.some((id) => colleagues.includes(id) || id === inserted[1] || strangers.includes(id)),
    "the walk returned another person's session")

  const strangerSees = (await readListPage(authority, stranger.auth, `scope=project&projectId=${projectId}&limit=100`)).rows
    .map((row) => row.sessionId)
  const readerSeesOfStrangersProject = (await readListPage(
    authority,
    reader.auth,
    `scope=project&projectId=${stranger.projectId}&limit=100`,
  )).rows.map((row) => row.sessionId)
  const strangerOwn = (await readListPage(authority, stranger.auth, `scope=workspace&workspaceId=${stranger.workspaceId}&limit=100`)).rows
    .map((row) => row.sessionId)
  conform(strangerSees.length === 0, "another organization's member read this project's sessions")
  conform(readerSeesOfStrangersProject.length === 0, "the reader read another organization's sessions")
  conform(sameSet(strangerOwn, strangers), "a workspace page did not hold its own creator's session")

  return { pages, walked: walkedIds, strangerSees, readerSeesOfStrangersProject }
}

async function readListPage(authority: PrivateSessionAuthority, auth: SignedControlPlaneAuth, search: string) {
  const query = parseSessionListQuery(new URL(`https://control.test/api/control/session-list?sort=human_turn_desc&${search}`))
  const scope = query.scope === "project" ? { projectId: query.projectId! } : { workspaceId: query.workspaceId! }
  const sessions = await authority.listSessionPage(auth, { ...sessionListKeysetPage(query), ...scope })
  const response = buildSessionListResponse({ query, sessions, cursorApplied: true })
  return { rows: response.items ?? [], nextCursor: response.nextCursor }
}

function isStrictlyOrdered(rows: SessionNavigationRow[]) {
  return rows.every((row, index) =>
    index === 0 || compareSessionOrder(sessionOrderKey(rows[index - 1]!), sessionOrderKey(row), "human_turn_desc") < 0)
}

function sameSet(left: string[], right: string[]) {
  return left.length === right.length && left.every((item) => right.includes(item))
}

function conform(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Session-page conformance failed: ${message}`)
}
