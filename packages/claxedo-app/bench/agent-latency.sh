#!/usr/bin/env bash
# agent-latency.sh — measures startup & input latency for coding agents
#
# Metrics
#   ttfb  time from spawn    → first output byte   (TUI begins painting)
#   ttii  time from spawn    → agent UI pattern     (UI fully rendered)
#   ttfr  time from Enter    → first response token (input→output latency)
#   pty   round-trip echo    → raw PTY proxy overhead
#
# Usage
#   ./bench/agent-latency.sh [--agents codex,claude,gemini,opencode] [--runs N]
#
# Run this in Ghostty AND in a Claxedo terminal tab, then compare.
# The 'pty echo' row isolates pure PTY-proxy overhead from agent latency.
#
# Requires: expect (/usr/bin/expect ships with macOS)

set -uo pipefail

# ── args ─────────────────────────────────────────────────────────────────────
AGENTS="codex,claude,gemini,opencode"
RUNS=5
while [ $# -gt 0 ]; do
  case "$1" in
    --agents) AGENTS="$2"; shift 2 ;;
    --agents=*) AGENTS="${1#*=}"; shift ;;
    --runs)   RUNS="$2";   shift 2 ;;
    --runs=*) RUNS="${1#*=}";   shift ;;
    *) shift ;;
  esac
done

# Split comma-separated into array (bash 3.2 compat)
IFS=',' read -r -a AGENT_LIST <<< "$AGENTS"

# ── colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; YEL='\033[0;33m'; GRN='\033[0;32m'; CYN='\033[0;36m'; DIM='\033[2m'; RST='\033[0m'

# ── agent config (case-based, bash 3.2 safe) ─────────────────────────────────
# Pattern expect waits for to consider the UI "ready"
ttii_pattern() {
  case "$1" in
    codex)    echo "OpenAI Codex" ;;
    claude)   echo "Claude" ;;
    gemini)   echo "Gemini" ;;
    opencode) echo "opencode" ;;
    *)        echo "$1" ;;
  esac
}

# Prompt to send for ttfr measurement
ttfr_prompt() {
  echo "say only the word: ok\r"
}

# ── stats helper ─────────────────────────────────────────────────────────────
stats() {
  # args: space-separated integers (ms values)
  local vals=("$@")
  local n=${#vals[@]}
  if [ "$n" -eq 0 ]; then echo "no data"; return; fi
  local sum=0 min=${vals[0]} max=${vals[0]}
  for v in "${vals[@]}"; do
    sum=$((sum + v))
    [ "$v" -lt "$min" ] && min=$v
    [ "$v" -gt "$max" ] && max=$v
  done
  local avg=$((sum / n))
  echo "avg=${avg}ms  min=${min}ms  max=${max}ms  (n=${n})"
}

# Global result collector (bash 3.2 has no namerefs)
MEASURE_RESULTS=()

# ── measure_ttfb ─────────────────────────────────────────────────────────────
# Spawn agent, wait for ANY byte, record delta.
measure_ttfb() {
  local bin="$1"
  MEASURE_RESULTS=()
  for _i in $(seq 1 "$RUNS"); do
    local t0 elapsed
    t0=$(python3 -c 'import time; print(int(time.time()*1000))')
    elapsed=$(expect 2>/dev/null <<EXPECT_SCRIPT
log_user 0
set timeout 10
spawn -noecho $bin
expect -timeout 10 {
  -re ".+" { puts [clock milliseconds] }
  timeout  { puts -1 }
  eof      { puts -1 }
}
catch { close }; catch { wait }
EXPECT_SCRIPT
    ) || elapsed=-1
    if [ "${elapsed:-0}" -gt 0 ] 2>/dev/null; then
      local delta=$(( elapsed - t0 ))
      # subtract constant expect+python spawn overhead (~30ms)
      local adj=$(( delta > 30 ? delta - 30 : delta ))
      MEASURE_RESULTS+=("$adj")
    fi
  done
}

# ── measure_ttii ─────────────────────────────────────────────────────────────
# Spawn agent, wait for UI-ready text pattern, record delta.
measure_ttii() {
  local bin="$1"
  local pattern="$2"
  MEASURE_RESULTS=()
  for _i in $(seq 1 "$RUNS"); do
    local t0 elapsed
    t0=$(python3 -c 'import time; print(int(time.time()*1000))')
    elapsed=$(expect 2>/dev/null <<EXPECT_SCRIPT
log_user 0
set timeout 15
spawn -noecho $bin
expect -timeout 15 {
  -re {$pattern} { puts [clock milliseconds] }
  timeout        { puts -1 }
  eof            { puts -1 }
}
catch { close }; catch { wait }
EXPECT_SCRIPT
    ) || elapsed=-1
    if [ "${elapsed:-0}" -gt 0 ] 2>/dev/null; then
      local delta=$(( elapsed - t0 ))
      local adj=$(( delta > 30 ? delta - 30 : delta ))
      MEASURE_RESULTS+=("$adj")
    fi
  done
}

# ── measure_ttfr ─────────────────────────────────────────────────────────────
# Spawn agent, wait for UI ready, send prompt, measure ms until first response.
# The delta is computed entirely inside expect so it doesn't include spawn overhead.
measure_ttfr() {
  local bin="$1"
  local pattern="$2"
  local prompt="$3"
  MEASURE_RESULTS=()
  for _i in $(seq 1 "$RUNS"); do
    local elapsed
    elapsed=$(expect 2>/dev/null <<EXPECT_SCRIPT
log_user 0
set timeout 60

spawn -noecho $bin

# Wait for interactive UI
expect -timeout 15 {
  -re {$pattern} { }
  timeout { puts -1; catch {close}; catch {wait}; exit }
  eof     { puts -1; catch {close}; catch {wait}; exit }
}

# Small settle — let the UI stabilise before typing
after 150

# Record moment of keystroke, then send
set t_sent [clock milliseconds]
send "$prompt"

# Wait for any output after sending (skip echo of the prompt itself)
expect -timeout 45 {
  -re {[a-zA-Z0-9]} {
    puts [expr {[clock milliseconds] - \$t_sent}]
  }
  timeout { puts -1 }
  eof     { puts -1 }
}
catch { close }; catch { wait }
EXPECT_SCRIPT
    ) || elapsed=-1
    if [ "${elapsed:-0}" -gt 0 ] 2>/dev/null; then
      MEASURE_RESULTS+=("$elapsed")
    fi
  done
}

# ── measure_pty_echo ─────────────────────────────────────────────────────────
# Sends a single char through `cat`, measures round-trip echo time.
# Isolates PTY-proxy latency from agent logic.
measure_pty_echo() {
  MEASURE_RESULTS=()
  for _i in $(seq 1 20); do
    local elapsed
    elapsed=$(expect 2>/dev/null <<'EXPECT_SCRIPT'
log_user 0
set timeout 2
spawn -noecho cat
set t0 [clock milliseconds]
send "x"
expect "x"
puts [expr {[clock milliseconds] - $t0}]
catch { close }; catch { wait }
EXPECT_SCRIPT
    ) || elapsed=-1
    [ "${elapsed:-0}" -ge 0 ] 2>/dev/null && MEASURE_RESULTS+=("$elapsed")
  done
}

# ── header ───────────────────────────────────────────────────────────────────
if [ -n "${CLAXEDO_TAB_ID:-}" ]; then
  ENV_TAG="claxedo  (CLAXEDO_TAB_ID=${CLAXEDO_TAB_ID})"
else
  ENV_TAG="native   (no CLAXEDO_TAB_ID — Ghostty / plain terminal)"
fi

RESULT_FILE="/tmp/agent-latency-$(date +%Y%m%d-%H%M%S).txt"
{
  echo "agent-latency benchmark"
  echo "env:  $ENV_TAG"
  echo "date: $(date '+%Y-%m-%d %H:%M:%S')"
  echo ""
} > "$RESULT_FILE"

echo ""
echo -e "${GRN}┌──────────────────────────────────────────────────────────────┐${RST}"
echo -e "${GRN}│  Agent Latency Benchmark                                     │${RST}"
echo -e "${GRN}└──────────────────────────────────────────────────────────────┘${RST}"
echo -e "  ${DIM}env  :${RST} $ENV_TAG"
echo -e "  ${DIM}runs :${RST} $RUNS per metric"
echo -e "  ${DIM}date :${RST} $(date '+%Y-%m-%d %H:%M:%S')"
echo ""

# ── per-agent measurements ────────────────────────────────────────────────────
for AGENT in "${AGENT_LIST[@]}"; do
  BIN=$(which "$AGENT" 2>/dev/null) || { echo -e "  ${YEL}skip${RST} $AGENT — not in PATH"; continue; }
  PATTERN=$(ttii_pattern "$AGENT")
  PROMPT=$(ttfr_prompt "$AGENT")

  echo -e "${CYN}── $AGENT${RST}  ${DIM}($BIN)${RST}"

  # ttfb
  printf "  ttfb  spawn → first byte    … "
  measure_ttfb "$BIN"
  if [ ${#MEASURE_RESULTS[@]} -gt 0 ]; then
    s=$(stats "${MEASURE_RESULTS[@]}")
    echo -e "${GRN}$s${RST}"
    echo "ttfb  $AGENT  $s" >> "$RESULT_FILE"
  else
    echo -e "${RED}failed${RST}"
  fi

  # ttii
  printf "  ttii  spawn → UI ready       … "
  measure_ttii "$BIN" "$PATTERN"
  TTII_VALID=()
  if [ ${#MEASURE_RESULTS[@]} -gt 0 ]; then
    TTII_VALID=("${MEASURE_RESULTS[@]}")
    s=$(stats "${TTII_VALID[@]}")
    echo -e "${GRN}$s${RST}"
    echo "ttii  $AGENT  $s" >> "$RESULT_FILE"
  else
    echo -e "${RED}failed — pattern '${PATTERN}' never matched${RST}"
  fi

  # ttfr (only if UI was reachable)
  if [ ${#TTII_VALID[@]} -gt 0 ]; then
    printf "  ttfr  Enter → first response  … "
    measure_ttfr "$BIN" "$PATTERN" "$PROMPT"
    if [ ${#MEASURE_RESULTS[@]} -gt 0 ]; then
      s=$(stats "${MEASURE_RESULTS[@]}")
      echo -e "${GRN}$s${RST}"
      echo "ttfr  $AGENT  $s" >> "$RESULT_FILE"
    else
      echo -e "${YEL}no data (API timeout / pattern mismatch)${RST}"
    fi
  fi

  echo ""
done

# ── PTY echo latency ─────────────────────────────────────────────────────────
echo -e "${CYN}── PTY echo latency${RST}  ${DIM}(raw proxy overhead, 20 samples)${RST}"
printf "  pty   keystroke → echo       … "
measure_pty_echo
if [ ${#MEASURE_RESULTS[@]} -gt 0 ]; then
  s=$(stats "${MEASURE_RESULTS[@]}")
  echo -e "${GRN}$s${RST}"
  echo "pty_echo  $s" >> "$RESULT_FILE"
else
  echo -e "${RED}failed${RST}"
fi

echo ""
echo -e "  ${DIM}Results saved: $RESULT_FILE${RST}"
echo ""
echo "  ┌──────────────────────────────────────────────────────────────┐"
echo "  │ Next: run this same script in a Claxedo terminal tab and     │"
echo "  │ compare. The 'pty echo' row shows pure proxy overhead.       │"
echo "  └──────────────────────────────────────────────────────────────┘"
echo ""
