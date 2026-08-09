const entry = await import("../dist/self-hosted-execution.js")

for (const name of [
  "createLocalApp",
  "mountLocalRouteFamilies",
  "startLocalServer",
  "createWorkspaceRuntimeProxy",
]) {
  if (typeof entry[name] !== "function") throw new Error(`built Local Server export is missing: ${name}`)
}

console.log("[local-server] built entry smoke passed")
