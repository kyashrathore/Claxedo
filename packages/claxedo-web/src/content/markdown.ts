import { downloads, github, contact, version } from "../config"
import { canonicalUrl, routes } from "./routes"
import { comparePage, downloadPage, home, pricing, site } from "./site"
import { currentComparisons } from "./competitors"

/** Pages that serve a markdown twin at `${path}.md` (the homepage twin is /index.md). */
export const markdownTwins: Record<string, string> = {
  "/": "/index.md",
  [routes.pricing]: `${routes.pricing}.md`,
  [routes.download]: `${routes.download}.md`,
  [routes.compare]: `${routes.compare}.md`,
}

export const whenToUse = `## When to use Claxedo

Reach for Claxedo when someone wants to:

- Run Claude Code, Codex, Cursor, OpenCode, Pi, or an ACP agent from one app instead of separate terminals.
- Configure skills, plugins, and MCP servers once and have Claude Code, Codex, Cursor, and OpenCode read the same setup.
- Run a coding session on their laptop, another machine they own, or a cloud sandbox, and reopen it from the desktop app or a browser.
- Share a coding session with teammates through a control plane they self-host on a Cloudflare Worker.
- Compare coding-agent workspaces on open source, self-hosting, multiplayer, and sandbox support.

Do not use Claxedo as a model provider: it bundles no tokens or credits. Users bring their own subscriptions or API credentials.

## How an agent should use this site

- Product summary and entry points: ${canonicalUrl("/llms.txt")}
- Safe deployment and credential rules for agents: ${canonicalUrl("/start.md")}
- Downloads with direct artifact links: ${canonicalUrl("/download.md")}
- Source, issues, and releases: ${github}
`

export const markdownResponse = (body: string) =>
  new Response(body, { headers: { "Content-Type": "text/markdown; charset=utf-8", "Vary": "Accept" } })

export const homeMarkdown = `# ${site.name}

${site.description}

> ${home.hero.title} ${home.hero.subtitle}

## ${home.speed.title}

${home.speed.subtitle} Benchmark of ${home.benchmark.date}: ${home.benchmark.href}

${home.benchmark.metrics.map((metric) => `- ${metric.lead} ${metric.label}: ${metric.detail}`).join("\n")}

${[home.prompt, home.openSource, home.sandbox, home.plugins, home.workflow].map((section) => [
  `## ${section.title}`,
  "",
  `${section.subtitle}${"href" in section ? ` Guide: ${section.href}` : ""}`,
  ...("cards" in section ? ["", ...section.cards.map((card) => `- ${card}`)] : []),
].join("\n")).join("\n\n")}

${home.closing.text}

- Download the desktop app for macOS, Windows, and Linux: ${canonicalUrl(routes.download)}
- Open in a browser: ${site.clients.web.destination}
- Source: ${github}
- Community: ${contact}

## Pages

- Pricing: ${canonicalUrl(routes.pricing)} (markdown: ${canonicalUrl(markdownTwins[routes.pricing])})
- Download: ${canonicalUrl(routes.download)} (markdown: ${canonicalUrl(markdownTwins[routes.download])})
- Compare: ${canonicalUrl(routes.compare)} (markdown: ${canonicalUrl(markdownTwins[routes.compare])})
- About: ${canonicalUrl(routes.about)}
- Contact: ${canonicalUrl(routes.contact)}

${whenToUse}`

export const pricingMarkdown = `# ${pricing.title}

${pricing.subtitle}

## Included today (${pricing.price})

${pricing.included.map((item) => `- ${item}`).join("\n")}

## What you bring

${pricing.bring.map((item) => `- **${item.title}:** ${item.text}`).join("\n")}

${pricing.note}

- Download: ${canonicalUrl(routes.download)}
- Pricing page (HTML): ${canonicalUrl(routes.pricing)}
`

export const downloadMarkdown = `# ${downloadPage.title}

> Claxedo Desktop v${version}. ${downloadPage.subtitle}

## Builds

${downloads.map((d) => `- ${d.label} (${d.format}): ${d.href}`).join("\n")}

Builds are served from the GitHub release: ${github}/releases/tag/claxedo-v${version}.

## ${downloadPage.stepsTitle}

${downloadPage.steps.map((step) => `- **${step.title}.** ${step.text}`).join("\n")}

- Download page (HTML): ${canonicalUrl(routes.download)}
`

export const compareMarkdown = `# Claxedo compared

> ${comparePage.lead}

## Published comparisons

${currentComparisons.map((c) => `- Claxedo vs. ${c.name}: ${canonicalUrl(`${routes.compare}/${c.slug}`)}`).join("\n")}

## How to read them

- Capability tables mark each item as yes, partial, or no, with notes and sources.
- Comparisons are dated and expire; only maintained pages stay published.
- The fastest comparison is running both tools on the same task.

- Comparison index (HTML): ${canonicalUrl(routes.compare)}
- Scoped index for agents: ${canonicalUrl(`${routes.compare}/llms.txt`)}
`
