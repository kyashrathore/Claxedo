---
layout: ../layouts/Prose.astro
title: "Claxedo — Privacy Policy"
description: "What Claxedo collects, what it doesn't, and how to remove your data. Written in plain language by a small team."
---

# Privacy Policy

> Effective date: 2026-08-05

Claxedo is a free, open-source (MIT) coding-agent workspace built by a small team. This page explains, in plain language, what data the software touches and who else can see it. If anything here is unclear, [open a GitHub issue](https://github.com/kyashrathore/Claxedo/issues) and ask.

## Local mode (the default)

When you run the Claxedo desktop app on your own machine, your work stays on your machine. Your code, files, terminal sessions, chat history, and API keys live in local storage on your device. We do not have a server that receives them, and we cannot see them.

Your code runs locally, or inside sandboxes that *you* configure and control. When an agent talks to a model provider (Anthropic, OpenAI, Google, and so on), it uses your own API keys and talks to that provider directly. We do not proxy, log, or store those requests. Each provider's own privacy policy governs what they do with the prompts you send them.

## Hosted mode (optional)

If you choose to use the hosted cloud control plane, some coordination data leaves your device so that your workspaces can sync and be reached from more than one place:

- **Authentication** is handled by [Better Auth](https://better-auth.com), which stores your account identity (such as your email and login credentials) in the deployment's own database.
- **Workspace and session metadata** — things like workspace names, session identifiers, and timestamps — is stored in [Cloudflare D1](https://developers.cloudflare.com/d1/) databases owned by the deployment. Your source code is not the point of this database; it holds the metadata needed to coordinate sessions.
- **Infrastructure** runs on [Cloudflare](https://cloudflare.com), which processes network traffic to deliver the service.

You only enter hosted mode by signing in and opting into it.

## Telemetry (opt-in, off by default)

Claxedo can integrate with [PostHog](https://posthog.com) for both product analytics and error tracking — it's the only telemetry vendor Claxedo uses. Telemetry is **opt-in by deployment configuration**, and self-hosted and self-built deployments default to off.

### This website

claxedo.com measures page views and download clicks so we can tell which pages are useful and which platforms people want builds for.

**This site sets no cookies.** Analytics state is kept in your browser's session storage and is discarded when you close the tab, so there is no cross-site or cross-visit tracking and no consent banner to click through. Page addresses are reduced to their section (`/download`, `/compare`) before being sent — the specific page you read is never recorded. PostHog derives an approximate **country** from your IP address on its servers; we do not collect precise location, and the site never asks your browser for it.

### The desktop app

Official Claxedo-distributed desktop builds report two things:

- **A one-time install event** the first time a new profile launches. It carries a randomly generated install identifier, your operating system, CPU architecture, OS version, and the app version. The identifier is random — it is not derived from your machine, username, hardware, or network — so two installs by the same person cannot be linked.
- **An app-launch event** each time the app starts, which is how we count how many people actively use Claxedo day to day.

Builds you compile yourself send neither: both require a key that is only present in official releases, and both are additionally gated on `CLAXEDO_TELEMETRY_MODE=on`.

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
