# Verifying this repository

Everything below runs on CPU and Docker only: no GPU, no model server, no
network access from the sandboxes. Record the date, commit and results when
you report a verification (see `docs/MIGRATION.md`, "Verification", for the
format).

## Requirements

- git, Node.js >= 22, Bun >= 1.3 (for upstage-cli's dependencies), Docker
  (for the Docker tier and fixture QA). Last verified with Node v24.21.0 and
  Bun 1.4.2 locally; CI uses Node 22.

## Setup

```bash
git clone --recurse-submodules https://github.com/VectorSophie/korean-agent-bench.git
cd korean-agent-bench
git submodule status                 # no leading '+': checkout matches the pin
(cd vendor/upstage-cli && bun install --frozen-lockfile)
(cd harness && npm ci)
```

## Checks

```bash
cd harness
npm run check                        # syntax
npm run lint
npm test                             # unit tier (includes h24 boundary, h25 registry)
npm run test:docker                  # Docker isolation tier (serialized)
npm run smoke -- --runs-dir "$(mktemp -d)"   # mock agent, end to end
npm run benchmark:validate           # benchmark-v1 manifest
npm run benchmark:qa                 # Docker: each fixture fails at baseline, passes with its reference solution
```

Expected on `main` as of 2026-10-29: unit 361/361, Docker 35/35,
`validate: OK (14 tasks, 14 warnings)` (unpinned `node:22-alpine` tags in the
v1-initial tranche, as upstream). `benchmark:qa` is first exercised on the
PR #12 import branch (28/28).

## Evidence integrity

```bash
(cd models/serving-records && sha256sum -c SHA256SUMS)
(cd results/pilot-2026-10 && sha256sum -c SHA256SUMS)
```

## Provenance of the migrated history

```bash
git log --grep='^Upstream-Commit:' --format='%h %ad %s%n  %(trailers:key=Upstream-Commit,valueonly)' --date=short | head
```

All 41 commits extracted from upstage-cli master, and the PR #12 import commit on its branch, carry the upstage-cli SHA they came from.
