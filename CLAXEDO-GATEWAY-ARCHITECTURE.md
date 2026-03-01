# Claxedo Gateway — Complete Architecture Document

> **Purpose**: This document is detailed enough to fully regenerate the `claxedo/` server codebase from scratch. Every file, type, algorithm, and integration point is described.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Technology Stack & Dependencies](#2-technology-stack--dependencies)
3. [Configuration & Environment](#3-configuration--environment)
4. [Directory Structure](#4-directory-structure)
5. [Server Entry Point & Lifecycle](#5-server-entry-point--lifecycle)
6. [Hono App Factory & Middleware Pipeline](#6-hono-app-factory--middleware-pipeline)
7. [Context & Type System](#7-context--type-system)
8. [Middleware Layer](#8-middleware-layer)
9. [Route Definitions](#9-route-definitions)
10. [Proxy System](#10-proxy-system)
11. [Event System (SSE)](#11-event-system-sse)
12. [Services Layer](#12-services-layer)
13. [Orchestrator & Sandbox Abstraction](#13-orchestrator--sandbox-abstraction)
14. [Observability Stack](#14-observability-stack)
15. [Convex Database Layer](#15-convex-database-layer)
16. [Build & Deployment](#16-build--deployment)
17. [Library Utilities](#17-library-utilities)
18. [Security Model](#18-security-model)

---

## 1. Overview

The Claxedo Gateway is a **Hono-on-Node.js** HTTP/WebSocket server that sits between the SolidJS frontend and one or more OpenCode backend servers. It operates in **two mutually exclusive modes**:

| Mode | When | Behavior |
|------|------|----------|
| **Cloud/Sandbox** | `SANDBOX_ENABLED=true` (default) | Manages Daytona cloud sandboxes. Resolves `directory → workspace → sandbox URL` and proxies requests. Manages sandbox lifecycle (create, wake, stop, delete). |
| **Local** | `SANDBOX_ENABLED=false` | Proxies all OpenCode API calls to a local OpenCode server (default `http://127.0.0.1:4096`). Optionally auto-spawns that server. Bridges SSE events from local server to gateway bus. |

**Key responsibilities**:
- Clerk JWT authentication with organization-based RBAC
- Reverse-proxy HTTP and WebSocket (PTY) traffic to OpenCode backends
- Session metadata sync (OpenCode ↔ Convex)
- AI provider credential storage (AES-256-GCM encrypted in Convex)
- Credential injection into running sandboxes
- SSE event aggregation/forwarding
- Prometheus metrics, OpenTelemetry tracing, Sentry error tracking
- Static file serving for the built frontend (SPA with index.html fallback)

**Port**: 3000 (dev), 8080 (production/Fly.io)
**Runtime**: Bun (runs TypeScript directly, no build step for backend)

---

## 2. Technology Stack & Dependencies

### Runtime Dependencies

```json
{
  "@clerk/backend": "^1.21.0",        // JWT verification via Clerk JWKS
  "@daytonaio/sdk": "^0.134.0",        // Daytona sandbox management
  "@hono/node-server": "^1.19.9",      // Hono adapter for Node.js HTTP server
  "@hono/node-ws": "^1.3.0",           // WebSocket support (NOT used directly - uses `ws` instead)
  "@opentelemetry/api": "^1.9.0",
  "@opentelemetry/exporter-trace-otlp-http": "^0.57.0",
  "@opentelemetry/resources": "^1.28.0",
  "@opentelemetry/sdk-node": "^0.57.0",
  "@opentelemetry/sdk-trace-node": "^1.28.0",
  "@opentelemetry/semantic-conventions": "^1.28.0",
  "@sentry/node": "^8.0.0",
  "convex": "^1.17.4",                 // Convex client for database
  "dotenv": "^17.2.3",
  "hono": "^4.11.5",                   // HTTP framework
  "prom-client": "^15.1.0",            // Prometheus metrics
  "ws": "^8.19.0"                      // WebSocket for PTY proxy
}
```

### Dev Dependencies

```json
{
  "@types/bun": "^1.3.7",
  "@types/node": "^22.10.7",
  "@types/ws": "^8.18.1",
  "typescript": "^5.7.3"
}
```

### TypeScript Config

```json
{
  "target": "ES2022",
  "module": "ESNext",
  "moduleResolution": "bundler",
  "allowImportingTsExtensions": true,
  "strict": true,
  "paths": {
    "@/*": ["./src/*"],
    "convex/*": ["./convex/*"]
  },
  "types": ["node", "bun"]
}
```

The project is `"type": "module"` (ESM).

---

## 3. Configuration & Environment

**File**: `src/config/index.ts`

Loads from `.env.local` via `dotenv`. All config is a single `Config` object:

```typescript
export const Config = {
  // Server
  PORT: parseInt(process.env.PORT || "3000"),
  HOST: process.env.HOST || "127.0.0.1",
  NODE_ENV: process.env.NODE_ENV || "development",

  // Convex
  CONVEX_URL: process.env.CONVEX_URL,

  // Daytona
  DAYTONA_API_KEY: process.env.DAYTONA_API_KEY,
  DAYTONA_API_URL: process.env.DAYTONA_API_URL,
  DAYTONA_TARGET: process.env.DAYTONA_TARGET,
  DAYTONA_SIGNED_PREVIEW_TTL_SEC: parseInt(process.env.DAYTONA_SIGNED_PREVIEW_TTL_SEC || "86400"),

  // Security
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY || "default-key",

  // Auth
  AUTH_ENABLED: process.env.AUTH_ENABLED !== "false",  // default: true

  // Sandbox mode
  SANDBOX_ENABLED: (process.env.SANDBOX_ENABLED ?? process.env.VITE_SANDBOX_ENABLED) !== "false",

  // Clerk
  CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY,

  // OpenCode
  OPENCODE_PORT: parseInt(process.env.OPENCODE_PORT || "4096"),
  OPENCODE_URL: process.env.OPENCODE_URL || `http://127.0.0.1:${process.env.OPENCODE_PORT || "4096"}`,
  OPENCODE_MODELS_URL: process.env.OPENCODE_MODELS_URL || "https://models.dev",
  OPENCODE_DEBUG_WS_PROXY: process.env.OPENCODE_DEBUG_WS_PROXY === "1",

  // Gateway
  CLAXEDO_GATEWAY_URL: process.env.CLAXEDO_GATEWAY_URL,

  // Derived
  get gatewayBaseUrl() { return (this.CLAXEDO_GATEWAY_URL || `http://${this.HOST}:${this.PORT}`).replace(/\/+$/, ""); },
  get isProduction() { return this.NODE_ENV === "production"; },
} as const;
```

### Required Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `CONVEX_URL` | Cloud mode | Convex deployment URL |
| `DAYTONA_API_KEY` | Cloud mode | Daytona API key |
| `DAYTONA_API_URL` | Cloud mode | Daytona API base (appends `/api` if missing) |
| `DAYTONA_TARGET` | Cloud mode | Daytona target region (e.g., `us`) |
| `ENCRYPTION_KEY` | Yes | 32-char key for AES-256-GCM credential encryption |
| `CLERK_SECRET_KEY` | Auth enabled | Clerk secret for JWT verification |
| `CLERK_JWT_ISSUER_DOMAIN` | Convex auth | Clerk issuer for Convex JWT validation |
| `AUTH_ENABLED` | No | Set to `"false"` to disable auth (dev mode) |
| `SANDBOX_ENABLED` | No | Set to `"false"` for local mode |
| `OPENCODE_PORT` | Local mode | Port of local OpenCode server (default: 4096) |

---

## 4. Directory Structure

```
claxedo/
├── .env.local                         # Environment variables (gitignored)
├── .env.example                       # Template for env vars
├── Dockerfile                         # Multi-stage Docker build
├── fly.toml                           # Fly.io deployment config
├── package.json
├── tsconfig.json
├── convex/                            # Convex database functions
│   ├── _generated/                    # Auto-generated Convex client code
│   ├── auth.ts                        # Clerk auth config for Convex
│   ├── authSession.ts                 # Auth session queries
│   ├── backends.ts                    # User backend (tunnel) CRUD
│   ├── convex.config.ts               # Convex app definition
│   ├── http.ts                        # Convex HTTP router (empty)
│   ├── projects.ts                    # Project CRUD + aggregation queries
│   ├── schema.ts                      # Full database schema
│   ├── sessions.ts                    # Chat session sync mutations
│   ├── workspaces.ts                  # Workspace CRUD + sandbox status
│   └── tsconfig.json
├── scripts/
│   └── fetch-models.ts                # Build-time: fetches models.dev data
└── src/
    ├── clients/                       # Singleton API clients
    │   ├── index.ts
    │   ├── convex.ts                  # ConvexHttpClient singleton
    │   └── daytona.ts                 # Daytona SDK singleton
    ├── config/
    │   └── index.ts                   # Centralized config
    ├── generated/                     # Build-time generated files
    │   ├── models-data.json           # AI provider/model catalog
    │   └── models-types.ts            # TypeScript types for models
    ├── observability/                 # Tracing, metrics, error tracking
    │   ├── index.ts                   # Init/shutdown + re-exports
    │   ├── config.ts                  # ObservabilityConfig
    │   ├── metrics/
    │   │   ├── definitions.ts         # All Prometheus metric definitions
    │   │   ├── endpoint.ts            # GET /metrics handler
    │   │   └── middleware.ts          # HTTP metrics middleware + startTimer
    │   ├── sentry/
    │   │   ├── index.ts               # Sentry init/shutdown + helpers
    │   │   └── middleware.ts          # Sentry error capture middleware
    │   └── tracing/
    │       ├── index.ts               # OTEL SDK init, withSpan, getTracer
    │       ├── middleware.ts          # Hono tracing middleware
    │       └── propagation.ts         # W3C trace context propagation
    ├── orchestrator/
    │   └── index.ts                   # SandboxOrchestrator class + encrypt/decrypt
    ├── sandboxes/
    │   ├── index.ts                   # CloudSandbox interface
    │   └── providers/
    │       └── daytona.ts             # DaytonaSandbox implementation
    ├── server/
    │   ├── index.ts                   # Entry point (creates HTTP server)
    │   ├── app.ts                     # Hono app factory
    │   ├── context.ts                 # GatewayContext type
    │   ├── db/
    │   │   └── pages.ts               # SQLite CRUD for page documents
    │   ├── events/
    │   │   ├── index.ts               # Re-exports
    │   │   ├── bus.ts                 # In-memory event bus (Set<EventSink>)
    │   │   ├── types.ts               # GlobalBusEvent, EventSink types
    │   │   ├── upstream.ts            # SSE stream from sandboxes → bus
    │   │   └── local-bridge.ts        # SSE bridge from local OpenCode → bus
    │   ├── lib/
    │   │   ├── index.ts               # Re-exports
    │   │   ├── lazy.ts                # Lazy initialization factory
    │   │   ├── logging.ts             # JSON logging (console + optional file)
    │   │   ├── memoize.ts             # Promise memoization with TTL + SWR
    │   │   ├── memoize.test.ts        # Tests
    │   │   └── paths.ts               # Directory normalization + extraction
    │   ├── middleware/
    │   │   ├── index.ts               # Re-exports
    │   │   ├── auth.ts                # requireAuth, requireWorkspaceAccess
    │   │   ├── cors.ts                # CORS configuration
    │   │   └── request-id.ts          # UUID request ID + timing
    │   ├── proxy/
    │   │   ├── index.ts               # Re-exports
    │   │   ├── directory.ts           # Directory-based proxy (cloud mode)
    │   │   ├── fetch.ts               # fetchFollow (redirect-following fetch)
    │   │   ├── forward.ts             # Shared proxyRequest + handleCorsPreflight
    │   │   ├── headers.ts             # Header manipulation utilities
    │   │   ├── local.ts               # Local OpenCode proxy (local mode)
    │   │   ├── websocket.ts           # WebSocket PTY proxy
    │   │   └── workspace.ts           # Workspace-based proxy (/w/:id/*)
    │   ├── routes/
    │   │   ├── index.ts               # Route constants + re-exports
    │   │   ├── agent-hook.ts          # Agent lifecycle event hooks
    │   │   ├── auth.ts                # PUT /auth/:providerID
    │   │   ├── backend.ts             # Backend (tunnel) CRUD
    │   │   ├── experimental.ts        # DELETE /api/experimental/sandbox
    │   │   ├── global.ts              # Health, config, dispose, SSE events
    │   │   ├── local-runner.ts        # Local OpenCode spawner
    │   │   ├── pages.ts               # Pages proxy to OpenCode
    │   │   ├── project.ts             # Project list, current, update
    │   │   ├── provider.ts            # AI provider listing
    │   │   ├── session.ts             # Session list (from Convex) + create stub
    │   │   └── workspace.ts           # Workspace create, wake, resolve
    │   └── types/
    │       └── roles.ts               # Identity types + role hierarchy
    └── services/
        ├── index.ts                   # Re-exports
        ├── clerk-jwt.ts               # JWT parsing + verification + caching
        ├── credential-sync.ts         # Sync encrypted creds to sandboxes
        ├── identity.ts                # resolveIdentity + storeProviderCredential
        ├── models-cache.ts            # Build-time model data accessor
        ├── project-service.ts         # Cached project lookup by directory
        ├── sandbox-preview.ts         # Daytona signed preview URL resolution
        └── sandbox-resolver.ts        # Directory/workspace → sandbox URL mapping
```

---

## 5. Server Entry Point & Lifecycle

**File**: `src/server/index.ts`

### Startup Sequence

1. **`await initObservability()`** — Initializes OTEL tracing + Sentry
2. **`initOrchestrator({...})`** — Creates `SandboxOrchestrator` singleton with config from env
3. **`App()`** — Lazily creates the Hono app with all middleware + routes
4. **`createServer(getRequestListener(App().fetch))`** — Standard Node.js HTTP server
5. **`createPtyWebSocketServer()`** — `ws.WebSocketServer` with `noServer: true`
6. **`server.on("upgrade", ...)`** — Routes WebSocket upgrades to PTY handler or destroys socket
7. **`server.listen(PORT, HOST, ...)`** — Starts listening
8. **Post-listen (local mode only)**:
   - Dynamically imports `spawnLocalOpenCode()` to auto-start OpenCode
   - If `OPENCODE_PORT !== PORT`, starts SSE bridge via `startBridge()`

### Shutdown (SIGTERM/SIGINT)

1. `stopBridge()` — Stop SSE bridge
2. `killLocalOpenCode()` — Kill spawned OpenCode subprocess
3. `server.close()` — Close HTTP server
4. `shutdownObservability()` — Flush traces + close Sentry
5. `process.exit(0)`

---

## 6. Hono App Factory & Middleware Pipeline

**File**: `src/server/app.ts`

Uses the `lazy()` factory (initialize once, return cached). The app is `new Hono<GatewayContext>()`.

### Middleware Stack (order matters)

1. `logger()` — Hono built-in request logger
2. `requestIdMiddleware()` — Generates UUID, sets `reqId` + `startTime` in context, logs on response
3. `corsMiddleware()` — CORS with dev/prod origin handling
4. `tracingMiddleware()` — OpenTelemetry spans (if `OTEL_ENABLED=true`)
5. `metricsMiddleware()` — Prometheus HTTP metrics (if `PROMETHEUS_ENABLED !== "false"`)
6. `sentryMiddleware()` — Sentry error capture (if `SENTRY_ENABLED=true`)

### Route Mount Order

1. **Metrics endpoint** (`/metrics`) — No auth
2. **Health check** (`GET /api/health`) — No auth, returns `{ healthy: true, version: "claxedo-gateway" }`
3. **Proxy switch** (conditional):
   - **Cloud**: `DirectoryProxyMiddleware()` + `WorkspaceProxyRoutes()`
   - **Local**: `LocalProxyMiddleware()`
4. **Member routes** (`requireAuth("member")`):
   - `GET /api/experimental/*` — ExperimentalRoutes
   - `GET /api/workspace/resolve` — WorkspaceResolveHandler
   - `/global/*` — GlobalRoutes
   - `/project/*` — ProjectRoutes
   - `/session/*` — SessionRoutes
   - `/provider/*` — ProviderRoutes
   - `/api/backend/*` — BackendRoutes
   - `/api/pages/*` — PagesRoutes
5. **Admin routes** (`requireAuth("admin")`):
   - `/auth/*` — AuthRoutes
   - `POST /api/workspace/create` — WorkspaceCreateHandler
   - `POST /api/workspace/wake` — WorkspaceWakeHandler
6. **Workspace proxy routes** (`requireWorkspaceAccess()`):
   - `/w/:workspaceId/*` — WorkspaceProxyRoutes
7. **Static files + SPA fallback** (if `STATIC_DIR` exists):
   - Serve static assets from build output
   - Fallback: serve `index.html` for all unmatched routes

---

## 7. Context & Type System

**File**: `src/server/context.ts`

```typescript
export interface GatewayVariables {
  reqId: string;
  startTime: number;
  identity?: Identity | null;
}
export type GatewayContext = { Variables: GatewayVariables };
```

**File**: `src/server/types/roles.ts`

```typescript
export type OrganizationRole = "admin" | "member";

export interface AuthenticatedIdentity {
  ok: true;
  token: string;
  userId: string;
  organizationId: string;
  role: OrganizationRole;
}

export interface UnauthenticatedIdentity {
  ok: false;
  status: 401 | 403 | 500;
  error: string;
}

export type Identity = AuthenticatedIdentity | UnauthenticatedIdentity;

// Role hierarchy: admin > member
export function hasRole(userRole: OrganizationRole, requiredRole: OrganizationRole): boolean {
  const hierarchy: OrganizationRole[] = ["member", "admin"];
  return hierarchy.indexOf(userRole) >= hierarchy.indexOf(requiredRole);
}
```

---

## 8. Middleware Layer

### Auth Middleware (`src/server/middleware/auth.ts`)

**`requireAuth(minRole)`**:
- If `AUTH_ENABLED=false`: Injects `DEV_IDENTITY` (admin, userId="dev", orgId="dev") and continues
- Otherwise: Calls `resolveIdentity(c)` from services, checks role hierarchy, sets `identity` in context

**`requireWorkspaceAccess()`**:
- Same auth flow as above
- Additionally extracts `:workspaceId` from path param
- Queries `resolveOrganizationIdForWorkspace(workspaceId)` from Convex
- **FAIL CLOSED**: If ownership lookup fails or org doesn't match, returns 403

**`getIdentity(c)`**: Throws if identity not set (middleware not applied)

### CORS Middleware (`src/server/middleware/cors.ts`)

- Dev: Allows all origins
- Production: Strict allowlist (`localhost:5173`, `localhost:4444`, `127.0.0.1:4444`)
- Allowed headers: `Content-Type`, `Authorization`, `x-opencode-directory`
- Methods: `POST, GET, PUT, DELETE, OPTIONS`
- Credentials: true
- Max-age: 600s

### Request ID Middleware (`src/server/middleware/request-id.ts`)

- Generates `crypto.randomUUID()` (fallback: `req_${timestamp}_${random}`)
- Sets `reqId` and `startTime` in context
- In `finally` block: logs JSON with `reqId, method, path, status, durationMs`

---

## 9. Route Definitions

### Route Constants (`src/server/routes/index.ts`)

**`directoryProxyRoots`** — Set of OpenCode API path prefixes to proxy based on directory:
```
agent, command, config, event, experimental, file, find, formatter, global, instance, log, lsp, mcp, path, permission, process, pty, question, session, skill, tui, vcs
```

**`localOnlyProxyRoots`** — Proxied locally but NOT forwarded to sandboxes:
```
auth, provider
```

**`shouldDirectoryProxy(pathname)`** — Checks if first path segment is in `directoryProxyRoots`.

### Global Routes (`src/server/routes/global.ts`)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/global/health` | Returns `{ healthy: true, version: "claxedo-gateway" }` |
| `GET` | `/global/config` | Returns `{ version, server, status }` |
| `POST` | `/global/dispose` | Broadcasts `global.disposed` event to all SSE clients |
| `GET` | `/global/event` | SSE endpoint: sends `server.connected`, then heartbeat every 30s |

The SSE endpoint uses `streamSSE()`. Each connected client is an `EventSink` function added to the bus. On abort, the sink is removed and heartbeat cleared.

### Auth Routes (`src/server/routes/auth.ts`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `PUT` | `/auth/:providerID` | admin | Stores encrypted AI provider credential in Convex |

Validates payload is `{ type: "api", key: string }`. Uses `storeProviderCredential()` which encrypts with AES-256-GCM and syncs to active sandboxes.

### Backend Routes (`src/server/routes/backend.ts`)

Tunnel mode — users register local OpenCode servers via tunnel URLs.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/backend/register` | Register tunnel URL |
| `GET` | `/api/backend` | Get user's backend |
| `GET` | `/api/backend/org` | List org backends |
| `POST` | `/api/backend/heartbeat` | Update lastSeen |
| `DELETE` | `/api/backend` | Remove registration |

Uses `c.get("auth")` (older auth pattern — uses `userId` and `orgId`). All backed by Convex `backends.*` mutations/queries.

### Workspace Routes (`src/server/routes/workspace.ts`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/workspace/create` | admin | Creates project + workspace + sandbox via orchestrator |
| `POST` | `/api/workspace/wake` | admin | Wakes sleeping sandbox, returns `workspaceBaseUrl` |
| `GET` | `/api/workspace/resolve` | member | Maps `?directory=` to workspace, returns `workspaceBaseUrl` |

**Create flow**: Orchestrator creates Convex project → workspace → Daytona sandbox → clones repo → starts OpenCode server → injects credentials → returns info.

**Wake flow**: Gets workspace from Convex → verifies org ownership → calls `sandbox.ensureRunning()` → `ensureOpencodeServer()` → updates Convex status → returns URLs.

**Resolve flow**: Queries `workspaces.getByDirectory` → verifies org ownership → returns `workspaceId`, `projectId`, `workspaceBaseUrl`.

### Session Routes (`src/server/routes/session.ts`)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/session` | Lists sessions from Convex cache (no sandbox wake needed) |
| `POST` | `/session` | Returns 502 (should be handled by proxy, this is fallback) |

**GET /session**: Extracts `directory` from `x-opencode-directory` header or `?directory=` query. Maps directory → workspace via Convex. Fetches cached sessions from `chat_sessions` table. Transforms to OpenCode SDK `Session` format.

### Project Routes (`src/server/routes/project.ts`)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/project` | Lists projects for organization (with workspaces, aggregated query) |
| `GET` | `/project/current` | Gets project for a directory (cached via `getProjectByDirectory`) |
| `PATCH` | `/project/:id` | Updates project metadata (name, icon, commands) |

Uses `Cache-Control: public, max-age=5, stale-while-revalidate=60` on list responses.

### Provider Routes (`src/server/routes/provider.ts`)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/provider` | Returns `{ all, default, connected }` — models.dev catalog + connected providers |
| `GET` | `/provider/auth` | Returns `{}` (stub) |

`all`: From build-time embedded models-data.json. `connected`: From Convex `aiCredentials.listProviders` (checks `hasKey`).

### Experimental Routes (`src/server/routes/experimental.ts`)

| Method | Path | Description |
|--------|------|-------------|
| `DELETE` | `/api/experimental/sandbox` | Deletes sandbox for directory (destroys Daytona sandbox + deletes Convex workspace) |

### Agent Hook Routes (`src/server/routes/agent-hook.ts`)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/agent-lifecycle` | Agent lifecycle events via query params |
| `POST` | `/agent-lifecycle` | Agent lifecycle events via JSON body |

Receives `tabId`, `terminalId`, `workspaceId`, `eventType` (Start/Stop/PermissionRequest). Broadcasts `agent.lifecycle` event to all SSE clients via `broadcastGlobal()`.

### Pages Routes (`src/server/routes/pages.ts`)

Proxies all requests to the local OpenCode server's `/api/pages` endpoint using `proxyRequest()`.

### Local Runner (`src/server/routes/local-runner.ts`)

**`spawnLocalOpenCode()`**: Spawns `bun <entrypoint> serve --port <PORT> --hostname 127.0.0.1` as a child process. Entry point is `packages/opencode/src/index.ts` (resolved relative to this file via `import.meta.url`). Registers cleanup on process exit.

**`killLocalOpenCode()`**: Kills the subprocess if running.

### Pages DB (`src/server/db/pages.ts`)

SQLite database (via `bun:sqlite`) for rich text page documents. Uses WAL mode.

**Schema**:
```sql
CREATE TABLE IF NOT EXISTS pages (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT 'Untitled',
  content TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
```

**Functions**: `listPages()`, `getPage(id)`, `createPage(title?, content?)`, `updatePage(id, patch)`, `deletePage(id)`.

ID format: `page_${Date.now()}_${random7chars}`.

---

## 10. Proxy System

### Shared Proxy Utilities

**`src/server/proxy/headers.ts`**:
- `stripHopByHopHeaders(headers)`: Removes `connection, keep-alive, proxy-authenticate, proxy-authorization, te, trailer, transfer-encoding, upgrade`
- `stripWebSocketClientHandshakeHeaders(headers)`: Removes `sec-websocket-*` and `host`
- `withDevCors(req, headers)`: Adds `access-control-allow-origin: <origin>`, `access-control-allow-credentials: true`, `vary: Origin`
- `looksLikeWsUpgrade(req)`: Checks if `upgrade: websocket` header exists
- `toUpstreamWsUrl(httpUrl)`: Converts `http:` → `ws:`, `https:` → `wss:`

**`src/server/proxy/fetch.ts`**:
- `fetchFollow(url, init, depth)`: Follows redirects manually (up to 5 hops). Uses `redirect: "manual"` to prevent stale `Host` headers. On 303: changes method to GET, removes body.

**`src/server/proxy/forward.ts`**:
- `handleCorsPreflight(c)`: Returns 204 with CORS headers
- `proxyRequest(c, opts)`: Generic request forwarder. Strips hop-by-hop headers, sets `host`, `origin`, `user-agent: claxedo-gateway/1.0`. Reads body as `ArrayBuffer` for binary safety. Uses `fetchFollow()`. Strips `set-cookie` from response.

### Local Proxy (`src/server/proxy/local.ts`)

**When**: `SANDBOX_ENABLED=false`

Mounted as `app.route("/", LocalProxyMiddleware())`. Intercepts all requests matching `directoryProxyRoots` or `localOnlyProxyRoots`. Skips `/api/`, `/w/`, `/s/`, `/hook` prefixes. Proxies to `Config.OPENCODE_URL` with `responseTag: "x-opencode-local"`.

### Directory Proxy (`src/server/proxy/directory.ts`)

**When**: `SANDBOX_ENABLED=true`

Resolves `directory → workspace → sandbox URL` and proxies. Flow:

1. Skip non-proxy paths (`/api/`, `/w/`, `/s/`)
2. Skip if not in `directoryProxyRoots`
3. Optimization: Skip `GET /session` when Convex is configured (handled by SessionRoutes)
4. Extract `directory` from `x-opencode-directory` header or `?directory=` query
5. Resolve via `resolveDirectoryUpstream(directory)` (memoized 5s TTL, 15m SWR)
6. **Auth check** (if AUTH_ENABLED): Verify workspace ownership via Convex
7. Touch directory to ensure upstream SSE stream
8. Proxy to sandbox URL with tracing
9. **Session sync** (fire-and-forget):
   - `POST /session` success → Sync to Convex `sessions.sync`
   - `PATCH/PUT /session/:id` success → Sync update or remove if archived
   - `DELETE /session/:id` → Remove from Convex
10. Cache `GET /agent` and `GET /config` for 5 minutes

### Workspace Proxy (`src/server/proxy/workspace.ts`)

Handles `ALL /w/:workspaceId/*`. Strips the `/w/:workspaceId` prefix from the path before forwarding.

Flow:
1. Reject WebSocket upgrades (HTTP 426)
2. Resolve workspace URL via `resolveWorkspaceUpstream(workspaceId)` (auto-wakes sleeping sandboxes)
3. Strip prefix, proxy to upstream
4. **Credential intercept**: `PUT /auth/:provider` requests are intercepted — credentials are stored in Convex in addition to being forwarded
5. **Provider augmentation**: `GET /provider` responses are enriched with `connected` providers from Convex
6. Cache headers: `Cache-Control: public, max-age=5, stale-while-revalidate=900`

### WebSocket PTY Proxy (`src/server/proxy/websocket.ts`)

Handles WebSocket upgrades for two URL patterns:
- `/w/:workspaceId/pty/:ptyId/connect` (workspace mode)
- `/pty/:ptyId/connect` (directory mode, with `?directory=` param)

**Authentication**: Extracts JWT from `?token=` query param. Verifies via `verifyClerkJwt()`. Checks workspace ownership. **FAIL CLOSED** on all auth errors.

**Proxy bridge**:
1. Resolve upstream URL (local mode → `Config.OPENCODE_URL`, cloud → sandbox URL)
2. Build upstream WebSocket URL: `ws(s)://<upstream>/pty/:ptyId/connect` + forwarded query params (excluding `token`)
3. Add trace context as `?trace=` param (base64url-encoded JSON)
4. Extract `sec-websocket-protocol` for subprotocol negotiation
5. Create upstream `WebSocket` connection
6. Queue client messages until upstream `open`
7. Bridge data bidirectionally (always as UTF-8 text)
8. Clean up on close/error from either side

**Data conversion**: `toText(data)` handles `string | Buffer | ArrayBuffer | Uint8Array | Buffer[]` → UTF-8 string.

**Metrics recorded**: `websocketConnectionsActive`, `websocketMessagesTotal`, `websocketConnectionDuration`, `ptyCreationDuration`, `ptyFirstByteDuration`.

---

## 11. Event System (SSE)

### Types (`src/server/events/types.ts`)

```typescript
export type GlobalBusPayload = { type: string; properties: Record<string, any> };
export type GlobalBusEvent = { directory?: string; payload: GlobalBusPayload };
export type EventSink = (event: GlobalBusEvent) => Promise<void>;
```

### Bus (`src/server/events/bus.ts`)

Simple `Set<EventSink>` with `broadcastGlobal(event)` that calls all sinks via `Promise.allSettled()`.

### Upstream Stream (`src/server/events/upstream.ts`)

Connects to sandbox SSE endpoints and forwards events to the gateway bus. One stream per directory, tracked in `Map<string, AbortController>`.

**`ensureUpstreamGlobalStream(directory)`**: Resolves directory → sandbox URL, connects to `<sandbox>/global/event` SSE, parses events, forwards to bus. Syncs session events to Convex. Auto-reconnects with 1s backoff.

**`touchDirectory(directory)`**: Ensures stream is running for that directory.

### Local Bridge (`src/server/events/local-bridge.ts`)

Used in local mode. Connects to `<localOpenCode>/global/event` SSE and bridges events to the gateway bus.

**Session directory cache**: Maps `sessionId → directory` to fix directory context on events (upstream may use its own CWD instead of the project directory).

**`startBridge(upstreamBase)`**: Connects, auto-reconnects. Filters out `server.connected`/`server.heartbeat` (gateway emits its own).

**`switchBridge(upstreamBase)`**: Stops old, starts new.

---

## 12. Services Layer

### Identity Resolution (`src/services/identity.ts`)

**`resolveIdentity(c)`**: Extracts Bearer token → verifies via Clerk JWKS → extracts `userId`, `organizationId`, `role` from JWT claims. Organization must be in the JWT (no external overrides). Returns `AuthenticatedIdentity | UnauthenticatedIdentity`.

**`storeProviderCredential({providerID, authPayload, organizationId})`**: Encrypts API key with AES-256-GCM → stores in Convex → syncs to active sandboxes via orchestrator.

### Clerk JWT (`src/services/clerk-jwt.ts`)

**`verifyClerkJwt(token)`**: Uses `@clerk/backend.verifyToken()` with `CLERK_SECRET_KEY`. Per-token cache (1-minute TTL, 5s for failures). Falls back to unsafe parsing in dev if `CLERK_SECRET_KEY` not set.

**`parseClerkJwtUnsafe(token)`**: Decodes JWT payload without signature verification. Checks expiration. Extracts org info from multiple claim formats (`org_id`, `o.id`, etc.).

**`getClerkClaimsVerified(request)`**: Per-request caching via `WeakMap<Request, ClerkClaims>`.

**ClerkClaims structure**:
```typescript
interface ClerkClaims {
  userId: string;
  organizationId?: string;
  organizationSlug?: string;
  organizationRole?: string;  // "org:admin" or "org:member"
  exp?: number;
  iat?: number;
  raw: Record<string, unknown>;
}
```

### Sandbox Resolver (`src/services/sandbox-resolver.ts`)

**`resolveOrganizationIdForWorkspace(workspaceId)`**: Memoized (1m TTL, 15m SWR). Queries Convex: workspace → project → organizationId.

**`resolveWorkspaceUpstream(workspaceId)`**: Memoized (5s TTL, 15m SWR). Multi-step resolution:
1. Get workspace from Convex
2. If sandbox not running → wake via orchestrator
3. Get signed preview URL from Daytona
4. If `SandboxNotStartedError` → wake + retry
5. Fallback to stored URL
6. After resolution: sync credentials to sandbox

**`resolveDirectoryUpstream(directory)`**: Memoized (5s TTL, 15m SWR). Maps `directory → workspace → resolveWorkspaceUpstream()`.

**`resolveDirectoryUpstreamWithTunnel(directory, userId)`**: Falls back to user's registered backend URL if no sandbox found.

### Sandbox Preview (`src/services/sandbox-preview.ts`)

**`getSandboxPreviewBaseUrl(sandboxId, port)`**: Gets a signed preview URL from Daytona with configurable TTL. Throws `SandboxNotStartedError` if sandbox state is not "started" (triggers auto-wake in caller).

### Credential Sync (`src/services/credential-sync.ts`)

**`syncCredentialsToSandbox(sandboxUrl, organizationId)`**: One-time sync per `sandboxUrl:organizationId` pair. Fetches all encrypted credentials from Convex → decrypts → PUTs to `<sandbox>/auth/<provider>`.

### Models Cache (`src/services/models-cache.ts`)

Exports build-time embedded provider/model data from `src/generated/models-data.json`. No runtime API calls.

### Project Service (`src/services/project-service.ts`)

**`getProjectByDirectory(directory)`**: Memoized (5s TTL, 15m SWR). Maps `directory → workspace → project` via Convex with workspace list.

---

## 13. Orchestrator & Sandbox Abstraction

### CloudSandbox Interface (`src/sandboxes/index.ts`)

```typescript
export interface CloudSandbox {
  readonly id: string;
  readonly provider: string;
  ensureRunning(): Promise<void>;
  exec(cmd: string, options?: ExecOptions): Promise<ExecResult>;
  spawnPty(options: PtyOptions): Promise<PtyHandle>;
  getServiceUrl(port: number): Promise<string>;
  ensureRepo(repoUrl: string, targetDir: string): Promise<void>;
  destroy(): Promise<void>;
}

export type ExecResult = { code: number; stdout: string; stderr: string };
```

### SandboxOrchestrator (`src/orchestrator/index.ts`)

Singleton pattern (`initOrchestrator(config)` / `getOrchestrator()`).

**Encryption** (AES-256-GCM):
```typescript
async function encrypt(plaintext: string, key: string): Promise<string>
// Key: padded to 32 chars, imported as raw AES-GCM key
// IV: 12 random bytes
// Output: base64(iv + ciphertext)

async function decrypt(encryptedData: string, key: string): Promise<string>
// Reverse of encrypt
```

**Provider ID ↔ Env Key mapping**:
```
vercel/ai-gateway → AI_GATEWAY_API_KEY
openai → OPENAI_API_KEY
anthropic → ANTHROPIC_API_KEY
openrouter → OPENROUTER_API_KEY
groq → GROQ_API_KEY
mistral → MISTRAL_API_KEY
together/togetherai → TOGETHERAI_API_KEY
perplexity → PERPLEXITY_API_KEY
xai → XAI_API_KEY
google/gemini → GOOGLE_GENERATIVE_AI_API_KEY
```

**`createSandbox(request)`** flow:
1. Resolve/create project in Convex (handles both Convex IDs and external IDs)
2. Create workspace in Convex with directory: `/workspace/<safe-projectExternalId>/<safe-workspaceName>/repo`
3. Fetch AI credentials from Convex, decrypt, build env vars
4. Get/create `DaytonaSandbox` instance
5. Inject env vars via `setEnvVars()`
6. `ensureRunning()` — create or start sandbox
7. `ensureRepo()` — clone git repo if URL provided
8. `ensureOpencodeServer()` — start OpenCode server
9. `injectCredential()` — inject each provider credential via OpenCode `/auth/:provider`
10. Update Convex workspace with `sandboxId`, `sandboxUrl`, `sandboxStatus: "running"`
11. Return `SandboxInfo`

**`syncCredentialToSandboxes(orgId, providerID, apiKey)`**: Iterates active sandbox cache, injects credential to all matching org's sandboxes.

### DaytonaSandbox (`src/sandboxes/providers/daytona.ts`)

Full Daytona SDK integration with timeout wrappers.

**Constructor params**: `orgId`, `sessionId`, `apiKey?`, `apiUrl?`, `target?`

**Sandbox naming**: `claxedo-<orgId>-<sessionId>` (lowercased, special chars → `-`, max 80 chars)

**Base Docker image** (`node:22.22.0-bookworm-slim`):
- Installs: bash, zsh, ca-certificates, curl, git, openssh-client, procps, iproute2, netcat-openbsd, python3, make, g++, unzip
- Installs Bun (configurable version, default 1.1.38)
- Installs `opencode-ai@<version>` globally via npm
- Sets `SHELL=/bin/bash`, workdir `/workspace`

**Key methods**:

- **`ensureRunning()`**: Try `daytona.get(name)` → if not found, create from snapshot or image → if not started, `start()` → `ensureTools()` (verify bash/git/curl exist)
- **`exec(cmd, options)`**: Wraps command in `bash -lc "cmd"` via `sandbox.process.executeCommand()`
- **`getServiceUrl(port)`**: Gets signed preview URL + validates by hitting `/global/health`. Falls back to standard preview URL. Validates reachability from both localhost and network interface.
- **`ensureOpencodeServer({port, cwd})`**: Creates session `opencode-<port>`, runs `opencode serve --hostname 0.0.0.0 --port <port>` with env vars. Polls `/global/health` up to 30 times (1s intervals). Verifies reachable on network interface (not just localhost).
- **`ensureRepo(repoUrl, targetDir)`**: Tries Daytona's `git.clone()` first, falls back to in-sandbox `git clone --depth 1`.
- **`injectCredential(port, providerID, apiKey)`**: `curl -X PUT http://127.0.0.1:<port>/auth/<provider>` with JSON body.
- **`destroy()`**: `daytona.delete(sandbox)`, ignores 404.
- **`diagnosePort(port)`**: Comprehensive diagnostics (listening ports, preview URLs, health checks, logs).

**Timeout configuration**:
- `DAYTONA_TIMEOUT_MS`: 10000ms default (for operations like start, delete)
- `DAYTONA_READ_TIMEOUT_MS`: 30000ms default (for get, snapshot.get)
- Sandbox creation: 300000ms (5 minutes)
- Snapshot creation: 120000ms (2 minutes)

**Auto-stop**: `autoStopInterval: 60` (60 minutes of inactivity)

---

## 14. Observability Stack

### Configuration (`src/observability/config.ts`)

| Feature | Env Var | Default |
|---------|---------|---------|
| OTEL tracing | `OTEL_ENABLED=true` | disabled |
| OTEL endpoint | `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` |
| OTEL sample rate | `OTEL_TRACE_SAMPLE_RATE` | 1.0 dev, 0.1 prod |
| Prometheus | `PROMETHEUS_ENABLED` | enabled (unless `=false`) |
| Prometheus path | `PROMETHEUS_PATH` | `/metrics` |
| Sentry | `SENTRY_ENABLED=true` | disabled |
| Sentry DSN | `SENTRY_DSN` | — |
| Sentry sample rate | `SENTRY_TRACES_SAMPLE_RATE` | 1.0 dev, 0.1 prod |

### Prometheus Metrics (`src/observability/metrics/definitions.ts`)

All use custom `metricsRegistry` (includes default Node.js metrics).

**HTTP**:
- `http_request_duration_seconds` (Histogram) — labels: method, route, status
- `http_requests_total` (Counter) — labels: method, route, status

**Sandbox**:
- `sandbox_creation_duration_seconds` (Histogram) — labels: org_id, from_snapshot, status
- `sandbox_creations_total` (Counter) — same labels
- `active_sandboxes` (Gauge) — labels: org_id, status

**Workspace**:
- `workspace_creation_duration_seconds` (Histogram) — labels: org_id, has_repo, status
- `workspace_wake_duration_seconds` (Histogram) — labels: org_id, status
- `workspace_deletion_duration_seconds` (Histogram) — labels: org_id, status

**Session**:
- `session_creation_duration_seconds` (Histogram) — labels: workspace_id, status
- `active_sessions` (Gauge) — labels: workspace_id

**PTY/Terminal**:
- `pty_creation_duration_seconds` (Histogram) — labels: workspace_id, status
- `pty_first_byte_duration_seconds` (Histogram) — labels: workspace_id

**WebSocket**:
- `websocket_connections_active` (Gauge) — labels: type
- `websocket_messages_total` (Counter) — labels: type, direction
- `websocket_message_latency_seconds` (Histogram) — labels: type
- `websocket_connection_duration_seconds` (Histogram) — labels: type, close_reason

**External API**:
- `daytona_api_duration_seconds` (Histogram) — labels: operation, status
- `convex_query_duration_seconds` (Histogram) — labels: operation, status

**Proxy**:
- `proxy_request_duration_seconds` (Histogram) — labels: proxy_type, status
- `proxy_resolution_duration_seconds` (Histogram) — labels: proxy_type, cache_hit

**Credentials**:
- `credential_sync_duration_seconds` (Histogram) — labels: org_id, status
- `credential_sync_total` (Counter) — labels: org_id, provider, status

### Metrics Middleware (`src/observability/metrics/middleware.ts`)

Route normalization replaces UUIDs, workspace IDs, PTY IDs, session IDs, project IDs, and numeric IDs with placeholders to prevent high cardinality.

**`startTimer()`**: Returns a function that, when called, returns elapsed seconds (uses `process.hrtime.bigint()`).

### Tracing (`src/observability/tracing/`)

- **OTEL SDK** with `BatchSpanProcessor` (5s flush, 2048 queue, 512 batch)
- **Parent-based sampler** with ratio-based root sampling
- **`withSpan(name, fn, options)`**: Creates span, sets status, records exceptions
- **Middleware**: Creates `SERVER` span per HTTP request with standard attributes
- **Propagation**: W3C trace context injection/extraction. WebSocket variant encodes trace context as base64url JSON in query param.

### Sentry (`src/observability/sentry/`)

- Integrates with OTEL trace IDs (adds `trace_id`/`span_id` tags)
- Ignores: `ECONNRESET`, `EPIPE`, `ETIMEDOUT`, `ResizeObserver loop limit exceeded`
- Middleware captures unhandled errors with request context
- Helper functions: `captureException`, `captureMessage`, `setUser`, `addBreadcrumb`

---

## 15. Convex Database Layer

### Schema (`convex/schema.ts`)

**`projects`**:
| Field | Type | Description |
|-------|------|-------------|
| organizationId | string | Clerk org ID |
| name | string | Project display name |
| repoUrl | string? | Git repository URL |
| branch | string? | Git branch |
| externalId | string? | Stable external ID (e.g., `proj-...`) |
| sandboxSnapshotId | string? | Daytona snapshot ID |
| icon | object? | `{ url?, override?, color? }` |
| commands | object? | `{ start? }` |
| createdAt | number | Timestamp |
| updatedAt | number | Timestamp |

Indexes: `by_org(organizationId)`, `by_org_name(organizationId, name)`, `by_external(externalId)`

**`workspaces`**:
| Field | Type | Description |
|-------|------|-------------|
| projectId | string | Convex project ID |
| name | string | Workspace/branch name |
| directory | string | Filesystem directory path |
| sandboxId | string? | Daytona sandbox ID |
| sandboxUrl | string? | Sandbox preview URL |
| sandboxStatus | string? | "running", "stopped", "deleted" |
| createdAt | number | Timestamp |
| updatedAt | number | Timestamp |

Indexes: `by_project(projectId)`, `by_project_name(projectId, name)`, `by_directory(directory)`

**`aiCredentials`**:
| Field | Type | Description |
|-------|------|-------------|
| organizationId | string | Clerk org ID |
| provider | string | "openai", "anthropic", etc. |
| encryptedKey | string | AES-256-GCM encrypted API key |
| createdAt | number | Timestamp |
| updatedAt | number | Timestamp |

Indexes: `by_org(organizationId)`, `by_org_provider(organizationId, provider)`

**`chat_sessions`**:
| Field | Type | Description |
|-------|------|-------------|
| workspaceId | string | Convex workspace ID |
| sessionId | string | OpenCode session ID |
| slug | string | URL-friendly session slug |
| title | string | Session title |
| createdAt | number | Timestamp |
| updatedAt | number | Timestamp |

Indexes: `by_workspace(workspaceId)`, `by_session_id(sessionId)`

**`user_backends`**:
| Field | Type | Description |
|-------|------|-------------|
| userId | string | Clerk user ID |
| organizationId | string | Clerk org ID |
| backendUrl | string | Tunnel URL to local OpenCode |
| lastSeen | number | Heartbeat timestamp |
| createdAt | number | Timestamp |

Indexes: `by_user(userId)`, `by_org(organizationId)`

### Convex Auth Config (`convex/auth.ts`)

Uses Clerk JWT validation:
```typescript
{
  providers: [{
    domain: process.env.CLERK_JWT_ISSUER_DOMAIN!,
    applicationID: "convex",
  }]
}
```

### Convex Functions

**`projects.ts`**: `getById`, `getByExternalId`, `listByOrg`, `listByOrgWithWorkspaces` (server-side join), `create`, `update` (merges icon/commands), `remove`.

**`workspaces.ts`**: `getById`, `getByDirectory`, `getByProjectAndName`, `listByProject`, `create` (upserts by project+name), `updateSandbox`, `deleteWorkspace` (cascades to sessions).

**`sessions.ts`**: `sync` (upsert by sessionId), `list` (by workspace, desc), `remove`.

**`aiCredentials.ts`**: `getByOrg`, `getByOrgAndProvider`, `listProviders` (returns `{provider, hasKey, createdAt, updatedAt}`), `set` (upsert), `remove`, `removeAll`.

**`backends.ts`**: `get` (by userId), `listByOrg`, `register` (upsert), `heartbeat`, `remove`.

**`authSession.ts`**: `getCurrentUser`, `validateAuth` — use Convex built-in auth.

---

## 16. Build & Deployment

### Dockerfile (Multi-stage)

**Stage 1 (deps)**: `oven/bun:1.3.5`. Copies workspace package.json files for the claxedo dependency chain (app, app-shared, claxedo-app, ui, util, sdk/js). Stubs out unused workspace packages. `bun install` with cache mount.

**Stage 2 (frontend-builder)**: Copies `packages/` source. Sets `CLAXEDO_OVERRIDES=1`. Runs `bun run build` in `packages/claxedo-app`. Build args: `VITE_CLERK_PUBLISHABLE_KEY`, `VITE_CONVEX_URL`, `VITE_CONVEX_SITE_URL`.

**Stage 3 (backend-builder)**: Copies `claxedo/src/`, `claxedo/scripts/`, `claxedo/convex/`. Runs `bun run ./scripts/fetch-models.ts` to generate models data.

**Stage 4 (runtime)**: `oven/bun:1.3.5-slim`. Installs `curl`. Creates `claxedo` user (UID 1001). Copies: `node_modules`, `claxedo/node_modules`, frontend `dist` → `/app/public`, backend source + convex. Runs as non-root. Health check: `curl -f http://localhost:8080/api/health`. Entry: `bun run /app/claxedo/src/server/index.ts`.

### Fly.io Config (`fly.toml`)

- App: `claxedo-gateway`, region: `sjc`
- Port: 8080, force HTTPS
- `auto_stop_machines = false` (WebSocket connections)
- `min_machines_running = 1`
- Concurrency: 250 hard, 200 soft (connections)
- Health check: `GET /api/health` every 30s
- VM: `shared-cpu-1x`, 512MB

### Build Script

**`scripts/fetch-models.ts`**: Fetches `https://models.dev/api.json` at build time. Writes `src/generated/models-data.json` (with `_generatedAt` and `_source` metadata) and `src/generated/models-types.ts`.

---

## 17. Library Utilities

### Lazy (`src/server/lib/lazy.ts`)

```typescript
function lazy<T>(fn: () => T): (() => T) & { reset: () => void }
```
Initializes on first call, returns cached value thereafter. `reset()` clears the cache.

### Logging (`src/server/lib/logging.ts`)

```typescript
function makeReqId(): string      // crypto.randomUUID() with fallback
function nowMs(): number           // Date.now()
function logJson(level, payload)   // Formatted console output + optional file logging
```

Log format: `<time> <INF|WRN|ERR> [<kind>] key=value key=value`

File logging enabled by `CLAXEDO_FILE_LOGGING=true` (writes to `claxedo-gateway.log`).

### Memoize (`src/server/lib/memoize.ts`)

```typescript
function memoizePromise<T>(
  fn: (...args) => Promise<T>,
  ttlMs: number,
  swrMs?: number,        // Stale-While-Revalidate window
  keyFn?: (...args) => string
): (...args) => Promise<T>
```

Three-tier cache behavior:
1. **Fresh** (within TTL): Return immediately
2. **Stale** (TTL expired, within SWR window): Return stale value immediately, trigger background refresh. Only one refresh at a time per key.
3. **Expired** (past SWR): Block on fresh fetch. Concurrent callers coalesce on the same promise.

Cache eviction: When size exceeds 1000 entries, removes fully expired entries.

### Paths (`src/server/lib/paths.ts`)

```typescript
function normalizeDirectory(input: string): string  // Trims, removes trailing slashes
function directoryFrom(c: any): string               // Extracts from x-opencode-directory header or ?directory= query
```

---

## 18. Security Model

### Authentication Flow

1. Frontend sends Clerk JWT in `Authorization: Bearer <token>` header
2. Gateway verifies JWT signature via `@clerk/backend.verifyToken()` with `CLERK_SECRET_KEY`
3. Organization ID comes **exclusively from JWT claims** — no external overrides
4. Role extracted from Clerk claims: `org:admin` → admin, `org:member` → member

### Authorization Levels

| Level | Middleware | What it gates |
|-------|-----------|---------------|
| None | — | `/api/health`, `/metrics`, static files |
| Member | `requireAuth("member")` | Read operations, project/session/provider listing |
| Admin | `requireAuth("admin")` | Workspace create/wake, credential storage |
| Workspace Owner | `requireWorkspaceAccess()` | Proxy to specific workspace |

### FAIL CLOSED Principle

All ownership checks fail closed:
- If organization lookup fails → 403 (not 200)
- If workspace not found → 403 (not pass-through)
- WebSocket auth: no token → destroy socket with HTTP error
- All `catch` blocks in auth paths return denial, not pass-through

### Credential Security

- API keys encrypted with **AES-256-GCM** (12-byte random IV)
- Encryption key from `ENCRYPTION_KEY` env var (padded/truncated to 32 bytes)
- Stored as `base64(iv + ciphertext)` in Convex
- Decrypted only when injecting into sandbox or syncing
- JWT tokens never forwarded to sandboxes (stripped from WebSocket `?token=` param)
- `set-cookie` headers stripped from all proxy responses

### Dev Mode Bypass

When `AUTH_ENABLED=false`:
- All auth middleware injects `DEV_IDENTITY` (userId="dev", orgId="dev", role="admin")
- WebSocket auth bypassed with `DEV_AUTH_RESULT`
- Clerk JWT parsing falls back to unsafe (no signature verification) if `CLERK_SECRET_KEY` not set

---

## Appendix: Test Files

### `src/server/lib/memoize.test.ts`
Tests: cache hit, TTL expiry, different args, concurrent coalescing, stale-while-revalidate. Uses `bun:test`.

### `src/server/proxy/cloud.test.ts`, `forward_url.test.ts`, `local.test.ts`, `routes.test.ts`
Proxy-related tests.

### `src/server/routes/auth.test.ts`, `creation.test.ts`
Route-specific tests.

---

## Appendix: Client Singletons

### Convex Client (`src/clients/convex.ts`)
```typescript
function getConvex(): ConvexHttpClient  // Lazy singleton, requires CONVEX_URL
```

### Daytona Client (`src/clients/daytona.ts`)
```typescript
function getDaytona(): Daytona  // Lazy singleton, auto-appends /api to URL
```

