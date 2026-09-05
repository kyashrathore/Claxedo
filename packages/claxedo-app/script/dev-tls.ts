/**
 * Mints the self-signed localhost certificate the signed-web dev server runs
 * on (`CLAXEDO_DEV_TLS=1`, see vite.cloud.config.ts). Idempotent: an existing
 * pair is kept. The browser shows its interstitial once for a self-signed
 * certificate; proceeding is the one-time cost of a local HTTPS origin.
 */
import { existsSync, mkdirSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const dir = fileURLToPath(new URL("../.artifacts/dev-tls/", import.meta.url))
const key = `${dir}key.pem`
const cert = `${dir}cert.pem`
mkdirSync(dir, { recursive: true })
if (existsSync(key) && existsSync(cert)) {
  console.log(`[dev-tls] keeping ${cert}`)
} else {
  const result = spawnSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "365",
    "-keyout", key, "-out", cert,
    "-subj", "/CN=localhost",
    "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ], { stdio: "inherit" })
  if (result.status !== 0) {
    console.error("[dev-tls] openssl failed; install openssl or mint the pair another way")
    process.exit(1)
  }
  console.log(`[dev-tls] wrote ${cert}`)
}
