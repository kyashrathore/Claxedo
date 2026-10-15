import { appendFileSync } from "node:fs"
import { formatBoatRuntimeTemplate } from "@claxedo/sandbox-manager/drivers/boat"
import { ensureBoatRuntimeTemplate, pruneBoatRuntimeTemplates, shareBoatRuntimeTemplate } from "@claxedo/sandbox-manager/drivers/boat-template"
import { assertSandboxImageReference } from "@claxedo/sandbox-manager/image-name"

const RUNTIME_TEMPLATE_SECRET = "CLAXEDO_BOAT_RUNTIME_TEMPLATE"

const args = process.argv.slice(2)
const option = (name: string) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const image = option("image")
const prefix = option("prefix")
const shareTo = option("share-to")
const apiKey = process.env.BOAT_API_KEY?.trim()
if (!image || !apiKey || args.some((arg) => !/^--(image|prefix|share-to)=/.test(arg))) {
  console.error("usage: BOAT_API_KEY=<the release's Boat key> bun scripts/sandbox/boat-runtime-template.ts --image=<runtime image> [--prefix=<name prefix>] [--share-to=<env file>]")
  console.error("Builds the image's Boat runtime template unless it exists (one billable builder sandbox, deleted after), prunes older templates,")
  console.error(`and with --share-to appends ${RUNTIME_TEMPLATE_SECRET}=<image and a new share code> to that file for the deploy to upload as a Worker secret.`)
  process.exit(2)
}

const options = {
  apiKey,
  image: assertSandboxImageReference(image),
  ...(prefix ? { prefix } : {}),
  log: (line: string) => console.log(line),
}
const { name, built } = await ensureBoatRuntimeTemplate(options)
console.log(built ? `built template ${name}` : `reused template ${name}`)
await pruneBoatRuntimeTemplates(options)
if (shareTo) {
  const template = await shareBoatRuntimeTemplate(options)
  // GitHub Actions masks the code in every later log line of the job; the env file carries it to the deploy step.
  if (process.env.GITHUB_ACTIONS === "true") console.log(`::add-mask::${template.shareCode}`)
  appendFileSync(shareTo, `${RUNTIME_TEMPLATE_SECRET}=${formatBoatRuntimeTemplate(template)}\n`)
  console.log(`shared template ${name} as ${RUNTIME_TEMPLATE_SECRET}`)
}
