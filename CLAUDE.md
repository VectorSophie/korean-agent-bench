# korean-agent-bench (KAB): guide for coding agents

KAB is an **evaluator**: reproducible evaluation of Korean LLMs as coding
agents. The **agent under test** is upstage-cli, a separate product pinned as
the submodule `vendor/upstage-cli`. KAB adds tasks, model configuration and
provenance, Docker sandboxing, trusted and official scoring, failure
accounting, campaign orchestration and reporting. Never confuse the two.

## Where things stand

- **v1 is complete and frozen.** Campaign `main-2026-10-30-v1`: BFCL 1,106-entry
  subset (Kanana 888, EXAONE 881, A.X 681, Solar 898) and SWE-bench Verified
  stage 1, 50 instances (0 / 1 / 1 / 4 resolved), official scorers, 105/105
  verification checks, Gate C audit. English only, so **no Korean-language
  claim follows**. Evidence: `protocol/main-v1*.json`, ADR 0011,
  `docs/research/FOUR_MODEL_COMPARISON.md`, `results/main-2026-10-30-v1/`.
- **v2 is in design.** The question is *when does scaffolding become a
  burden?*: harness × tool interface × context policy × budget. Read
  `docs/research/HARNESS_V2.md` and `docs/ROADMAP.md`. In place: the identity
  contract (`harness/src/agent/harness-config.mjs`), `kab.task/v2`, and
  mini-swe-agent 2.4.6 as the first external harness, **integrated offline
  only** (HARNESS_V2 §7). No v2 experiment has run, and no model has run
  through mini.
- Dated status and open items: `docs/STATUS.md`.

## Frozen: do not change

`protocol/`, `results/*/` (checksummed; `MANIFEST.sha256`, `SHA256SUMS`),
`models/serving-records/`, `docs/audits/`, accepted ADRs (supersede them with
a new ADR instead), and the v1 prompt template and envelope in
`harness/src/benchmarks/swebench.mjs` (v2 uses new ids). Never rewrite
research history to match a newer narrative.

## Layout

| Path | What |
|---|---|
| `harness/` | Node ESM evaluator: `src/task/runner.mjs` (TaskRunner, provenance), `src/agent/` (adapters, `local-models.mjs`, tool policy, sandboxed tools, `harness-config.mjs`), `src/sandbox/`, `src/evaluation/`, `src/benchmarks/swebench.mjs`, `src/preflight/`, `tests/h*.test.mjs` |
| `harness/src/upstream.mjs` | the **only** locator of upstage-cli. The allowed imports are listed in `docs/ARCHITECTURE.md` and enforced by `tests/h24` |
| `benchmarks/` | official BFCL / SWE-bench tooling, `campaign/` driver, analysis, verify, report (Python) |
| `datasets/registry.json` | every task set, its license and permitted use |
| `models/serving/` | maintained launchers and the queue-held `kserve-session.sh`; `docs/ops/MODEL_OPERATIONS.md` |
| `harness/src/agent/adapters/mini-swe-agent.mjs`, `harness/src/agent/mini/kab_bridge.py` | mini-swe-agent adapter and its Python bridge (`benchmarks/setup.sh mini`) |
| `docs/` | `STATUS`, `ARCHITECTURE`, `VERIFY`, `ROADMAP`, `adr/`, `research/`, `models/`, `ops/`, `protocol/`, `audits/` |

Terminology: `provenance.harness` is KAB's evaluator. `provenance.agentHarness`
is the scaffold under test (v2). `provenance.model` is the served model.

## Boundary with upstage-cli

KAB drives upstage-cli's real loop, tool registry, policy engine, session and
model adapters through `importFromCli`. It never copies them, and upstage-cli
never imports KAB. A product improvement found here (e.g. the retrieval query
issue, HARNESS_V2 §3A) is a separate, reviewed upstage-cli PR followed by a
deliberate pin move (ADR 0002 pin history). Never edit the submodule checkout
in place.

## Safety (shared research machine)

- **CPU-only by default.** Starting a model server, running BFCL/SWE-bench
  generation, or any GPU job needs explicit owner authorization. GPU work must
  go through the host's shared queue. See the ops guide, including the open
  question of how servers hold a queue slot.
- Never stop or touch servers, containers or GPU processes you did not start.
  Never bypass launcher GPU gates. Never change drivers, CUDA, PyTorch or JAX.
  Never prune Docker images or caches. Never download checkpoints or pull
  large images unasked.
- Never weaken the Docker sandbox (network none, workspace-only mount,
  realpath confinement, escaping-symlink removal) to improve a score.
- The campaign driver refuses a dirty tree. While a campaign runs, work in a
  separate `git worktree`.

## CPU-only checks

```bash
(cd vendor/upstage-cli && bun install --frozen-lockfile)   # once
cd harness && npm ci                                        # once
npm run check && npm run lint && npm test                   # unit tier, no Docker needed
npm run smoke -- --runs-dir "$(mktemp -d)"
scripts/check-evidence.sh                                   # from repo root
```

The Docker tier (`npm run test:docker`) and fixture QA need Docker and some
small images. See `docs/VERIFY.md`.

## What to read for each kind of work

| Work | Read |
|---|---|
| any change | `docs/STATUS.md`, `docs/ARCHITECTURE.md` |
| v2 research or design | `docs/research/HARNESS_V2.md`, `docs/ROADMAP.md`, `docs/research/FOUR_MODEL_COMPARISON.md` |
| new agent adapter | `harness/src/agent/interface.mjs`, `harness-config.mjs`, the mini adapter as the worked example, `tests/h32`–`h34`, HARNESS_V2 §6–7 |
| models or serving | `docs/ops/MODEL_OPERATIONS.md`, `docs/models/`, ADR 0008, ADR 0010 |
| external benchmarks | `benchmarks/README.md`, ADR 0009, `datasets/registry.json` |
| running a campaign | `docs/protocol/EXPERIMENT_PROTOCOL.md`, ADR 0011, `benchmarks/campaign/` |
| task fixtures | ADR 0003, ADR 0007 (synthetic fixtures **never** rank models) |

## Claims, provenance, publishing

- Every claim cites evidence in this repository: a record, a test or a run.
  Label each one *measured*, *derived* or *hypothesis*. Observations
  (e.g. "Kanana truncated 37/50") are not causes.
- Use official scorers only. Denominators are every scheduled task. Never
  fabricate or estimate a benchmark score.
- SWE-bench Verified has no declared license: never commit issue text, gold
  patches or transcripts. Raw records stay under `.cache/` (git-ignored).
  Machine-specific details go in `private/` (git-ignored).
- Solar Open 2 here is an **unofficial** NVFP4 checkpoint at 8K. Do not
  generalize from it to official Solar.
- BFCL pooled accuracy is a partial evaluation, not the public leaderboard.
- Commit or push only when asked. Branch first, keep commits focused, never
  auto-merge architecture PRs, and do not modify the submodule casually.
