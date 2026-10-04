{{MARKER}}
{{ENV_SAVE}}
_claxedo_home="${CLAXEDO_ORIG_ZDOTDIR:-$HOME}"
export ZDOTDIR="$_claxedo_home"
[[ -f "$_claxedo_home/.zprofile" ]] && source "$_claxedo_home/.zprofile"
{{ENV_RESTORE}}
export ZDOTDIR={{SHELL_DIR_QUOTED}}
