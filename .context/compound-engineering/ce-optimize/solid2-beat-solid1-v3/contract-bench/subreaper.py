#!/usr/bin/env python3
"""Minimal subreaper init for running the contract benchmarks in a container.

Why this exists: this container's PID 1 (firecracker `process_api`) reaps
orphaned zombies in ~1305 ms, while the immutable perf-harness gives a process
100 ms after SIGKILL before declaring the shutdown failed. Every measure.ts run
therefore died with:

    driver-handler-error: Claxedo P1 initialization left a surviving process

Running the benchmark under this shim sets PR_SET_CHILD_SUBREAPER, so orphaned
descendants reparent here and are reaped immediately (measured: ~1 ms). Nothing
in the frozen harness or the app is modified.

    python3 subreaper.py <cmd> [args...]
"""
import ctypes
import os
import signal
import sys

PR_SET_CHILD_SUBREAPER = 36

libc = ctypes.CDLL(None, use_errno=True)
if libc.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0:
    sys.exit("prctl(PR_SET_CHILD_SUBREAPER) failed")

if len(sys.argv) < 2:
    sys.exit("usage: subreaper.py <cmd> [args...]")

child = os.fork()
if child == 0:
    os.execvp(sys.argv[1], sys.argv[1:])

signal.signal(signal.SIGCHLD, lambda signum, frame: None)

exit_code = 1
while True:
    try:
        pid, status = os.waitpid(-1, 0)
    except ChildProcessError:
        break
    except InterruptedError:
        continue
    if pid == child:
        exit_code = os.waitstatus_to_exitcode(status)
        # keep reaping stragglers until no children remain

sys.exit(exit_code if exit_code >= 0 else 1)
