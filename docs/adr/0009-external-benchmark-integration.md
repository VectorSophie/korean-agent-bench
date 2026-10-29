# ADR 0009 — External benchmarks: official evaluators, pinned data, separate tracks

## Status

**Accepted** (2026-10-29). Pipelines implemented and validated **offline**;
no model has been run. Admission to the main comparison still requires its
own ADR (ADR 0003, point 5).

## Context

ADR 0003 moved the main comparison to established external benchmarks,
scored by their own evaluators. This ADR records how the two candidates are
integrated, and the references that changed on verification.

## Decisions

### 1. Reference verification (2026-10-29)

| Reference | First recorded | Verified | Action |
|---|---|---|---|
| BFCL source | gorilla `6ea57973…`, `bfcl-eval==2026.3.23` | unchanged; wheel uploaded the same minute as the commit | kept; wheel sha256 `3bb6dfa5…` enforced by `benchmarks/setup.sh` |
| SWE-bench Verified data | HF `SWE-bench/SWE-bench_Verified@78f471bf…` | unchanged | kept; parquet sha256 `030cfd7f…` enforced by `acquire.py` |
| SWE-bench evaluator | tag `v5.0.1` = `87ab1f6c…` | PyPI ships **5.0.2** = untagged `490635b2…`; the diff adds one fix (gold predictions filtered to the requested instances) | **replaced** with `swebench==5.0.2` / `490635b2…` (what is actually installed and run); wheel sha256 `b7f0416a…` enforced |

### 2. Isolated, pinned tool environments

`benchmarks/setup.sh` builds `.cache/venv-bfcl` and `.cache/venv-swebench`
(CPU-only torch). The official wheel is verified against its sha256 before
install (a mismatch aborts; tested). One environment fix is needed:
`qwen-agent 0.0.34` — bfcl-eval's unpinned dependency, and the release current
at bfcl-eval's date — imports `soundfile` without declaring it; `soundfile`
is installed explicitly. `bfcl version` fails upstream (it looks up a
distribution named `bfcl`); versions are read with `importlib.metadata`.

### 3. BFCL: official track only, through upstream code

- Our four models are not in BFCL. They are registered in bfcl-eval's own
  `MODEL_CONFIG_MAPPING` (its documented extension point) by
  `benchmarks/bfcl/kab_bfcl.py`, which then runs the unmodified `bfcl` CLI.
- Generation uses bfcl-eval's `OpenAICompletionsHandler` in function-calling
  mode against the model's own server. The only adapter: a client bound to
  the model's endpoint and, for EXAONE, `chat_template_kwargs` (thinking
  on/off) via `extra_body`. No upstage-cli prompt or tool is involved.
- BFCL's own temperature (0.001) applies, not the harness's vendor sampling.
- Subset: `datasets/bfcl/subset-v1.json` (1,106 of 3,841 entries, 14
  categories, ≤100 per category, seeded hash ranking over ids only).
  `format_sensitivity` (skipped by bfcl-eval for FC models), `web_search`
  (SerpAPI), `memory` (downloads an embedding model) are excluded on
  upstream facts; `multi_turn_long_context` / `miss_func` / `miss_param` are
  deferred, decided before any model run.
- Scoring: `bfcl evaluate --partial-eval`; per-category accuracy only. No
  overall score (it needs every category with upstream weighting).
- An **agent-mediated BFCL track** (BFCL scenarios through upstage-cli) is
  **not built**. If built, it is experimental and never mixed with this track.

### 4. SWE-bench Verified: official scoring, agent-generated predictions

- Data: the pinned parquet, sha256-verified, in `.cache/` (the dataset card
  declares no license, so it is not committed). Committed: a metadata index
  (ids, repos, base commits, versions; no issue text, patches or tests).
- Generation (`harness swebench run`): upstage-cli's agent loop on the repo
  at `base_commit`, issue text in template `kab-swebench-prompt-v1` (hints
  excluded), inside the instance's **official image** with network none, no
  local checks (the run record's own status is always `incomplete`).
  Provisional envelope: 30 turns, 1800 s; frozen by a later ADR.
- Patch capture is byte-exact (a trimming bug in the patch tracker was found
  and fixed; `h29`). `harness swebench predictions` writes the official
  schema.
- Scoring only by `swebench.harness.run_evaluation` on the verified local
  parquet (an HF name would load a floating revision), official images and
  log parsers. `benchmarks/swebench/evaluate.py` copies the official
  categories (resolved, unresolved, empty_patch, error, infra_failure,
  ambiguous_failure, incomplete) without reinterpretation; its own patch
  checks are recorded as findings and never change an outcome. Instance
  images are `:latest` tags, so the digest each resolved to is recorded.
- `harness import swebench` (pytest approximations) stays a development tool.
- Subset: `datasets/swe-bench-verified/subset-v1.json`, 100 of 500,
  repository-stratified, seeded hash ranking over ids only.

### 5. Context feasibility is preregistered, and infeasible ≠ removed

`datasets/swe-bench-verified/context-feasibility-v1.json` renders each
agent's real first request with each model's own chat template (local
tokenizer files, `trust_remote_code=False`) and classifies every (instance,
model) pair as `fits`, `cannot_fit` or `depends_on_context`. Infeasible
instances stay in the denominator; results report resolved / unresolved /
infeasible (context) / infrastructure error separately. Task content is
never changed per model.

### 6. Tables stay separate

BFCL and SWE-bench results are reported in separate tables; no combined
score is defined.

## Consequences

- Offline evidence: `results/bfcl-offline-validation-2026-10-29/` (official
  scorer: gold 22/22, invalid 0/22 across 12 categories) and
  `results/swebench-offline-validation-2026-10-29/` (official evaluator:
  gold via the agent pipeline resolved, empty → empty_patch, wrong →
  unresolved, malformed → error).
- **Blocker found:** upstage-cli has no capability entries for the four
  served model ids and falls back to a 65,536-token context, so its
  repository-context cap (23,592 characters) and context management ignore
  the validated 8K/16K windows. Every SWE-bench pair except one is therefore
  `depends_on_context`, and one is certainly infeasible for Solar. This must
  be fixed upstream (a deliberate upstage-cli change and pin move) before a
  reportable SWE-bench run.
- Not validated: the agent-mediated SWE-bench path with a real model; BFCL
  generation against a real vLLM server (only the request contract against
  a mock); multi-instance evaluation at scale; any Korean variant.
