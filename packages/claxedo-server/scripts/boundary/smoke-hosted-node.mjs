import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const ROOT = path.resolve(import.meta.dirname, "../..")
const entry = await import(path.join(ROOT, "dist-boundary/hosted-node/index.js"))
for (const name of ["composeHostedNodeControlPlane", "createHostedNodeApp", "startHostedNodeServer"]) {
  if (typeof entry[name] !== "function") throw new Error(`built hosted Node export is missing: ${name}`)
}

const privateKey = [
  "-----BEGIN PRIVATE KEY-----",
  "MC4CAQAwBQYDK2VwBCIEIO9Cnka2wu8+h1a1Rd+bDejAsq2oUxO6BnDKjrHrpw54",
  "-----END PRIVATE KEY-----",
].join("\n")
const publicKey = [
  "-----BEGIN PUBLIC KEY-----",
  "MCowBQYDK2VwAyEAvy35aYUPAjG/Zac6ER0AiB0BZteRmYnpMZ5b1U0SJGs=",
  "-----END PUBLIC KEY-----",
].join("\n")
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-hosted-node-boundary-"))
try {
  process.env.CLAXEDO_DATA_DIR = dataDir
  const app = entry.createHostedNodeApp({
    CLAXEDO_DEPLOYMENT_MODE: "hosted",
    CLAXEDO_SIGNED_CLOUD_AUTH: "true",
    CLERK_JWT_ISSUER: "https://clerk.test",
    CLERK_JWKS_URL: "https://clerk.test/jwks",
    CLAXEDO_WORKSPACE_AUTHORITY_URL: "https://convex.test",
    CLAXEDO_WORKSPACE_RELAY_URL: "https://relay.test",
    CLAXEDO_RELAY_RESOLVER_TOKEN: "resolver-token",
    CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN: "control-plane-service-token",
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: privateKey,
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: publicKey,
  })
  const response = await app.fetch(new Request("http://boundary.test/api/claxedo/health"))
  const body = await response.json()
  if (response.status !== 200 || body.ok !== true || body.mode !== "hosted-control-plane" || body.localExecution !== false) {
    throw new Error(`built hosted Node health failed: ${response.status} ${JSON.stringify(body)}`)
  }
  console.log("[server-cloud-node] built Node entry health passed")
} finally {
  delete process.env.CLAXEDO_DATA_DIR
  fs.rmSync(dataDir, { recursive: true, force: true })
}
