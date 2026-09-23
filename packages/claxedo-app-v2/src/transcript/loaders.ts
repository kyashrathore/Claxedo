import { ensureOpenCodeTheme } from "@opencode-ai/ui/context/marked"

export async function loadFileComponent() {
  const [module] = await Promise.all([import("./file"), ensureOpenCodeTheme()])
  return module.File
}

export async function loadMarkdownComponent() {
  const [module] = await Promise.all([import("./markdown"), ensureOpenCodeTheme()])
  return module.Markdown
}
