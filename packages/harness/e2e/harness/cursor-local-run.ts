import { Agent } from "@cursor/sdk"

const [prompt, directory] = process.argv.slice(2)
if (!prompt || !directory) throw new Error("usage: cursor-local-run.ts <prompt> <directory>")
const agent = await Agent.create({ apiKey: "cursor-placeholder", model: { id: "scripted" }, local: { cwd: directory, settingSources: ["user"] } })
try {
  const run = await agent.send(prompt)
  for await (const _ of run.stream()) continue
  const result = await run.wait()
  console.log(JSON.stringify({ status: result.status, result: result.result }))
} finally {
  agent.close()
}
