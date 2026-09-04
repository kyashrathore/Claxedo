/**
 * Drives the running Claxedo app in a real browser and captures what it shows.
 *
 *   node browser-verify.mjs <url> <out.png>
 */
import { chromium } from "playwright"

const url = process.argv[2] ?? "http://127.0.0.1:4444/"
const out = process.argv[3] ?? "/tmp/claxedo-app.png"

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

const consoleErrors = []
const pageErrors = []
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text().slice(0, 300))
})
page.on("pageerror", (error) => pageErrors.push(String(error).slice(0, 300)))

// NOT networkidle: the app holds a live event stream open, so it never idles.
const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 })
console.log("HTTP_STATUS", response?.status())
await page.waitForTimeout(6_000)

console.log("TITLE", await page.title())
const bodyText = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").trim()
console.log("VISIBLE_TEXT", bodyText.slice(0, 600) || "(empty)")
console.log("ROOT_CHILDREN", await page.locator("#root > *").count())

await page.screenshot({ path: out, fullPage: false })
console.log("SCREENSHOT", out)

if (pageErrors.length) console.log("PAGE_ERRORS", JSON.stringify(pageErrors.slice(0, 5), null, 1))
if (consoleErrors.length) console.log("CONSOLE_ERRORS", JSON.stringify(consoleErrors.slice(0, 8), null, 1))

await browser.close()
