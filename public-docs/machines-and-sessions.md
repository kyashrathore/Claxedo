# Machines, Workspaces and Sessions

This guide describes how you work with your own machines, cloud environments and
teammates in Claxedo. It assumes the "host is a machine" model: every place an
agent can run is a **machine** you own, and a **workspace** is a folder on one of
them. The app decides on its own whether to talk to a machine directly or through
the relay; you never pick a transport.

## The three kinds of machine

| Kind | What it is | How it gets there |
|---|---|---|
| **Your desktop** | The computer the desktop app is running on, named after you and the machine, for example "Yashvardhan's Mac". | Comes with the desktop app. Nothing to install. |
| **Another machine you own** | A laptop, a workstation, a VPS, a build box. | Run one command on it: `claxedo connect`. |
| **Cloud** | A sandbox Claxedo provisions for you on a cloud provider. | Add a provider key in Settings; create environments from the composer. |

All three show up in the same list, under **Settings → Machines**, and every
workspace on them appears in the sidebar the same way. Every machine has a name.
The desktop app names its own machine from the account name on that computer
and the computer's own name, so it reads the same on every device: on the
desktop, on the web, on your phone it is "Yashvardhan's Mac". A workspace is
never labelled "local" or "user-hosted"; it is labelled by the machine it is on.

## Add a machine

### The computer you are sitting at

Install the desktop app and sign in. Your machine appears in the list under its
own name immediately, and every project you open in the app runs on it. You can
rename it in Settings → Machines; the name is what teammates and your other
devices see.

If you want to reach this machine from the web app or from another device, turn
on **Enable remote access** in Settings → Machines. From then on every workspace
you open on this machine is published to your account, and later ones are
published as you open them. Turning remote access off stops publishing and
stops the machine from being reachable; nothing is deleted.

Remote access is a per-machine switch, not a per-workspace choice. The switch
states what it does: your workspace names and paths are sent to the control
plane so your other devices can find them.

### Another machine

On a signed-in laptop, mint an invitation:

```sh
claxedo host invite --name build-box --root ~/code
```

The command prints a single-use token once. On the machine you are adding,
install the CLI and enroll with that token:

```sh
curl -fsSL https://raw.githubusercontent.com/kyashrathore/Claxedo/dev/packages/cli/install.sh | sh
claxedo connect --token-file ./invite.txt --install-service
```

The machine enrolls, starts a background service, and appears in Settings →
Machines within a few seconds. `--root` decides which folders that machine may
ever serve; you can widen or narrow it later with `claxedo host scope`.

If the machine already runs the desktop app, do not run `claxedo connect` on it.
The desktop app already serves it under its own enrollment, and `connect`
refuses to start beside a running desktop unless you force it.

### A cloud environment

Open Settings → Cloud, add your sandbox provider key, and you are done. Cloud
environments are created on demand when you start a session with a cloud
destination (below). Each environment is a machine like any other; it shows up
in Settings → Machines with its provider name while it exists.

## Start a session

Every session starts from the composer. The composer has a **destination**
control that names the machine and folder the session will run in. The default
is the workspace you are looking at.

### On the machine you are sitting at

Open a project from your disk, or drop a folder into the app, and press send.
The session runs here. This works signed out and offline.

### On another machine you own

Pick the machine in the destination control, then a folder under one of its
roots. If the folder is not a workspace yet, the app creates one and assigns it
to that machine. The machine starts the session inside the next heartbeat; you
will see it appear in the sidebar under that machine.

You can also assign folders ahead of time from a laptop:

```sh
claxedo host assign --machine build-box ~/code/service
```

### In the cloud

Pick **Cloud** in the destination control and choose a repository. Claxedo
provisions an environment, clones the repository into it, and starts the session
there. Cloud sessions can clone any repository your account can reach.

While a cloud environment is provisioning, the session shows its progress in
place; you do not need to wait before typing your first prompt.

### From the web

The web app shows the same machines and workspaces as the desktop, under the
same names. Starting a session on your desktop machine from the web, say
"Yashvardhan's Mac", works only while that machine's remote access is on.
Sessions on cloud environments and on machines you added with `claxedo connect`
work from the web without any extra step.

## Remove things

| To remove | Do this |
|---|---|
| A session | Delete it from the session's menu. It disappears everywhere at once. |
| A workspace from a machine | `claxedo host unassign --machine <name> <dir>`, or remove it from the machine's row in Settings → Machines. Files on disk are not touched. |
| A machine | **Revoke this machine** in Settings → Machines, or `claxedo host revoke --machine <name>`. The machine's key stops working immediately; its service exits on the next heartbeat and will not restart into a revoked enrollment. |
| A cloud environment | Close it from Settings → Machines or from the workspace's row. The environment is destroyed; sessions that ran there stay readable. |
| Your desktop's remote access | Turn the switch off. The machine keeps working locally. |

To wipe a connected machine's own state, for example to enroll it under a
different account, run `claxedo connect --reset` on that machine.

## Share sessions with teammates

Sharing is per session, not per machine or workspace. A teammate never gets
access to your folder, your terminals or your other sessions by being shared one
session.

1. Open the session and use **Share session** in the people control.
2. Add the teammate and pick what they may do:
   - **Follow**: they read that session live, on whichever machine it runs,
     including a session running on your laptop while remote access is on.
   - **Send messages**: they can also prompt the agent in that session. When you
     pick this, the dialog states the consequence before you confirm: the agent
     runs on the workspace's machine with that machine's files, so a teammate
     who can prompt it can ask it to read anything there, including the
     transcripts of your other sessions in that workspace. Sharing works best
     for sessions on a cloud environment, where each session has a machine of
     its own. If a machine holds anything you would not want a teammate to
     reach, do not share sessions from workspaces on it.
3. Remove them from the same control to revoke either level. Their live view
   ends within a few seconds; nothing they saw is retained on their side beyond
   what they already read.

What a shared teammate sees and does not see:

- They see the transcript as it streams, tool activity, and permission prompts
  the agent raises. With **Send messages** they can answer those prompts and
  send their own.
- Through the app they do not see the workspace's other sessions, its
  terminals, its files outside the session, or its event stream. If they open a
  terminal link from the session, they are refused. The only path to other
  content is through the agent itself, which is why sending is a separate,
  disclosed grant.
- If they also have workspace access through your organization, they still only
  see the sessions they created or were shared. Workspace membership does not
  open other members' private sessions.

Sessions you created on your machine before you turned remote access on are
yours: the first time you open one from the web or another device, it is
registered under your name and becomes readable to you alone. It stays private
until you share it.

## What you will see when something is unreachable

- A machine that is switched off or has lost its network shows as offline in
  Settings → Machines. Its sessions stay listed and readable from what was
  recorded; new prompts to them wait until the machine returns.
- A session on your desktop machine opened from the web while its remote access
  is off shows "machine not reachable" and names the machine and the switch.
- A revoked machine's sessions remain in your history. You cannot start new ones
  there until you add the machine again.

## Where the words come from

- **Machine**: any place an agent can run that you own. Shown by its display
  name; you set the name when you add it.
- **Workspace**: a folder on a machine. Shown under its machine in the sidebar.
- **Session**: one conversation with an agent, in one workspace.
- **Environment**: a cloud machine Claxedo provisions and destroys for you.
