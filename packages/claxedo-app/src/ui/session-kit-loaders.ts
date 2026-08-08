import { ensureOpenCodeTheme } from "@opencode-ai/ui/context/marked"

export async function loadFileComponent() {
  const [module] = await Promise.all([
    import("@opencode-ai/session-ui/file"),
    ensureOpenCodeTheme(),
  ])
  return module.File
}
