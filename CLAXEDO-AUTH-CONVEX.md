# Claxedo Auth & Convex Sync — Architecture Document

> **Purpose**: Complete specification for adding user authentication (Clerk JWT) and Convex database sync to `claxedo-server`. Covers what exists, what to build, data flow, schema, and implementation order.

---

## Table of Contents

1. [Current State](#1-current-state)
2. [Target Architecture](#2-target-architecture)
3. [Auth: Clerk JWT on claxedo-server](#3-auth-clerk-jwt-on-claxedo-server)
4. [Convex Backend](#4-convex-backend)
5. [Convex Client in claxedo-server](#5-convex-client-in-claxedo-server)
6. [Sync Layer: SQLite → Convex](#6-sync-layer-sqlite--convex)
7. [Frontend Wiring](#7-frontend-wiring)
8. [Configuration & Environment](#8-configuration--environment)
9. [Security Model](#9-security-model)
10. [Migration & Backward Compatibility](#10-migration--backward-compatibility)
11. [Implementation Order](#11-implementation-order)

---

## 1. Current State

### What claxedo-server has today

`packages/claxedo-server` is a Hono + Node.js server on port 3001. It runs as a local agent runtime managing workspaces, sessions, PTY terminals, agent hooks, and cloud sandbox provisioning.

**Storage**: All data in local SQLite (`~/.claxedo/claxedo.db`) via Drizzle ORM + `better-sqlite3`, plus `~/.claxedo/workspaces.json` for workspace registry.

**Auth**: **None**. No middleware validates identity. Routes trust headers (`x-opencode-directory`, `x-workspace-id`) without verification.

**Convex**: **None**. No Convex client, no sync. The `convex` npm dependency is not installed.

**Cloud sandboxes**: Daytona/Modal provisioning exists (`cloud/provider.ts`, `cloud/sandbox-pool.ts`, `cloud/sandbox-runtime.ts`) but workspace ownership is unenforced.

### What claxedo-app (frontend) has today

The frontend auth infrastructure is **complete and production-ready**:

| File | What it does |
|------|--------------|
| `src/utils/auth-client.ts` | Clerk client: lazy init, `useAuth()` hook, `getAuthToken()` for Convex, `useClerkConvexToken()` |
| `src/providers/auth-provider.tsx` | `AuthProvider` context wrapping Clerk state in SolidJS signals |
| `src/components/require-auth.tsx` | `RequireAuth` guard — redirects to `/login` if not authenticated |
| `src/pages/login.tsx` | Login page mounting Clerk sign-in component (dark theme) |
| `src/components/settings-account-section.tsx` | Account settings with sign-out button |
| `src/components/dialog-create-cloud-project.tsx` | Cloud project creation dialog |
| `src/components/dialog-create-cloud-workspace.tsx` | Cloud workspace creation dialog |
| `src/components/cloud-auto-switch.tsx` | Auto-connects to cloud sandbox servers |
| `src/components/settings-sandbox-section.tsx` | Daytona/Modal credential config UI |
| `src/context/config.tsx` | `ConfigProvider` — feature flags (`authEnabled`, `sandboxEnabled`, `convexUrl`) |
| `src/extensions/app.tsx` | Registers auth routes, providers, settings via extension system |
| `src/extensions/server.tsx` | URL canonicalization + `authFetch()` with Bearer token |
| `src/i18n/cloud-strings.ts` | Localized strings (en, zh, ja, ko, de, fr, es) |

**Key frontend config** (`ClaxedoConfig` from `src/index.tsx`):
```typescript
interface ClaxedoConfig {
  convexUrl: string              // Convex deployment URL
  authBaseUrl: string            // Auth endpoints base URL
  gatewayUrl: string             // Gateway/server URL
  authEnabled?: boolean          // Enable Clerk auth (default: false)
  sandboxEnabled?: boolean       // Enable cloud sandbox creation (default: false)
  claxedoServerUrl?: string      // Claxedo server URL (default: http://127.0.0.1:3001)
}
```

Feature flags from env: `VITE_AUTH_ENABLED`, `VITE_SANDBOX_ENABLED`, `VITE_CONVEX_URL`, `VITE_CLERK_PUBLISHABLE_KEY`.

### What the old gateway had (reference only)

The old `claxedo/` gateway (documented in `CLAXEDO-GATEWAY-ARCHITECTURE.md`) had the full auth + Convex stack. This doc ports those patterns into the current `claxedo-server` architecture. Key things to port:

- Clerk JWT verification middleware (`@clerk/backend`)
- Identity types (AuthenticatedIdentity/UnauthenticatedIdentity)
- Role hierarchy (admin > member)
- ConvexHttpClient singleton
- Convex schema (projects, workspaces, chat_sessions, aiCredentials, user_backends)
- Convex functions (CRUD mutations/queries)
- Write-through session sync (SQLite write → Convex mutation)
- Credential encryption (AES-256-GCM)
- Dev mode bypass (AUTH_ENABLED=false → DEV_IDENTITY)

---

## 2. Target Architecture

```
┌──────────────────────┐       ┌─────────────────────────┐       ┌────────────┐
│   Claxedo Frontend   │──────▶│    claxedo-server        │──────▶│   Convex   │
│   (SolidJS + Clerk)  │ JWT   │  (Hono + Node.js)       │ HTTP  │  (Cloud DB)│
│                      │Bearer │                          │Client │            │
│  Clerk JS SDK        │       │  Auth Middleware          │       │  Schema    │
│  useAuth() hook      │       │  Convex Client           │       │  Functions │
│  RequireAuth guard   │       │  SQLite (local cache)    │       │  Auth      │
│  authFetch()         │       │  Sync Layer              │       │            │
└──────────────────────┘       └─────────────────────────┘       └────────────┘
         │                              │
         │ Convex Subscriptions         │ Proxy
         │ (real-time reads)            │
         ▼                              ▼
   ┌────────────┐              ┌─────────────────┐
   │   Convex   │              │  Cloud Sandbox   │
   │  (reads)   │              │  (Daytona/Modal) │
   └────────────┘              └─────────────────┘
```

**Data flow**:
1. Frontend authenticates via Clerk, sends JWT on every request
2. claxedo-server validates JWT, extracts identity (userId, orgId, role)
3. Writes go to local SQLite first (low latency), then sync to Convex (durability + cross-device)
4. Frontend can also read from Convex directly via subscriptions for real-time updates
5. Cloud sandbox traffic is authed via workspace ownership (orgId match)

---

## 3. Auth: Clerk JWT on claxedo-server

### New files

```
packages/claxedo-server/src/
  auth/
    middleware.ts      — Hono middleware: extract + verify JWT, set identity
    identity.ts        — Types + resolveIdentity() + dev bypass
    clerk-jwt.ts       — JWT verification + caching via @clerk/backend
    roles.ts           — Role types + hierarchy check
```

### Types (`auth/roles.ts`)

```typescript
export type OrganizationRole = "admin" | "member"

export interface AuthenticatedIdentity {
  ok: true
  token: string
  userId: string
  organizationId: string
  role: OrganizationRole
}

export interface UnauthenticatedIdentity {
  ok: false
  status: 401 | 403 | 500
  error: string
}

export type Identity = AuthenticatedIdentity | UnauthenticatedIdentity

export function hasRole(userRole: OrganizationRole, requiredRole: OrganizationRole): boolean {
  const hierarchy: OrganizationRole[] = ["member", "admin"]
  return hierarchy.indexOf(userRole) >= hierarchy.indexOf(requiredRole)
}
```

### Clerk JWT Verification (`auth/clerk-jwt.ts`)

```typescript
import { verifyToken } from "@clerk/backend"

// Per-token cache: token → { identity, expiresAt }
// 1-minute TTL for success, 5s for failures
const cache = new Map<string, { identity: Identity; expiresAt: number }>()

export async function verifyClerkJwt(token: string): Promise<Identity> {
  const cached = cache.get(token)
  if (cached && cached.expiresAt > Date.now()) return cached.identity

  try {
    const payload = await verifyToken(token, {
      secretKey: process.env.CLERK_SECRET_KEY!,
    })

    const userId = payload.sub
    const organizationId = payload.org_id       // from Clerk org claims
      ?? (payload as any)["o"]?.["id"]          // alternate claim format
    const orgRole = payload.org_role             // "org:admin" or "org:member"
      ?? (payload as any)["o"]?.["rol"]

    if (!userId || !organizationId) {
      return fail(token, 403, "Missing userId or organizationId in JWT")
    }

    const role: OrganizationRole = orgRole?.includes("admin") ? "admin" : "member"
    const identity: AuthenticatedIdentity = { ok: true, token, userId, organizationId, role }

    cache.set(token, { identity, expiresAt: Date.now() + 60_000 }) // 1min TTL
    return identity
  } catch (err) {
    return fail(token, 401, `JWT verification failed: ${err}`)
  }
}

function fail(token: string, status: 401 | 403 | 500, error: string): UnauthenticatedIdentity {
  const identity: UnauthenticatedIdentity = { ok: false, status, error }
  cache.set(token, { identity, expiresAt: Date.now() + 5_000 }) // 5s negative cache
  return identity
}
```

### Auth Middleware (`auth/middleware.ts`)

```typescript
import type { MiddlewareHandler } from "hono"
import { verifyClerkJwt } from "./clerk-jwt"
import { hasRole, type OrganizationRole, type Identity } from "./roles"

const DEV_IDENTITY: Identity = {
  ok: true,
  token: "dev",
  userId: "dev",
  organizationId: "dev",
  role: "admin",
}

const authEnabled = () => process.env.AUTH_ENABLED !== "false"

/**
 * Hono middleware that verifies Clerk JWT and sets identity in context.
 * When AUTH_ENABLED=false, injects DEV_IDENTITY for all requests.
 */
export function requireAuth(minRole: OrganizationRole = "member"): MiddlewareHandler {
  return async (c, next) => {
    if (!authEnabled()) {
      c.set("identity", DEV_IDENTITY)
      return next()
    }

    const header = c.req.header("authorization")
    if (!header?.startsWith("Bearer ")) {
      return c.json({ error: "Missing Authorization header" }, 401)
    }

    const token = header.slice(7)
    const identity = await verifyClerkJwt(token)

    if (!identity.ok) {
      return c.json({ error: identity.error }, identity.status)
    }

    if (!hasRole(identity.role, minRole)) {
      return c.json({ error: `Requires ${minRole} role` }, 403)
    }

    c.set("identity", identity)
    return next()
  }
}

/**
 * Get the authenticated identity from context. Throws if middleware not applied.
 */
export function getIdentity(c: any): Identity {
  const identity = c.get("identity")
  if (!identity) throw new Error("Auth middleware not applied")
  return identity
}
```

### Route protection plan

| Routes | Auth level | Notes |
|--------|-----------|-------|
| `GET /api/claxedo/health` | None | Always public |
| `POST /api/claxedo/track` | None | Analytics — no auth needed |
| `GET /global/event` | Member | SSE stream |
| `GET /session`, `POST /session` | Member | Session CRUD |
| `/pages/*` | Member | Page reads/writes |
| `GET /api/workspace/*` | Member | Workspace listing/resolve |
| `POST /api/workspace/create` | Admin | Workspace creation |
| `PUT /api/workspace/providers/*/auth` | Admin | Credential storage |
| `/api/claxedo/pty/*` | Member | Terminal access |
| `/api/claxedo/process/*` | Member | Process management |
| `/api/claxedo/agent-config/*` | Member | Agent config |
| `/api/claxedo/hook/*` | None | Agent hooks (from CLI agents, no browser auth) |
| `/api/workgraph/*` | Member | Workgraph execution |

**Implementation**: Wrap route groups with `requireAuth()` middleware in `server.ts`. Agent hook routes remain unauthenticated (they're called by CLI agent subprocesses, not the browser).

### Hono context type update

```typescript
// Add to server.ts or a shared types file
type AppVariables = {
  identity?: Identity
}

type AppEnv = { Variables: AppVariables }

const app = new Hono<AppEnv>()
```

---

## 4. Convex Backend

### New directory

```
packages/claxedo-server/convex/
  _generated/            — Auto-generated by npx convex dev (gitignored)
  schema.ts              — Database schema
  auth.config.ts         — Clerk JWT validation config
  projects.ts            — Project CRUD
  workspaces.ts          — Workspace CRUD + sandbox status
  sessions.ts            — Chat session sync
  aiCredentials.ts       — Encrypted AI provider credentials
  backends.ts            — User backend (tunnel) registration
  tsconfig.json          — Convex TypeScript config
```

### Schema (`convex/schema.ts`)

```typescript
import { defineSchema, defineTable } from "convex/server"
import { v } from "convex/values"

export default defineSchema({
  projects: defineTable({
    organizationId: v.string(),
    name: v.string(),
    repoUrl: v.optional(v.string()),
    branch: v.optional(v.string()),
    externalId: v.optional(v.string()),
    sandboxSnapshotId: v.optional(v.string()),
    icon: v.optional(v.object({
      url: v.optional(v.string()),
      override: v.optional(v.string()),
      color: v.optional(v.string()),
    })),
    commands: v.optional(v.object({
      start: v.optional(v.string()),
    })),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org", ["organizationId"])
    .index("by_org_name", ["organizationId", "name"])
    .index("by_external", ["externalId"]),

  workspaces: defineTable({
    projectId: v.string(),
    organizationId: v.string(),
    name: v.string(),
    directory: v.string(),
    sandboxId: v.optional(v.string()),
    sandboxUrl: v.optional(v.string()),
    sandboxStatus: v.optional(v.string()),  // "running" | "stopped" | "deleted"
    provider: v.optional(v.string()),       // "daytona" | "modal"
    repoUrl: v.optional(v.string()),
    gitBranch: v.optional(v.string()),
    gitRemote: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_project_name", ["projectId", "name"])
    .index("by_directory", ["directory"])
    .index("by_org", ["organizationId"]),

  chat_sessions: defineTable({
    workspaceId: v.string(),
    organizationId: v.string(),
    sessionId: v.string(),
    title: v.optional(v.string()),
    provider: v.optional(v.string()),
    repoName: v.optional(v.string()),
    gitBranch: v.optional(v.string()),
    gitRemote: v.optional(v.string()),
    data: v.optional(v.string()),         // Full session JSON
    deletedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_session_id", ["sessionId"])
    .index("by_org", ["organizationId"]),

  chat_messages: defineTable({
    sessionId: v.string(),
    workspaceId: v.string(),
    organizationId: v.string(),
    messageId: v.string(),
    role: v.optional(v.string()),
    ordinal: v.number(),
    data: v.string(),                     // Full message JSON
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_session", ["sessionId", "ordinal"])
    .index("by_workspace", ["workspaceId"]),

  aiCredentials: defineTable({
    organizationId: v.string(),
    provider: v.string(),                 // "openai", "anthropic", etc.
    encryptedKey: v.string(),             // AES-256-GCM encrypted
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org", ["organizationId"])
    .index("by_org_provider", ["organizationId", "provider"]),

  user_backends: defineTable({
    userId: v.string(),
    organizationId: v.string(),
    backendUrl: v.string(),               // Tunnel URL to local OpenCode
    lastSeen: v.number(),
    createdAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_org", ["organizationId"]),

  pages: defineTable({
    workspaceId: v.string(),
    organizationId: v.string(),
    pageId: v.string(),
    title: v.string(),
    content: v.optional(v.string()),
    status: v.optional(v.string()),       // "draft" | "in_review" | "in_progress" | "done" | "archived"
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_org", ["organizationId"]),
})
```

### Auth Config (`convex/auth.config.ts`)

```typescript
export default {
  providers: [
    {
      domain: process.env.CLERK_JWT_ISSUER_DOMAIN!,
      applicationID: "convex",
    },
  ],
}
```

### Key Convex Functions

**`convex/sessions.ts`** (most critical — syncs from claxedo-server):
```typescript
import { mutation, query } from "./_generated/server"
import { v } from "convex/values"

export const sync = mutation({
  args: {
    sessionId: v.string(),
    workspaceId: v.string(),
    organizationId: v.string(),
    title: v.optional(v.string()),
    provider: v.optional(v.string()),
    repoName: v.optional(v.string()),
    gitBranch: v.optional(v.string()),
    gitRemote: v.optional(v.string()),
    data: v.optional(v.string()),
    deletedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("chat_sessions")
      .withIndex("by_session_id", (q) => q.eq("sessionId", args.sessionId))
      .first()

    const now = Date.now()
    if (existing) {
      await ctx.db.patch(existing._id, {
        ...args,
        updatedAt: now,
      })
    } else {
      await ctx.db.insert("chat_sessions", {
        ...args,
        createdAt: now,
        updatedAt: now,
      })
    }
  },
})

export const list = query({
  args: { workspaceId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("chat_sessions")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .order("desc")
      .collect()
  },
})

export const remove = mutation({
  args: { sessionId: v.string() },
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query("chat_sessions")
      .withIndex("by_session_id", (q) => q.eq("sessionId", args.sessionId))
      .first()
    if (session) await ctx.db.delete(session._id)
  },
})
```

**`convex/workspaces.ts`**:
```typescript
import { mutation, query } from "./_generated/server"
import { v } from "convex/values"

export const sync = mutation({
  args: {
    workspaceId: v.string(),       // Local workspace ID (from workspace-store)
    organizationId: v.string(),
    projectId: v.string(),
    name: v.string(),
    directory: v.string(),
    sandboxId: v.optional(v.string()),
    sandboxUrl: v.optional(v.string()),
    sandboxStatus: v.optional(v.string()),
    provider: v.optional(v.string()),
    repoUrl: v.optional(v.string()),
    gitBranch: v.optional(v.string()),
    gitRemote: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("workspaces")
      .withIndex("by_directory", (q) => q.eq("directory", args.directory))
      .first()

    const now = Date.now()
    if (existing) {
      await ctx.db.patch(existing._id, { ...args, updatedAt: now })
    } else {
      await ctx.db.insert("workspaces", { ...args, createdAt: now, updatedAt: now })
    }
  },
})

export const getByDirectory = query({
  args: { directory: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("workspaces")
      .withIndex("by_directory", (q) => q.eq("directory", args.directory))
      .first()
  },
})

export const listByOrg = query({
  args: { organizationId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("workspaces")
      .withIndex("by_org", (q) => q.eq("organizationId", args.organizationId))
      .collect()
  },
})

export const remove = mutation({
  args: { directory: v.string() },
  handler: async (ctx, args) => {
    const ws = await ctx.db
      .query("workspaces")
      .withIndex("by_directory", (q) => q.eq("directory", args.directory))
      .first()
    if (ws) {
      // Cascade: delete sessions
      const sessions = await ctx.db
        .query("chat_sessions")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", ws.projectId))
        .collect()
      for (const s of sessions) await ctx.db.delete(s._id)
      await ctx.db.delete(ws._id)
    }
  },
})
```

**`convex/projects.ts`**, **`convex/aiCredentials.ts`**, **`convex/backends.ts`** — follow the same pattern. See old gateway architecture doc §15 for full function signatures.

---

## 5. Convex Client in claxedo-server

### New files

```
packages/claxedo-server/src/
  convex/
    client.ts            — ConvexHttpClient singleton
    sync.ts              — Write-through sync orchestrator
```

### Convex Client (`convex/client.ts`)

```typescript
import { ConvexHttpClient } from "convex/browser"

let client: ConvexHttpClient | undefined

export function getConvex(): ConvexHttpClient {
  if (!client) {
    const url = process.env.CONVEX_URL
    if (!url) throw new Error("CONVEX_URL not set")
    client = new ConvexHttpClient(url)
  }
  return client
}

export function hasConvex(): boolean {
  return !!process.env.CONVEX_URL
}
```

### New dependency

```bash
npm install convex @clerk/backend
```

Add to `packages/claxedo-server/package.json`:
```json
{
  "dependencies": {
    "convex": "^1.17.4",
    "@clerk/backend": "^1.21.0"
  }
}
```

---

## 6. Sync Layer: SQLite → Convex

### Design principles

1. **SQLite is primary** — all reads serve from local SQLite for low latency
2. **Write-through to Convex** — every SQLite write also fires a Convex mutation (fire-and-forget)
3. **Convex is the durable sync layer** — cross-device state, dashboard access, history
4. **Failures are non-fatal** — if Convex is unreachable, local operations succeed; sync retries on next write
5. **Identity required** — sync only happens when auth is enabled and identity is available

### Sync orchestrator (`convex/sync.ts`)

```typescript
import { getConvex, hasConvex } from "./client"
import { api } from "../../convex/_generated/api"
import type { Identity } from "../auth/roles"
import { Log } from "../log"

const log = Log.create({ service: "convex-sync" })

/**
 * Fire-and-forget sync to Convex. Logs errors but never throws.
 */
function fireAndForget(label: string, fn: () => Promise<void>) {
  if (!hasConvex()) return
  fn().catch((err) => {
    log.warn(`Convex sync failed: ${label}`, { error: String(err) })
  })
}

// ── Sessions ──

export function syncSessionToConvex(
  identity: Identity,
  workspaceId: string,
  sessionId: string,
  fields: {
    title?: string
    provider?: string
    repoName?: string
    gitBranch?: string
    gitRemote?: string
    data?: string
    deletedAt?: number
  },
) {
  if (!identity.ok) return
  fireAndForget(`session:${sessionId}`, async () => {
    await getConvex().mutation(api.sessions.sync, {
      sessionId,
      workspaceId,
      organizationId: identity.organizationId,
      ...fields,
    })
  })
}

export function deleteSessionFromConvex(sessionId: string) {
  fireAndForget(`session:delete:${sessionId}`, async () => {
    await getConvex().mutation(api.sessions.remove, { sessionId })
  })
}

// ── Workspaces ──

export function syncWorkspaceToConvex(
  identity: Identity,
  ws: {
    id: string
    project_id?: string
    project_name?: string
    workspace_name?: string
    directory: string
    provider?: string
    repo_url?: string
    git_branch?: string
    git_remote?: string
    sandbox_id?: string
    sandbox_url?: string
    status?: string
  },
) {
  if (!identity.ok) return
  fireAndForget(`workspace:${ws.id}`, async () => {
    await getConvex().mutation(api.workspaces.sync, {
      workspaceId: ws.id,
      organizationId: identity.organizationId,
      projectId: ws.project_id ?? ws.id,
      name: ws.workspace_name ?? ws.project_name ?? "main",
      directory: ws.directory,
      sandboxId: ws.sandbox_id,
      sandboxUrl: ws.sandbox_url,
      sandboxStatus: ws.status,
      provider: ws.provider,
      repoUrl: ws.repo_url,
      gitBranch: ws.git_branch,
      gitRemote: ws.git_remote,
    })
  })
}

export function deleteWorkspaceFromConvex(directory: string) {
  fireAndForget(`workspace:delete:${directory}`, async () => {
    await getConvex().mutation(api.workspaces.remove, { directory })
  })
}

// ── Messages ──

export function syncMessagesToConvex(
  identity: Identity,
  workspaceId: string,
  sessionId: string,
  messages: Array<{ messageId: string; role?: string; ordinal: number; data: string }>,
) {
  if (!identity.ok) return
  fireAndForget(`messages:${sessionId}`, async () => {
    const convex = getConvex()
    for (const msg of messages) {
      await convex.mutation(api.chat_messages?.sync ?? api.sessions.sync, {
        ...msg,
        sessionId,
        workspaceId,
        organizationId: identity.organizationId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    }
  })
}
```

### Integration points in existing code

Sync calls are inserted alongside existing SQLite writes:

**1. `cloud/session-sync.ts` — `syncCloudSessions()`**

After the SQLite transaction, call:
```typescript
// After ClaxedoDB.transaction(...)
for (const row of rows) {
  syncSessionToConvex(identity, row.workspace_id, row.session_id, {
    title: row.title ?? undefined,
    provider: row.provider ?? undefined,
    repoName: row.repo_name ?? undefined,
    gitBranch: row.git_branch ?? undefined,
    gitRemote: row.git_remote ?? undefined,
    data: row.data,
  })
}
```

**2. `cloud/session-sync.ts` — `deleteCloudSession()`**

After the SQLite transaction, call:
```typescript
deleteSessionFromConvex(session_id)
```

**3. `workspace-store.ts` — `ensureWorkspace()`**

After `save()`, call:
```typescript
syncWorkspaceToConvex(identity, ws)
```

**4. `workspace-store.ts` — `deleteWorkspaceByDirectory()`**

After `save()`, call:
```typescript
deleteWorkspaceFromConvex(dir)
```

### Identity threading

The sync layer needs the current user's identity. Two approaches:

**Option A — Pass identity through call chain** (explicit, type-safe):
```typescript
// session-sync.ts
export async function syncCloudSessions(ws: Workspace, sessions: unknown[], identity?: Identity)
```

**Option B — AsyncLocalStorage context** (implicit, less plumbing):
```typescript
// auth/context.ts
import { AsyncLocalStorage } from "async_hooks"
const identityStorage = new AsyncLocalStorage<Identity>()

export function withIdentity<T>(identity: Identity, fn: () => T): T {
  return identityStorage.run(identity, fn)
}

export function currentIdentity(): Identity | undefined {
  return identityStorage.getStore()
}
```

The middleware sets identity in AsyncLocalStorage; sync layer reads it. This avoids modifying every function signature.

**Recommendation**: Use **Option B** (AsyncLocalStorage) for sync, since identity needs to flow through many layers without changing every function signature.

---

## 7. Frontend Wiring

### Already done (just needs activation)

The frontend already has everything wired. Activation is via environment variables:

```bash
# .env (frontend)
VITE_AUTH_ENABLED=true
VITE_CLERK_PUBLISHABLE_KEY=pk_test_...
VITE_CONVEX_URL=https://xxx.convex.cloud
```

### Auth header injection

`src/extensions/server.tsx` already provides `authFetch()` that adds the Bearer token. The server extension's `urlTransform` canonicalizes URLs to point at the claxedo-server. This already works — no changes needed.

### Convex subscriptions (Phase 2)

For real-time cross-device reads, add a Convex React (SolidJS) client to the frontend:

```typescript
// New: src/providers/convex-provider.tsx
import { ConvexProvider, ConvexReactClient } from "convex/react"  // SolidJS adapter needed
import { useClerkConvexToken } from "../utils/auth-client"

// useClerkConvexToken() already exists — provides { token, isLoading }
// Wire it into ConvexProvider for authenticated real-time subscriptions
```

This is Phase 2 work — initial implementation reads from claxedo-server's SQLite (synced to Convex in background), frontend Convex subscriptions come later.

### Route protection

`RequireAuth` component already exists. The app extension (`extensions/app.tsx`) already conditionally wraps routes with it when `authEnabled=true`. No changes needed.

---

## 8. Configuration & Environment

### claxedo-server environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CLAXEDO_SERVER_PORT` | No | `3001` | Server port |
| `AUTH_ENABLED` | No | `true` | Set `"false"` to disable auth (dev mode) |
| `CLERK_SECRET_KEY` | When auth enabled | — | Clerk secret for JWT verification |
| `CONVEX_URL` | When sync enabled | — | Convex deployment URL |
| `ENCRYPTION_KEY` | When storing creds | `"default-key"` | 32-char AES-256-GCM key |

### Frontend environment variables (existing)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `VITE_AUTH_ENABLED` | No | `"false"` | Enable Clerk auth |
| `VITE_CLERK_PUBLISHABLE_KEY` | When auth enabled | — | Clerk publishable key |
| `VITE_CONVEX_URL` | When sync enabled | — | Convex deployment URL |
| `VITE_CLAXEDO_SERVER_URL` | No | `http://127.0.0.1:3001` | Claxedo server URL |

### Convex environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `CLERK_JWT_ISSUER_DOMAIN` | Yes | Clerk issuer domain for JWT validation |

---

## 9. Security Model

### Authentication flow

```
Frontend                     claxedo-server                    Convex
   │                              │                              │
   │ 1. Clerk sign-in             │                              │
   │ 2. Get JWT token             │                              │
   │                              │                              │
   │── Authorization: Bearer JWT ─▶│                              │
   │                              │ 3. Verify JWT (@clerk/backend)│
   │                              │ 4. Extract userId, orgId, role│
   │                              │ 5. Check role ≥ minRole       │
   │                              │                               │
   │                              │── ConvexHttpClient.mutation ──▶│
   │                              │   (fire-and-forget sync)      │ 6. Validate via auth.config.ts
   │                              │                               │    (same Clerk JWT issuer)
   │                              │                               │
   │◀── Response ─────────────────│                               │
```

### Authorization levels

| Level | Middleware | Gates |
|-------|-----------|-------|
| None | — | `/api/claxedo/health`, `/api/claxedo/track`, `/api/claxedo/hook/*` |
| Member | `requireAuth("member")` | Reads: session list, workspace resolve, pages, agent config, PTY, events |
| Admin | `requireAuth("admin")` | Writes: workspace create, credential storage, provider auth |

### Fail-closed principle

All ownership checks fail closed:
- Missing/invalid JWT → 401
- Valid JWT but no org → 403
- Workspace org mismatch → 403
- Convex lookup failure → 403 (not pass-through)

### Dev mode bypass

When `AUTH_ENABLED=false`:
- All auth middleware injects `DEV_IDENTITY` (userId="dev", orgId="dev", role="admin")
- Convex sync is skipped (no `CONVEX_URL`)
- Local-only operation, same as today

### Credential encryption

For AI provider API keys stored in Convex:
- Encrypted with AES-256-GCM (12-byte random IV)
- Key from `ENCRYPTION_KEY` env var (padded to 32 bytes)
- Stored as `base64(iv + ciphertext)` in Convex `aiCredentials` table
- Decrypted only when injecting into sandbox or responding to auth routes

```typescript
// auth/encryption.ts
import { randomBytes, createCipheriv, createDecipheriv } from "crypto"

function padKey(key: string): Buffer {
  return Buffer.from(key.padEnd(32, "\0").slice(0, 32))
}

export function encrypt(plaintext: string, key: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", padKey(key), iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, encrypted, tag]).toString("base64")
}

export function decrypt(data: string, key: string): string {
  const buf = Buffer.from(data, "base64")
  const iv = buf.subarray(0, 12)
  const tag = buf.subarray(buf.length - 16)
  const encrypted = buf.subarray(12, buf.length - 16)
  const decipher = createDecipheriv("aes-256-gcm", padKey(key), iv)
  decipher.setAuthTag(tag)
  return decipher.update(encrypted) + decipher.final("utf8")
}
```

---

## 10. Migration & Backward Compatibility

### No breaking changes

- `AUTH_ENABLED=false` (default for now) preserves current behavior — zero auth, zero sync
- All sync is fire-and-forget — SQLite remains the primary store
- Frontend feature flags default to `false` — standalone mode works as-is
- Existing routes keep their paths — only middleware is added around them
- Agent hook routes (`/api/claxedo/hook/*`) stay unauthenticated — CLI agents don't have browser auth

### Gradual rollout

1. **Phase 0** (current): `AUTH_ENABLED=false`, no Convex — everything works locally
2. **Phase 1**: Set `AUTH_ENABLED=true` + `CLERK_SECRET_KEY` — auth enforced, no sync yet
3. **Phase 2**: Set `CONVEX_URL` — SQLite writes sync to Convex in background
4. **Phase 3**: Frontend Convex subscriptions — real-time cross-device reads

### Data migration

No migration needed. Convex starts empty. As users interact with claxedo-server (create workspaces, start sessions), data flows to Convex via write-through sync. Historical data in SQLite is not backfilled (could add a one-time migration script if needed).

---

## 11. Implementation Order

### Step 1: Auth middleware

**Files to create**:
- `src/auth/roles.ts` — Types
- `src/auth/clerk-jwt.ts` — JWT verification + cache
- `src/auth/middleware.ts` — `requireAuth()` + `getIdentity()`
- `src/auth/context.ts` — AsyncLocalStorage for identity threading
- `src/auth/index.ts` — Re-exports

**Files to modify**:
- `src/server.ts` — Wrap route groups with `requireAuth()`, add Hono context type
- `package.json` — Add `@clerk/backend` dependency

**Test**: Set `AUTH_ENABLED=true` + `CLERK_SECRET_KEY`, verify 401 without token, 200 with valid token.

### Step 2: Convex backend

**Files to create**:
- `convex/schema.ts` — Full schema
- `convex/auth.config.ts` — Clerk JWT config
- `convex/projects.ts` — Project CRUD
- `convex/workspaces.ts` — Workspace CRUD
- `convex/sessions.ts` — Session sync
- `convex/aiCredentials.ts` — Credential storage
- `convex/backends.ts` — Backend registration
- `convex/tsconfig.json`

**Deploy**: `npx convex dev` to create deployment + generate client code.

### Step 3: Convex client + sync layer

**Files to create**:
- `src/convex/client.ts` — ConvexHttpClient singleton
- `src/convex/sync.ts` — Write-through sync functions

**Files to modify**:
- `src/cloud/session-sync.ts` — Add Convex sync after SQLite writes
- `src/workspace-store.ts` — Add Convex sync after workspace save/delete
- `src/routes/workspace.ts` — Sync workspace create to Convex
- `package.json` — Add `convex` dependency

**Test**: Create workspace, verify it appears in Convex dashboard. Create session, verify sync.

### Step 4: Credential encryption + AI provider routes

**Files to create**:
- `src/auth/encryption.ts` — AES-256-GCM encrypt/decrypt

**Files to modify**:
- `src/routes/workspace.ts` — Add credential storage route (`PUT /api/workspace/providers/:id/auth` → encrypt → Convex)
- `src/cloud/sandbox-runtime.ts` — Inject decrypted credentials into sandbox on start

### Step 5: Frontend activation

**No code changes** — just environment variables:
```bash
VITE_AUTH_ENABLED=true
VITE_CLERK_PUBLISHABLE_KEY=pk_test_...
VITE_CONVEX_URL=https://xxx.convex.cloud
```

### Step 6 (Phase 2): Frontend Convex subscriptions

**Files to create** (in `packages/claxedo-app`):
- `src/providers/convex-provider.tsx` — ConvexProvider with Clerk auth
- Update contexts to optionally read from Convex subscriptions for real-time cross-device sync

---

## Appendix: Data Flow Examples

### Session create

```
1. User starts chat in frontend
2. Frontend POST /session (with Bearer JWT)
3. claxedo-server auth middleware verifies JWT → identity
4. AgentSessionRoutes.createSession() → local agent engine
5. syncCloudSession(ws, session) → SQLite insert
6. syncSessionToConvex(identity, ...) → fire-and-forget Convex mutation
7. Response → frontend (from SQLite, not waiting for Convex)
```

### Workspace create

```
1. User clicks "Create Cloud Project" in frontend
2. Frontend POST /api/workspace/create (with Bearer JWT)
3. Auth middleware verifies JWT → identity (admin required)
4. WorkspaceRoutes.create() → ensureWorkspace() → SQLite + workspaces.json
5. syncWorkspaceToConvex(identity, ws) → fire-and-forget
6. ensureWorkspaceRuntime(ws.id) → Daytona/Modal sandbox provisioning
7. SSE events → frontend for provisioning progress
```

### Cross-device session list (Phase 2)

```
1. User opens claxedo on Device B
2. Frontend subscribes to Convex chat_sessions (filtered by orgId)
3. Convex pushes real-time updates from all devices
4. Session list shows sessions from Device A + Device B
```
