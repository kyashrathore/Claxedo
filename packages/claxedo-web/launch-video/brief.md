# Brief

**The one sentence the viewer must remember:** Claxedo is one app that runs every coding agent wherever it should run, and the session keeps going when you walk away.

## Audience

Developers and team leads who already use one or more coding agents (Claude Code, Codex, Cursor, Pi, OpenCode) and juggle them across a laptop, other machines and cloud sandboxes. They know what a terminal, a branch and an API key are; they have seen a hundred AI launch videos and skip the ones that look like the rest.

## Deliverables

| Cut | Size | Rate | Length | Use |
|---|---|---|---|---|
| Film | 1920×1080 | 60 fps | 62.5 s | Launch post, site, YouTube |
| Social | 1080×1920 | 60 fps | 28.5 s | Phone feeds; its own composition, not a crop |
| Loop | 1920×1080 | 60 fps | 6 s, seamless | Site hero background |

H.264 High, yuv420p, CRF 16, `+faststart`. Film and social carry a score synthesised in this folder; the loop is silent. No voiceover.

## Real assets (and nothing else)

- Type: the site's `--font-display` / `--font-sans` stack (SF Pro Display / Text on macOS) and `public/fonts/claxedo-mono.woff2`.
- Colour: `src/styles/site.css` and `src/styles/app-theme.css` tokens (see `style-guide.md`).
- Artwork: the Daniell plates in `src/assets/home/` (1-bit Bayer dithers, `#aaaaaa` dots), revealed the way `TajPlate.astro` reveals them.
- Brand: `public/brand/claxedo-mark.svg` (58-square pixel C), `public/brand/claxedo-wordmark-light.svg`.
- Harness marks: the five glyphs in `src/components/HarnessMark.astro`, read from that file at serve time.
- Icons: `src/icons/index.ts`, imported directly.
- Product UI: rebuilt as DOM from the app's own strings (`packages/claxedo-app/src/**/i18n`, `locales/en.ts`) and the UX-audit screenshots (r1-app, a2a, a2b, settings, batch-b).

The video folder imports from the site; the site never imports the video.

## Approved copy

Every line on screen comes from `site.ts`, `claims.ts`, the app's English strings, or the owner-vouched list.

| On screen | Source |
|---|---|
| Every coding agent. | `harness-coverage` (Claude Code, Codex, Cursor, OpenCode, Pi built in) |
| Built in, side by side. No lock-in. | `harness-coverage`; hero subtitle "Every agent, no lock-in." |
| Your accounts. Your models. / Your own subscriptions or API keys. No credits to buy. | `pricing.bring` (Models) |
| Wherever it should run. | `connected-placement`, `bring-your-own-sandbox` |
| Search where it runs · Online · Offline · Running · Asleep · New cloud workspace… · Connect a machine… | app strings (`projects.where.*`, `cloud.status.*`) |
| This workspace is asleep. Your next message wakes it. · Wake now · Waking {name} · Starting the machine, about a minute | app strings (`sessionScreen.workspace.*`) |
| A live session in the cloud. | `connected-placement` (cloud sandbox) |
| Ran 2 commands | app (`work-group-summary.ts`) |
| Or open a real terminal right beside it. | `home.workflow.subtitle`, `sessions-and-terminals` |
| Keeps going while you're away. / Pick up every session on desktop, browser or phone. | owner brief; `home.sandbox.subtitle`, `connected-placement` |
| Set up plugins once. / Add your team's plugin repo once. Everyone turns on what they need. | `home.plugins`, `team-plugin-sharing` (owner-vouched) |
| Every agent, every machine. / On in Claude Code, Codex, Cursor and OpenCode, on every machine you sign in to. | `home.plugins.cards[2]`, `agent-plugins` (those four harnesses), `agent-plugins-follow-you` |
| Five minutes to your own deploy. / Open source. MIT licensed. On your own Cloudflare. | `cloudflare-five-minutes` (owner-vouched), `mit-platform` |
| `bun run deploy:user-cloudflare` · D1 databases created · Migrations applied · Worker deployed · App published · Live at https://claxedo.yourteam.dev | `crops/DeployTerminal.astro`; the command is `packages/claxedo-server/scripts/deploy/deploy-user-cloudflare.ts` |
| your-org/agent-plugins · Skills 12 · MCP servers 4 · Commands 6 · Hooks 3 | example repo; counts from `crops/AddSource.astro` |
| Claude Code · Codex · Cursor · Pi · OpenCode; Claude Sonnet 5.5, GPT-6.1 Sol, Composer 1, GPT-6 Sol, Claude Opus 5.5 | harness names as the picker shows them; model names as the app lists them in the UX-audit screens and harness fixtures (the app reads models from each harness at runtime, so there is no static catalog) |
| Own your coding agent app. · Download for macOS · Windows, Linux and Intel Macs · claxedo.com | `home.hero.title`, `MacDownload.astro`, `routes.ts` |

Demo content inside the product (project `payments`, workspace `checkout`, machine `studio-mac`, the webhook-retry prompt) is illustration, not a claim. No metrics, customers or benchmarks appear.
