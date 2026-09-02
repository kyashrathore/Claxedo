import { downloads, github, contact, version } from "../config"
import { canonicalUrl, routes } from "./routes"
import { site } from "./site"
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

- Run Claude Code, Codex, Cursor, or OpenCode from one workspace instead of separate terminals.
- Configure plugins, skills, MCP servers, and credentials once and have every agent read the same setup.
- Move a coding session between a laptop and a cloud VM on a sandbox provider they already pay for.
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

> ${site.headline}

${site.description}

- Open source, MIT licensed, built on the OpenCode engine.
- Desktop app for macOS, Windows, and Linux: ${canonicalUrl(routes.download)}
- Hosted product: ${site.clients.web.destination}
- Source: ${github}
- Community: ${contact}

## What it does

1. **Set up once.** Add a plugin, skill, MCP server, or credential one time. Claxedo writes it into each agent's own config before a session starts.
2. **Anywhere.** Move a session from your laptop to a cloud VM on any supported provider. Your setup arrives before the agent does.
3. **Anyone.** Multiplayer on a Cloudflare Worker you deploy in one command. Invite your team and approve edits from a phone.
4. **Your way.** Sidebar or tabs. The chat view and the real CLI live in the same workbench.
5. **Fast.** A published, repeatable benchmark against T3 Code; see the comparison pages for the current figures.

## Pages

- Pricing: ${canonicalUrl(routes.pricing)} (markdown: ${canonicalUrl(markdownTwins[routes.pricing])})
- Download: ${canonicalUrl(routes.download)} (markdown: ${canonicalUrl(markdownTwins[routes.download])})
- Compare: ${canonicalUrl(routes.compare)} (markdown: ${canonicalUrl(markdownTwins[routes.compare])})
- About: ${canonicalUrl(routes.about)}
- Contact: ${canonicalUrl(routes.contact)}

${whenToUse}`

export const pricingMarkdown = `# Claxedo pricing

> ${site.freeBeta}.

Use Claxedo Cloud without a subscription charge during beta, deploy the open control plane to your own Cloudflare account, or start entirely locally. The paid offer will be explained before billing begins.

## Included today ($0)

- Claxedo Desktop with account-free local mode
- Connected Claxedo product during beta
- MIT-licensed client, control plane, and workspace runtime
- macOS, Windows, and Linux downloads

## What you bring

- **Models:** your provider subscriptions or API credentials. Claxedo does not bundle token credits.
- **Compute:** your local machine, remote infrastructure, or a supported sandbox provider.
- **Operations:** if you self-host, you operate that deployment and its security boundary.

Paid-offer terms and future subscription prices will be published when billing is active.

- Download: ${canonicalUrl(routes.download)}
- Pricing page (HTML): ${canonicalUrl(routes.pricing)}
`

export const downloadMarkdown = `# Download Claxedo Desktop

> Claxedo Desktop v${version}. Local mode works without an account.

Claxedo Desktop works locally without an account or subscription. Sign in when you want the connected Claxedo experience across browser, desktop, and remote workspaces.

## Builds

${downloads.map((d) => `- ${d.label} (${d.format}): ${d.href}`).join("\n")}

Artifacts are served from the GitHub release: ${github}/releases/tag/claxedo-v${version}. Code signing and checksums are shown only when the release publishes them.

## After installing

1. Open a workspace and run sessions or terminals without a Claxedo account.
2. Sign in when you want connected capabilities across supported clients and machines.
3. Bring your own model credentials, compute, and sandboxes. Claxedo does not include usage credits.

- Download page (HTML): ${canonicalUrl(routes.download)}
`

export const compareMarkdown = `# Claxedo compared

> Most tools in this field are single-operator apps or closed clouds. Claxedo is the harness-neutral, open-source, multi-user workspace your team self-hosts. Every claim on the comparison pages links to a first-party source.

## Published comparisons

${currentComparisons.map((c) => `- Claxedo vs. ${c.name}: ${canonicalUrl(`${routes.compare}/${c.slug}`)}`).join("\n")}

## How to read them

- Capability tables mark each item as yes, partial, or no, with notes and sources.
- Comparisons are dated and expire; only maintained pages stay published.
- The fastest comparison is running both tools on the same task.

- Comparison index (HTML): ${canonicalUrl(routes.compare)}
- Scoped index for agents: ${canonicalUrl(`${routes.compare}/llms.txt`)}
`
