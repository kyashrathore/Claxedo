# Security Policy

## Reporting a vulnerability

If you discover a security vulnerability in Claxedo, please report it privately rather than opening a public GitHub issue.

- Use [GitHub's private vulnerability reporting](https://github.com/kyashrathore/Claxedo/security/advisories/new) for this repository — this is the only channel we monitor for security reports.

Please include:

- A description of the vulnerability and its potential impact
- Steps to reproduce (proof-of-concept code/commands if possible)
- Affected version/commit

We aim to acknowledge reports within a few business days. Please give us reasonable time to investigate and address the issue before any public disclosure.

## Scope

Claxedo is a coding-agent platform that runs agents with access to shell execution, file operations, and network access, similar in threat model to the upstream [OpenCode](https://github.com/anomalyco/opencode) engine it is built on. The permission system is a UX safeguard to keep you aware of what an agent is doing — it is **not** a sandbox or a security isolation boundary. If you need strong isolation, run Claxedo sessions inside a container or VM.

Please prioritize reports involving:

- Authentication/authorization bypass in the control plane or hosted product
- Remote code execution reachable without an already-authenticated session
- Credential/secret leakage across workspaces, teams, or users
- Data exposure between tenants in the hosted (cloud) product

Lower-priority (still welcome, but not urgent security escalations):

- Issues requiring an attacker to already have local shell access equivalent to the user running Claxedo
- Denial-of-service via resource exhaustion on self-hosted instances

## Supported versions

Claxedo ships continuously from the `dev` branch and via npm (`@claxedo/*` packages) and GitHub Releases. Please report issues against the latest released version; we do not maintain long-term-support branches at this stage.
