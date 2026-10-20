# Rewrites a Wrangler bundle so every esbuild module header records when it starts evaluating, for import under Node.
import sys
src, dst, stub = sys.argv[1:4]
text = open(src).read().replace('from "cloudflare:workers"', f'from "{stub}"')
out = []
n = 0
for line in text.split("\n"):
    body = line[3:].strip() if line.startswith("// ") else ""
    if body and " " not in body and ("/" in body or body.endswith((".js", ".ts", ".mjs", ".json"))):
        n += 1
        out.append(f"globalThis.__t.push([{body!r}, globalThis.__now()]);")
    out.append(line)
prelude = 'import { performance as __perf } from "node:perf_hooks";\nglobalThis.__now = () => __perf.now();\nglobalThis.__t = [];\nglobalThis.__t0 = globalThis.__now();\n'
epilogue = "\nglobalThis.__tEnd = globalThis.__now();\n"
open(dst, "w").write(prelude + "\n".join(out) + epilogue)
print("headers instrumented:", n, file=sys.stderr)
