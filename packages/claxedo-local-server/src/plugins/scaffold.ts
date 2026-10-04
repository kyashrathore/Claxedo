import { PLUGIN_ID_MAX_LENGTH, PLUGIN_ID_PATTERN, PLUGIN_NAME_MAX_LENGTH, type PluginManifest } from "@claxedo/plugin-api"

export class AppPluginAuthoringError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AppPluginAuthoringError"
  }
}

export function appPluginId(name: string): string {
  const id = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, PLUGIN_ID_MAX_LENGTH)
    .replace(/-+$/, "")
  if (!PLUGIN_ID_PATTERN.test(id)) throw new AppPluginAuthoringError(`"${name}" makes no plugin id: use letters or digits`)
  return id
}

function appSource(manifest: PluginManifest) {
  const page = JSON.stringify(manifest.id)
  const title = JSON.stringify(manifest.name)
  return `import { definePlugin } from "@claxedo/plugin-api"

export default definePlugin({
  activate(api) {
    api.pages.register({
      id: ${page},
      path: ${JSON.stringify(`/${manifest.id}`)},
      title: ${title},
      render: () => (
        <section>
          <h1>{${title}}</h1>
        </section>
      ),
    })
    api.sidebar.item({ id: ${page}, label: ${title}, pageId: ${page} })
  },
})
`
}

export function appPluginScaffold(name: string): { manifest: PluginManifest; files: Readonly<Record<string, string>> } {
  const displayName = name.trim().slice(0, PLUGIN_NAME_MAX_LENGTH)
  const manifest: PluginManifest = {
    id: appPluginId(displayName),
    name: displayName,
    version: "0.1.0",
    app: "./src/app.tsx",
    requires: [],
    server: { routes: [], operations: [] },
  }
  const packageJson = { name: `claxedo-plugin-${manifest.id}`, version: manifest.version, private: true, type: "module", claxedo: manifest }
  return {
    manifest,
    files: {
      "package.json": `${JSON.stringify(packageJson, null, 2)}\n`,
      "src/app.tsx": appSource(manifest),
    },
  }
}
