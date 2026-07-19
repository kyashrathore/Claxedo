---
layout: ../layouts/Prose.astro
title: "Claxedo — Privacy Policy"
description: "What Claxedo collects, what it doesn't, and how to remove your data. Written in plain language by a small team."
---

# Privacy Policy

> Effective date: 2026-07-19

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

Claxedo can integrate with [PostHog](https://posthog.com) for product analytics and [Sentry](https://sentry.io) for error reporting. Both are **opt-in by deployment configuration**. If no keys are configured — which is the default — these integrations are a complete no-op: nothing is sent, no network calls are made. A build with keys configured is the only build that sends anything.

## Payments

There are none. Claxedo is free at launch, so we do not collect or process any payment information.

## Email

We do not send marketing email, and claxedo.com does not email you.

## Deleting your data

In local mode, deleting the app and its local data removes everything. In hosted mode, delete your account to remove your hosted identity and metadata, or [open a GitHub issue](https://github.com/kyashrathore/Claxedo/issues) and we'll help you remove it.

## Changes to this policy

If we change how data is handled, we'll update this page and move the effective date forward. Because Claxedo is open source, you can always read the actual code to verify what it does.

Questions? [GitHub issues](https://github.com/kyashrathore/Claxedo/issues) is the place.
