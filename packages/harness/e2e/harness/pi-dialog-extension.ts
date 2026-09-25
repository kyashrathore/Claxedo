import fs from "node:fs/promises"
import path from "node:path"

export async function writePiDialogExtension(directory: string) {
  const extensionDir = path.join(directory, ".pi", "extensions")
  await fs.mkdir(extensionDir, { recursive: true })
  const script = process.env.CLAXEDO_E2E_PI_OMIT_DIALOGS === "1"
    ? `export default function (pi) { pi.on("before_agent_start", async () => {}); }`
    : `import { writeFileSync } from "node:fs"; export default function (pi) { pi.on("before_agent_start", async (_event, ctx) => { const selected = await ctx.ui.select("Select environment", ["Staging", "Production"]); const confirmed = await ctx.ui.confirm("Confirm environment", "Proceed?"); const input = await ctx.ui.input("Explain environment"); const edited = await ctx.ui.editor("Edit summary", "seed"); const timeout = await ctx.ui.input("Expiring dialog", undefined, { timeout: 100 }); writeFileSync("pi-dialog-receipt.json", JSON.stringify({ selected, confirmed, input, edited, timeout: String(timeout) })); }); }`
  await fs.writeFile(path.join(extensionDir, "dialogs.ts"), script)
}
