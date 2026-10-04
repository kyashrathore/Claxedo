{{MARKER}}

# Save Claxedo env vars before sourcing user config
{{ENV_SAVE}}

# Source system profile
[[ -f /etc/profile ]] && source /etc/profile

# Source user's login profile
if [[ -f "$HOME/.bash_profile" ]]; then
  source "$HOME/.bash_profile"
elif [[ -f "$HOME/.bash_login" ]]; then
  source "$HOME/.bash_login"
elif [[ -f "$HOME/.profile" ]]; then
  source "$HOME/.profile"
fi

# Source bashrc if separate
[[ -f "$HOME/.bashrc" ]] && source "$HOME/.bashrc"

# Restore Claxedo env vars that user config may have overridden
{{ENV_RESTORE}}

# Keep claxedo bin first without duplicating entries
{{PATH_PREPEND}}
hash -r 2>/dev/null || true
# Shell-ready marker, emitted on EVERY prompt.
# Uses PROMPT_COMMAND so it fires AFTER direnv and other hooks complete.
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
if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
  PROMPT_COMMAND=("${PROMPT_COMMAND[@]}" "_claxedo_shell_ready")
else
  _claxedo_orig_prompt_cmd="${PROMPT_COMMAND}"
  if [[ -n "${_claxedo_orig_prompt_cmd}" ]]; then
    PROMPT_COMMAND="${_claxedo_orig_prompt_cmd};_claxedo_shell_ready"
  else
    PROMPT_COMMAND="_claxedo_shell_ready"
  fi
fi
