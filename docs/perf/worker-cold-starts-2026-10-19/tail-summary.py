# Summarizes `wrangler tail <worker> --format json > tail.jsonl` (pretty-printed JSON objects, one after
# another) per route: invocations, wall and CPU time in ms. `probe` lists invocations carrying an x-probe header.
#
#   python3 tail-summary.py tail.jsonl [probe]
import collections
import json
import sys

raw = open(sys.argv[1]).read()
decoder = json.JSONDecoder()
events = []
position = 0
while position < len(raw):
    while position < len(raw) and raw[position].isspace():
        position += 1
    if position >= len(raw):
        break
    try:
        event, position = decoder.raw_decode(raw, position)
    except ValueError:
        break
    events.append(event)

rows = []
for event in events:
    request = (event.get("event") or {}).get("request") or {}
    url = request.get("url", "?").split("?")[0]
    url = url[url.find("/", 8):] if url.startswith("https://") else url
    rows.append((event.get("eventTimestamp"), url, event.get("wallTime"), event.get("cpuTime"), event.get("outcome"), request.get("headers", {}).get("x-probe")))

if len(sys.argv) > 2 and sys.argv[2] == "probe":
    for row in rows:
        if row[5]:
            print(row)
else:
    by_route = collections.defaultdict(list)
    for row in rows:
        by_route[row[1]].append((row[2], row[3]))
    for url, samples in sorted(by_route.items(), key=lambda item: -len(item[1])):
        wall = sorted(sample[0] for sample in samples if sample[0] is not None)
        cpu = sorted(sample[1] for sample in samples if sample[1] is not None)
        if not wall:
            continue
        print(f"{len(samples):4d} {url:60s} wall p50={wall[len(wall) // 2]:5d} max={wall[-1]:5d}  cpu p50={cpu[len(cpu) // 2]:4d} max={cpu[-1]:4d}")
    print(len(rows), "events")
