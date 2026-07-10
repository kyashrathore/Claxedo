# Star Audience — AI-dev GitHub outreach pipeline

Builds a ranked audience of AI-developer GitHub users (stargazers of competitor/adjacent
repos) for a Claxedo outreach program. **Legal by design:** it collects public usernames
only and never scrapes emails.

## 1. Collect the audience (legal, do this yourself)

```bash
# classic PAT, no scopes needed — just to get the 5,000 req/hr limit
GITHUB_TOKEN=ghp_xxx node collect-stargazers.mjs --out audience.csv
```

Output `audience.csv`: `login, score, repo_count, repos, profile`, sorted by weighted score.
- `score` = weighted sum (tier-1 competitor stars count 4x, eval/framework 2x, diluted 1x).
- `repo_count` >= 3 → **hot lead** (tried multiple AI coding tools).

Edit `repos.json` to change targets/weights. GitHub caps stargazer pagination at ~40k
users/repo — the script warns when a repo hits it.

## 2. Get emails (compliant) — NOT from GitHub

Do **not** scrape emails from GitHub profiles/commits: it violates GitHub's Acceptable Use
Policy and is what gets pipelines and domains banned. Instead feed the identities into a
**B2B waterfall enrichment provider** (Prospeo / Findymail / Bettercontact) and **verify**
every address (keep bounce rate < 2%).

## 3. Send at scale without dying

- **Never send from `claxedo.com`.** Use secondary domains (`try-claxedo.com`, …).
- ~10 domains x 3 mailboxes x ~35/day ≈ 1,000/day (~25-30k/mo). Scale = more domains, not
  more per inbox. **Warm every mailbox 2-3 weeks** first (Instantly / Smartlead).
- Personalize the first line with the specific repo they starred. 3-touch sequence.

## 4. Compliance (non-negotiable)

- CAN-SPAM: honest headers, identify as commercial, **physical postal address**, working
  opt-out honored forever, permanent suppression list.
- **Exclude EU/EEA recipients** — GDPR/PECR make cold email to them effectively illegal.
- Keep spam-complaint rate < 0.1%; monitor domain blacklists.

Measure reply/positive rate on the first ~200 before scaling anything.
