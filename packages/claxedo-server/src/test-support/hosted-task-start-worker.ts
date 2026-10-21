import type { D1Database } from "@cloudflare/workers-types"
import { Hono } from "hono"
import type { ControlPlanePrincipal, RequestAuthenticationAdapter } from "@claxedo/server-core/platform/auth/authentication"
import { AuthenticationError } from "@claxedo/server-core/platform/auth/authentication"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { memorySandboxPassRegister } from "@claxedo/server-core/platform/auth/sandbox-pass-register"
import { composeHostedTasksPlugin } from "../deployments/hosted-workerd/tasks-plugin/compose"
import { composeHostedSessionPorts } from "../plugin-backends/sessions/compose"
import { hostedSessionFixture } from "./hosted-session-fixture"
import { testRequestAuthenticationAdapter } from "./request-authentication"

type Env = {
  CONTROL_PLANE_DB: D1Database
  CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: string
  CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: string
}

const ISSUER = "https://auth.test"

/**
 * The hosted Tasks routes the Worker entry mounts, over the real D1 control
 * plane, the real hosted session host and a sandbox manager on the D1 lease
 * store (`hosted-session-fixture.ts`). Faked besides: the person's sign-in.
 */
function compose(env: Env) {
  const database = env.CONTROL_PLANE_DB
  const { authority, services, starts, hooks } = hostedSessionFixture(database, "test")
  const principals = new Map<string, ControlPlanePrincipal>()
  const authentication: RequestAuthenticationAdapter = {
    descriptor: testRequestAuthenticationAdapter().descriptor,
    async authenticate(request) {
      const token = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1]
      const principal = token ? principals.get(token) : undefined
      if (!principal) throw new AuthenticationError(401, "invalid_credentials", "Authentication credential is invalid")
      return principal
    },
  }
  const signedAs = (subject: string): SignedControlPlaneAuth => {
    const principal = principals.get(subject)
    if (!principal) throw new Error(`${subject} has not signed in`)
    return {
      mode: "signed",
      token: subject,
      user: { subject: principal.userId, tokenIdentifier: `${ISSUER}|${subject}`, issuer: ISSUER },
      principal,
    }
  }
  const app = new Hono()
  for (const contribution of composeHostedTasksPlugin({
    services,
    database,
    authentication,
    sessions: composeHostedSessionPorts({ services, database, sandboxStart: starts.start }),
    cloudSelectedCapabilities: true,
    grants: {
      signingEnv: {
        CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM,
        CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM,
      },
      passes: memorySandboxPassRegister(),
      groupEnabled: async () => true,
    },
  }).routeContributions) {
    app.route(contribution.path, contribution.routes)
  }
  app.route("/", hooks)

  app.post("/__person", async (c) => {
    const { subject } = await c.req.json<{ subject: string }>()
    const identity = { adapter: "better-auth" as const, issuer: ISSUER, subject }
    const admitted = await authority.ensureApplicationIdentity(identity)
    if (admitted.state !== "active") return c.json({ error: admitted.state }, 409)
    principals.set(subject, {
      userId: admitted.userId,
      actorId: admitted.actorId,
      actorKind: "human",
      deploymentId: "test",
      sessionId: `session:${subject}`,
      authenticatedAt: Date.now(),
      methods: ["oauth:google"],
      assurance: "single-factor",
      identity,
      client: {
        id: "claxedo-cli",
        kind: "cli",
        tokenKind: "access-token",
        resource: "https://core.test/control-plane",
        scopes: ["workspace:read", "workspace:write"],
        deploymentId: "test",
        adapter: identity.adapter,
        issuer: identity.issuer,
        tokenEndpointOrigin: identity.issuer,
        controlPlaneOrigin: "https://core.test",
      },
    })
    return c.json({ userId: admitted.userId })
  })

  app.post("/__workspace", async (c) => {
    const body = await c.req.json<{ subject: string; workspaceId: string; repoUrl: string; gitBranch: string }>()
    await authority.createCloudWorkspace(signedAs(body.subject), {
      workspaceId: body.workspaceId,
      displayName: body.workspaceId,
      repoUrl: body.repoUrl,
      gitBranch: body.gitBranch,
      remoteDirectory: "/workspace",
      homeRegion: "us-east",
    })
    const row = await database
      .prepare("select project_id, org_id from workspaces where workspace_id = ?")
      .bind(body.workspaceId)
      .first<{ project_id: string; org_id: string }>()
    return c.json({ projectId: row?.project_id, orgId: row?.org_id })
  })

  app.get("/__rows", async (c) => {
    const read = (sql: string) => database.prepare(sql).all().then((result) => result.results)
    return c.json({
      workspaces: await read("select workspace_id, project_id, backing, display_name, repo_url, git_branch, deleted_at from workspaces order by created_at"),
      sessions: await read("select session_id, workspace_id, project_id, deleted_at from sessions"),
      links: await read("select task_id, slot, attempt, session_id, session_workspace_id, placement from task_session_links"),
      leases: await read("select workspace_id, status from sandbox_leases"),
    })
  })

  return app
}

let composed: Hono | undefined

export default {
  async fetch(request: Request, env: Env) {
    composed ??= compose(env)
    return composed.fetch(request)
  },
}
