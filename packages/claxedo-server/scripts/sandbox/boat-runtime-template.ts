import { appendFileSync } from "node:fs"
import { formatBoatRuntimeTemplate } from "@claxedo/sandbox-manager/drivers/boat"
import {
  ensureBoatRuntimeTemplate,
  pruneBoatRuntimeTemplates,
  revokeBoatRuntimeTemplateShares,
  shareBoatRuntimeTemplate,
} from "@claxedo/sandbox-manager/drivers/boat-template"
import { assertSandboxImageReference } from "@claxedo/sandbox-manager/image-name"

const RUNTIME_TEMPLATE_SECRET = "CLAXEDO_BOAT_RUNTIME_TEMPLATE"
const RUNTIME_TEMPLATE_SHARE_ID = "CLAXEDO_BOAT_RUNTIME_TEMPLATE_SHARE_ID"

const args = process.argv.slice(2)
const option = (name: string) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const image = option("image")
const prefix = option("prefix")
const shareTo = option("share-to")
const deployedShare = option("deployed-share")
const apiKey = process.env.BOAT_API_KEY?.trim()
if (!image || !apiKey || (shareTo && deployedShare) || args.some((arg) => !/^--(image|prefix|share-to|deployed-share)=/.test(arg))) {
  console.error("usage: BOAT_API_KEY=<the release's Boat key> bun scripts/sandbox/boat-runtime-template.ts --image=<runtime image> [--prefix=<name prefix>] [--share-to=<env file> | --deployed-share=<share id>]")
  console.error("Builds the image's Boat runtime template unless it exists (one billable builder sandbox, deleted after).")
  console.error(`--share-to appends ${RUNTIME_TEMPLATE_SECRET}=<image and a new share code> and ${RUNTIME_TEMPLATE_SHARE_ID} to that file, for the deploy to upload.`)
  console.error("--deployed-share, once that deploy succeeded, revokes the template's other codes and prunes templates of older images.")
  process.exit(2)
}

const options = {
  apiKey,
  image: assertSandboxImageReference(image),
  ...(prefix ? { prefix } : {}),
  log: (line: string) => console.log(line),
}
if (deployedShare) {
  const revoked = await revokeBoatRuntimeTemplateShares(options, deployedShare)
  console.log(`revoked ${revoked.length} share code(s) other than ${deployedShare}`)
  await pruneBoatRuntimeTemplates(options)
} else {
  const { name, built } = await ensureBoatRuntimeTemplate(options)
  console.log(built ? `built template ${name}` : `reused template ${name}`)
  if (shareTo) {
    const { template, shareId } = await shareBoatRuntimeTemplate(options)
    // GitHub Actions masks the code in every later log line of the job; the env file carries it to the deploy step.
    if (process.env.GITHUB_ACTIONS === "true") console.log(`::add-mask::${template.shareCode}`)
    appendFileSync(shareTo, `${RUNTIME_TEMPLATE_SECRET}=${formatBoatRuntimeTemplate(template)}\n${RUNTIME_TEMPLATE_SHARE_ID}=${shareId}\n`)
    console.log(`shared template ${name} as ${RUNTIME_TEMPLATE_SECRET} (share ${shareId})`)
  }
}
