#!/usr/bin/env python3
"""
agent-latency.py — command-hit to TUI-render latency benchmark

Metrics
  ttfb   spawn → first output byte           (TUI begins painting)
  ttii   spawn → agent-specific UI pattern   (interactive prompt ready)
  ttfr   Enter → first response byte         (input→output latency)
  pty    cat echo round-trip                 (raw PTY proxy overhead)

Usage
  python3 bench/agent-latency.py [--agents codex,claude,gemini,opencode] [--runs N]

Run this script in Ghostty AND in a Claxedo terminal tab, then compare.
  Ghostty  : direct PTY, GPU-rendered (native latency baseline)
  Claxedo  : PTY over WebSocket proxy → xterm.js JS rendering
The 'pty echo' row isolates pure proxy overhead from agent code.
"""

import os, sys, time, select, subprocess, signal, struct, fcntl, termios, pty
import statistics, argparse, datetime, shutil, re

# ── helpers ──────────────────────────────────────────────────────────────────

def ms() -> int:
    return int(time.time() * 1000)

def set_pty_size(fd: int, rows: int = 50, cols: int = 200):
    winsize = struct.pack("HHHH", rows, cols, 0, 0)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)

def fmt_stats(data: list) -> str:
    if not data:
        return "no data"
    avg = int(statistics.mean(data))
    p50 = int(statistics.median(data))
    return f"avg={avg}ms  min={min(data)}ms  max={max(data)}ms  p50={p50}ms  (n={len(data)})"

TERMINAL_RESPONSES = {
    # cursor position query  → row 1, col 1
    b"\x1b[6n":     b"\x1b[1;1R",
    # primary device attrs   → VT220
    b"\x1b[c":      b"\x1b[?62;c",
    b"\x1b[0c":     b"\x1b[?62;c",
    # secondary device attrs → no special version
    b"\x1b[>c":     b"\x1b[>1;0;0c",
    b"\x1b[>0c":    b"\x1b[>1;0;0c",
    # tertiary device attrs
    b"\x1b[=c":     b"\x1bP!|00000000\x1b\\",
    # foreground / background colour queries
    b"\x1b]10;?":   b"\x1b]10;rgb:ffff/ffff/ffff\x07",
    b"\x1b]11;?":   b"\x1b]11;rgb:0000/0000/0000\x07",
    # kitty keyboard protocol capability query
    b"\x1b[?u":     b"\x1b[?0u",
    # modifyOtherKeys query
    b"\x1b[>4m":    b"",   # no-op: unsupported
}

def respond_to_queries(master_fd: int, chunk: bytes):
    """Write terminal capability responses for any queries found in chunk."""
    for query, response in TERMINAL_RESPONSES.items():
        if query in chunk and response:
            try:
                os.write(master_fd, response)
            except OSError:
                pass

def spawn_in_pty(cmd: list[str]):
    """Return (master_fd, proc) with a properly-sized PTY."""
    master, slave = pty.openpty()
    set_pty_size(slave, 50, 200)
    proc = subprocess.Popen(
        cmd,
        stdin=slave, stdout=slave, stderr=slave,
        close_fds=True,
        preexec_fn=os.setsid,
    )
    os.close(slave)
    return master, proc

def kill_proc(proc, master_fd: int):
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
    except (OSError, ProcessLookupError):
        pass
    try:
        proc.wait(timeout=2)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except (OSError, ProcessLookupError):
            pass
    try:
        os.close(master_fd)
    except OSError:
        pass

# ── ttfb ─────────────────────────────────────────────────────────────────────

def measure_ttfb(cmd: list[str], runs: int = 5, timeout_s: float = 10.0) -> list[int]:
    """Time from process spawn to first byte of PTY output."""
    results = []
    for _ in range(runs):
        master, proc = spawn_in_pty(cmd)
        t0 = ms()
        try:
            r, _, _ = select.select([master], [], [], timeout_s)
            t1 = ms()
            if r:
                try:
                    os.read(master, 4096)
                except OSError:
                    pass
                results.append(t1 - t0)
        finally:
            kill_proc(proc, master)
    return results

# ── ttii ─────────────────────────────────────────────────────────────────────

def measure_ttii(
    cmd: list[str], pattern: bytes, runs: int = 5, timeout_s: float = 15.0
) -> list[int]:
    """Time from spawn to when 'pattern' appears in the PTY output stream."""
    results = []
    for _ in range(runs):
        master, proc = spawn_in_pty(cmd)
        t0 = ms()
        buf = b""
        deadline = time.time() + timeout_s
        found = False
        try:
            while time.time() < deadline:
                remaining = deadline - time.time()
                r, _, _ = select.select([master], [], [], min(remaining, 0.05))
                if not r:
                    continue
                try:
                    chunk = os.read(master, 4096)
                except OSError:
                    break
                respond_to_queries(master, chunk)
                buf += chunk
                if pattern in buf:
                    results.append(ms() - t0)
                    found = True
                    break
        finally:
            kill_proc(proc, master)
    return results

# ── ttfr ─────────────────────────────────────────────────────────────────────

def measure_ttfr(
    cmd: list[str],
    ii_pattern: bytes,
    prompt: bytes,
    runs: int = 5,
    ii_timeout_s: float = 15.0,
    response_timeout_s: float = 60.0,
) -> list[int]:
    """
    Time from pressing Enter (sending prompt) to first response byte.
    Steps: spawn → wait for UI ready → send prompt → time to first output.
    """
    results = []
    for _ in range(runs):
        master, proc = spawn_in_pty(cmd)
        buf = b""
        deadline = time.time() + ii_timeout_s
        ready_for_input = False
        try:
            # Phase 1: wait for interactive UI
            while time.time() < deadline:
                remaining = deadline - time.time()
                r, _, _ = select.select([master], [], [], min(remaining, 0.05))
                if not r:
                    continue
                try:
                    chunk = os.read(master, 4096)
                except OSError:
                    break
                respond_to_queries(master, chunk)
                buf += chunk
                if ii_pattern in buf:
                    ready_for_input = True
                    break

            if not ready_for_input:
                continue

            # Small settle — let any post-render output drain
            time.sleep(0.2)
            try:
                while True:
                    r, _, _ = select.select([master], [], [], 0.05)
                    if not r:
                        break
                    os.read(master, 4096)
            except OSError:
                pass

            # Phase 2: send prompt and time to first response
            t_sent = ms()
            os.write(master, prompt)

            # Drain the prompt echo first (up to 200ms)
            echo_deadline = time.time() + 0.2
            while time.time() < echo_deadline:
                r, _, _ = select.select([master], [], [], 0.02)
                if not r:
                    break
                try:
                    os.read(master, 4096)
                except OSError:
                    break

            # Now time to first meaningful response byte
            t_sent = ms()
            resp_deadline = time.time() + response_timeout_s
            while time.time() < resp_deadline:
                remaining = resp_deadline - time.time()
                r, _, _ = select.select([master], [], [], min(remaining, 0.05))
                if not r:
                    continue
                try:
                    chunk = os.read(master, 4096)
                except OSError:
                    break
                # skip pure escape sequences — look for printable content
                printable = re.sub(rb"\x1b\[[0-9;]*[A-Za-z]", b"", chunk)
                printable = re.sub(rb"\x1b\][^\x07]*\x07", b"", printable)
                if any(32 <= b < 127 for b in printable):
                    results.append(ms() - t_sent)
                    break
        finally:
            kill_proc(proc, master)
    return results

# ── pty echo latency ─────────────────────────────────────────────────────────

def measure_pty_echo(samples: int = 20) -> list[int]:
    """Round-trip latency through a PTY using `cat` as the echo process."""
    results = []
    master, proc = spawn_in_pty(["cat"])
    try:
        for _ in range(samples):
            t0 = ms()
            os.write(master, b"x")
            r, _, _ = select.select([master], [], [], 1.0)
            if r:
                data = os.read(master, 10)
                if b"x" in data:
                    results.append(ms() - t0)
    finally:
        kill_proc(proc, master)
    return results

# ── agent config ─────────────────────────────────────────────────────────────

# ttii patterns: what to look for when the TUI is truly ready for input.
# Each is chosen to appear AFTER initialization, not just the first render frame.
#
#   codex     "% left"        — token budget in status bar; only appears after the
#                               model name fills in (replaces "loading").  The
#                               header "OpenAI Codex" appears in ~50ms but the
#                               input box stays blank for ~6s until the model loads.
#   claude    "to exit"       — "Press Ctrl+C to exit" hint in the prompt footer;
#                               appears when the interactive input is ready.
#   gemini    "Type a message" — input placeholder, appears when UI is interactive.
#   opencode  "Ask anything"  — input placeholder in the input box.

AGENTS: dict[str, dict] = {
    "codex": {
        "bin":          shutil.which("codex") or "codex",
        "pattern":      b"% left",
        "pattern_note": "status bar token budget (model fully loaded)",
        "prompt":       b"say only the word: ok\r",
    },
    "claude": {
        "bin":          shutil.which("claude") or "claude",
        "pattern":      b"to exit",
        "pattern_note": "footer hint (interactive prompt ready)",
        "prompt":       b"say only the word: ok\r",
    },
    "gemini": {
        "bin":          shutil.which("gemini") or "gemini",
        "pattern":      b"Type a message",
        "pattern_note": "input placeholder (UI interactive)",
        "prompt":       b"say only the word: ok\r",
    },
    "opencode": {
        "bin":          shutil.which("opencode") or "opencode",
        "pattern":      b"Ask anything",
        "pattern_note": "input box placeholder (UI interactive)",
        "prompt":       b"say only the word: ok\r",
    },
}

# ── main ─────────────────────────────────────────────────────────────────────

def main():
    p = argparse.ArgumentParser(description="Agent TUI latency benchmark")
    p.add_argument("--agents", default="codex,claude,gemini,opencode",
                   help="Comma-separated list of agents to benchmark")
    p.add_argument("--runs", type=int, default=5, help="Runs per metric")
    p.add_argument("--skip-ttfr", action="store_true",
                   help="Skip ttfr (Enter→response) which makes real API calls")
    args = p.parse_args()

    agent_names = [a.strip() for a in args.agents.split(",")]
    runs = args.runs

    claxedo_tab = os.environ.get("CLAXEDO_TAB_ID")
    env_tag = (
        f"claxedo  (CLAXEDO_TAB_ID={claxedo_tab})"
        if claxedo_tab
        else "native   (no CLAXEDO_TAB_ID — Ghostty / plain terminal)"
    )

    ts = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    result_file = f"/tmp/agent-latency-{ts}.txt"
    result_lines = [f"env: {env_tag}", f"date: {datetime.datetime.now()}", ""]

    GREEN  = "\033[32m"
    CYAN   = "\033[36m"
    YELLOW = "\033[33m"
    DIM    = "\033[2m"
    RESET  = "\033[0m"

    print()
    print(f"{GREEN}┌──────────────────────────────────────────────────────────────┐{RESET}")
    print(f"{GREEN}│  Agent Latency Benchmark                                     │{RESET}")
    print(f"{GREEN}└──────────────────────────────────────────────────────────────┘{RESET}")
    print(f"  {DIM}env :{RESET} {env_tag}")
    print(f"  {DIM}runs:{RESET} {runs} per metric")
    print(f"  {DIM}date:{RESET} {datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print()

    for name in agent_names:
        cfg = AGENTS.get(name)
        if not cfg:
            print(f"  {YELLOW}skip{RESET} {name} — unknown agent")
            continue

        binary = cfg["bin"]
        if not binary or not os.path.exists(binary):
            binary2 = shutil.which(name)
            if not binary2:
                print(f"  {YELLOW}skip{RESET} {name} — not in PATH")
                continue
            binary = binary2

        cmd = [binary]
        print(f"{CYAN}── {name}{RESET}  {DIM}({binary}){RESET}")

        # ttfb
        print(f"  ttfb  spawn → first byte    … ", end="", flush=True)
        r = measure_ttfb(cmd, runs=runs)
        s = fmt_stats(r)
        print(f"{GREEN}{s}{RESET}")
        result_lines.append(f"ttfb  {name}  {s}")

        # ttii
        note = cfg.get("pattern_note", f"'{cfg['pattern'].decode()}'")
        print(f"  ttii  spawn → input ready    … ", end="", flush=True)
        r = measure_ttii(cmd, cfg["pattern"], runs=runs, timeout_s=20.0)
        s = fmt_stats(r)
        print(f"{GREEN}{s}{RESET}  {DIM}({note}){RESET}")
        result_lines.append(f"ttii  {name}  {s}")
        ttii_worked = len(r) > 0

        # ttfr
        if not args.skip_ttfr and ttii_worked:
            print(f"  ttfr  Enter → first response  … ", end="", flush=True)
            r = measure_ttfr(cmd, cfg["pattern"], cfg["prompt"], runs=runs)
            s = fmt_stats(r)
            print(f"{GREEN}{s}{RESET}")
            result_lines.append(f"ttfr  {name}  {s}")
        elif args.skip_ttfr:
            print(f"  ttfr  {DIM}(skipped via --skip-ttfr){RESET}")

        print()

    # PTY echo
    print(f"{CYAN}── PTY echo latency{RESET}  {DIM}(raw proxy overhead, 20 samples){RESET}")
    print(f"  pty   keystroke → echo       … ", end="", flush=True)
    r = measure_pty_echo(samples=20)
    s = fmt_stats(r)
    print(f"{GREEN}{s}{RESET}")
    result_lines.append(f"pty_echo  {s}")

    # Save
    with open(result_file, "w") as f:
        f.write("\n".join(result_lines) + "\n")

    print()
    print(f"  {DIM}Results saved: {result_file}{RESET}")
    print()
    print("  ┌──────────────────────────────────────────────────────────────┐")
    print("  │ Run this same script in a Claxedo terminal tab and compare. │")
    print("  │ The 'pty echo' row shows pure proxy overhead.               │")
    print("  │ ttfb/ttii show TUI startup latency per environment.         │")
    print("  └──────────────────────────────────────────────────────────────┘")
    print()


if __name__ == "__main__":
    main()
