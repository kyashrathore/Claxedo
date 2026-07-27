---
layout: ../layouts/Prose.astro
title: "Claxedo — Privacy Policy"
description: "What Claxedo collects, what it doesn't, and how to remove your data. Written in plain language by a small team."
---

# Privacy Policy

> Effective date: 2026-07-28

Claxedo is a free, open-source (MIT) coding-agent workspace built by a small team. This page explains, in plain language, what data the software touches and who else can see it. If anything here is unclear, [open a GitHub issue](https://github.com/kyashrathore/Claxedo/issues) and ask.

## Local mode (the default)

When you run the Claxedo desktop app on your own machine, your work stays on your machine. Your code, files, terminal sessions, chat history, and API keys live in local storage on your device. We do not have a server that receives them, and we cannot see them.

Your code runs locally, or inside sandboxes that *you* configure and control. When an agent talks to a model provider (Anthropic, OpenAI, Google, and so on), it uses your own API keys and talks to that provider directly. We do not proxy, log, or store those requests. Each provider's own privacy policy governs what they do with the prompts you send them.

## Hosted mode (optional)

If you choose to use the hosted cloud control plane, some coordination data leaves your device so that your workspaces can sync and be reached from more than one place:

- **Authentication** is handled by [Clerk](https://clerk.com), which stores your account identity (such as your email and login credentials).
- **Workspace and session metadata** — things like workspace names, session identifiers, and timestamps — is stored in [Convex](https://convex.dev). Your source code is not the point of this database; it holds the metadata needed to coordinate sessions.
- **Infrastructure** runs on [Cloudflare](https://cloudflare.com), which processes network traffic to deliver the service.

You only enter hosted mode by signing in and opting into it.

## Telemetry (opt-in, off by default)

Claxedo can integrate with [PostHog](https://posthog.com) for both product analytics and error tracking — it's the only telemetry vendor Claxedo uses. Telemetry is **opt-in by deployment configuration**, and self-hosted deployments default to off.

When telemetry is turned on, two kinds of data can be sent:

- **Feature events** — which parts of the product get used, tagged with your user and organization identifiers so we can tell how many people rely on a feature.
- **Exception reports** — crash and error details, including stack traces, so bugs can be found and fixed.

What is never sent: your prompts, source text, credentials, or repository contents. File paths from your workspace are never sent as literal text — only a file's extension plus a one-way hash of the path, which cannot be turned back into the original path. If a session comes in through an external channel (Slack, Telegram, and so on), that channel's user id is hashed before it's sent — never sent raw.

Two controls decide whether any of this happens, and either one is enough to turn telemetry off:

- **`CLAXEDO_TELEMETRY_MODE=off`** disables telemetry outright, even if a key is configured — this is checked before Claxedo ever looks for a key.
- **If no keys are configured — which is the default** — this integration is a complete no-op: nothing is sent, no network calls are made. A build with keys configured, running in `on` mode, is the only build that sends anything.

## Payments

There are none. Claxedo is free at launch, so we do not collect or process any payment information.

## Email

We do not send marketing email, and claxedo.com does not email you.

## Deleting your data

In local mode, deleting the app and its local data removes everything. In hosted mode, delete your account to remove your hosted identity and metadata, or [open a GitHub issue](https://github.com/kyashrathore/Claxedo/issues) and we'll help you remove it.

## Changes to this policy

If we change how data is handled, we'll update this page and move the effective date forward. Because Claxedo is open source, you can always read the actual code to verify what it does.

Questions? [GitHub issues](https://github.com/kyashrathore/Claxedo/issues) is the place.
