# Claxedo run /home/user/bench/runs/baseline-1

- claxedo app-start: 2026-10-17T22:05:17.957Z, driver 483b4b70e5bb, clock rule settle-31-frames, conformance 8 checked, 0 failed, 1-minute load 0.98–2.26
- claxedo session-switch-walk: 2026-10-17T22:07:08.343Z, driver 483b4b70e5bb, clock rule settle-31-frames, conformance 99 checked, 0 failed, 1-minute load 0.98–2.26

Host conditions for /home/user/bench/runs/baseline-1:
wall clock 3m 51s; 27 samples
1-minute load average 0.98–2.26 (median 1.63)
power unknown
busiest processes outside the benchmark (peak CPU) claude 7.6%, Xvfb 2.6%, kcompactd0 0.1%, 3:1H-kblockd 0.1%
app-start: 121 s
session-switch-walk: 110 s

- app-start: 8 valid / 0 invalid of 8 observations; resources n/a
- session-switch-walk: 99 valid / 0 invalid of 99 observations; resources valid

| Metric | Median | p95 / max | Min | Valid / attempted |
|---|---:|---:|---:|---:|
| App start, fresh profile | 3257.116 ms | 3570.491 ms / 3570.491 ms | 3069.262 ms | 4 / 4 |
| App start, existing profile | 3239.442 ms | 3324.743 ms / 3324.743 ms | 3082.06 ms | 4 / 4 |
| Next session down the list, first visit: 1 MiB session | 148.7 ms | 180.3 ms / 182.8 ms | 103.1 ms | 38 / 38 |
| Next session down the list, first visit: 8 MiB session | 143.35 ms | 188.3 ms / 188.3 ms | 137.6 ms | 6 / 6 |
| Next session down the list, first visit: 1 MiB of long text rows | 218.55 ms | 268.6 ms / 268.6 ms | 201.2 ms | 4 / 4 |
| Next session down the list, return: 1 MiB session | 96.25 ms | 145.5 ms / 170.7 ms | 65.9 ms | 38 / 38 |
| Next session down the list, return: 8 MiB session | 98.15 ms | 182.2 ms / 182.2 ms | 85.2 ms | 6 / 6 |
| Next session down the list, return: 1 MiB of long text rows | 171.65 ms | 179.1 ms / 179.1 ms | 152.8 ms | 4 / 4 |
| Memory (RSS) idle after launch | 1202.762 MiB | 1202.824 MiB / 1202.824 MiB | 1202.676 MiB | 6 / 6 |
| Memory (RSS) idle after the switching workload | 1260.117 MiB | 1260.234 MiB / 1260.234 MiB | 1260.117 MiB | 6 / 6 |
| CPU while idle | 0 % | 8 % / 8 % | 0 % | 10 / 10 |

RSS and CPU rows: samples are the framework's 250 ms resource samples inside the idle windows (n counts samples, not runs).
