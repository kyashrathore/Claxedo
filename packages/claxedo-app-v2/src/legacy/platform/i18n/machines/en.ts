export const dict = {
  "sidebar.workspace.role.viewer": "Viewer",
  "sidebar.workspace.role.editor": "Editor",
  "sidebar.workspace.role.admin": "Admin",
  "sidebar.workspace.hostOffline": "Machine offline",
  "sidebar.workspace.sharedWithYou": "Shared with you",
  "sidebar.workspace.publishedToYourAccount": "Published to your account",
  "workspace.directory.project": "project",
  "workspace.directory.sandbox": "sandbox",
  "session.share.level.follow": "Can follow",
  "session.share.level.send": "Can send messages",
  // The consequence this states is not a policy the product could choose
  // otherwise: an agent with a machine's files can read anything on it, so a
  // translation that softens the reach — or drops the other sessions, or the
  // advice to use a cloud environment — describes a product that does not
  // exist. Every locale carries a full translation of it.
  "session.share.disclosure.send":
    "The agent runs on the workspace's machine with that machine's files. A teammate who can send messages can ask it to read anything there, including the transcripts of your other sessions in this workspace. Sharing works best for sessions on a cloud environment, where each session has a machine of its own. If this machine holds anything you would not want a teammate to reach, do not share sessions from workspaces on it.",
}
