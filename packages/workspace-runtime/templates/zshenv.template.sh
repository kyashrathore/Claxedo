{{MARKER}}
{{ENV_SAVE}}
_claxedo_home="${CLAXEDO_ORIG_ZDOTDIR:-$HOME}"
export ZDOTDIR="$_claxedo_home"
[[ -f "$_claxedo_home/.zshenv" ]] && source "$_claxedo_home/.zshenv"
{{ENV_RESTORE}}
export ZDOTDIR={{SHELL_DIR_QUOTED}}
