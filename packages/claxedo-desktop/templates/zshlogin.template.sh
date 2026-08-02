{{MARKER}}
{{ENV_SAVE}}
_claxedo_home="${CLAXEDO_ORIG_ZDOTDIR:-$HOME}"
export ZDOTDIR="$_claxedo_home"
if [[ -o interactive ]]; then
  [[ -f "$_claxedo_home/.zlogin" ]] && source "$_claxedo_home/.zlogin"
fi
{{ENV_RESTORE}}
{{PRECMD_HOOK}}
{{PATH_PREPEND}}
rehash 2>/dev/null || true
# Shell-ready marker, emitted on EVERY prompt.
# Uses precmd so it fires AFTER direnv and other hooks complete.
#
# It has two consumers, and the second is why this no longer removes itself:
#   1. terminal readiness — the server sends a queued initial command on the
#      first marker (idempotent, so later ones are free);
#   2. leaked-input-mode reclaim — the renderer treats each marker as "the
#      shell owns the foreground again" and disarms mouse/focus/kitty modes a
#      TUI left armed when it was killed without restoring them. That check is
#      only correct if the marker arrives at every prompt, not just the first.
_claxedo_shell_ready() {
  printf '\033]777;claxedo-shell-ready\007'
}
precmd_functions=(${precmd_functions[@]} _claxedo_shell_ready)
export ZDOTDIR="$_claxedo_home"
