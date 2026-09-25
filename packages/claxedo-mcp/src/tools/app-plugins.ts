import { z } from "zod"
import type { AppPluginsGrant, AppPluginRegistration } from "../client/contract"
import { appPluginsDenied, type McpToolContext } from "../context"
import type { ToolRegistrar } from "./registry"
import { declaredToolAccess } from "./inventory"
import { APP_PLUGIN_GUIDE } from "./app-plugins-guide"
import { toolJson, toolText } from "./target"

const DIRECTORY_ARG = {
  directory: z.string().trim().min(1).describe("Absolute path of the plugin folder, inside this session's workspace."),
} as const

function grant(ctx: McpToolContext, tool: string): AppPluginsGrant {
  const { appPlugins } = ctx.client
  if (!appPlugins) throw appPluginsDenied(tool)
  return appPlugins
}

function renderRegistration(row: AppPluginRegistration) {
  const next = row.status === "failed"
    ? "Its first build failed; fix the error below and save, and the daemon rebuilds it."
    : "The Claxedo app now asks the person to turn it on. It runs only after they confirm; every later save goes live."
  return {
    id: row.id,
    name: row.name,
    directory: row.directory,
    status: row.status,
    ...(row.lastError ? { lastError: row.lastError } : {}),
    next,
  }
}

export function registerAppPluginTools(registry: ToolRegistrar) {
  registry.tool(
    "app_plugin_create",
    {
      description:
        "Scaffold a Claxedo app plugin: a folder with a package.json carrying the claxedo manifest and src/app.tsx, which adds a page and a sidebar item to the Claxedo app. Use only when the person asked for a plugin. Returns the folder and the authoring guide; then edit it, run app_plugin_check, and app_plugin_add it.",
      inputSchema: {
        name: z.string().trim().min(1).max(80).describe("The plugin's display name, such as Standup notes; its id is derived from it."),
        directory: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Absolute path of a new, empty folder inside this session's workspace. Defaults to <workspace>/.claxedo/plugins/<id>."),
      },
      access: declaredToolAccess({ audiences: ["runtime"], write: true, scope: "act", appPlugins: true }),
    },
    async (args, ctx) => {
      const created = await grant(ctx, "app_plugin_create").create({ name: args.name, ...(args.directory ? { directory: args.directory } : {}) })
      return toolText([
        `Created the app plugin ${created.name} (${created.id}) at ${created.directory}: ${created.files.join(", ")}.`,
        "Edit it, run app_plugin_check until it is ok, then app_plugin_add it.",
        "",
        APP_PLUGIN_GUIDE,
      ].join("\n"))
    },
  )

  registry.tool(
    "app_plugin_check",
    {
      description:
        "Typecheck a Claxedo app plugin folder against @claxedo/plugin-api and Solid, then build it. Returns { ok, diagnostics }, each diagnostic with its file, line, column and message. Writes nothing.",
      inputSchema: { ...DIRECTORY_ARG },
      access: declaredToolAccess({ audiences: ["runtime"], write: false, scope: "read", appPlugins: true }),
    },
    async (args, ctx) => toolJson(await grant(ctx, "app_plugin_check").check(args.directory)),
  )

  registry.tool(
    "app_plugin_add",
    {
      description:
        "Register a Claxedo app plugin folder with this machine's Claxedo daemon, which builds it, watches it and serves every build to the app. The app asks the person to turn the plugin on before it runs. Add a folder once; later saves go live on their own.",
      inputSchema: { ...DIRECTORY_ARG },
      access: declaredToolAccess({ audiences: ["runtime"], write: true, scope: "act", appPlugins: true }),
    },
    async (args, ctx) => toolJson(renderRegistration(await grant(ctx, "app_plugin_add").add(args.directory))),
  )

  registry.tool(
    "app_plugin_guide",
    {
      description: "The Claxedo app plugin authoring guide: the loop, the manifest, the plugin API and the rules the app enforces. Read it before changing an existing plugin.",
      inputSchema: {},
      access: declaredToolAccess({ audiences: ["runtime"], write: false, scope: "read", appPlugins: true }),
    },
    async () => toolText(APP_PLUGIN_GUIDE),
  )
}
