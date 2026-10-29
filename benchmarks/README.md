# External benchmarks

How to acquire, run and score BFCL and SWE-bench Verified with their
**official** tooling. Decisions and limits: `docs/adr/0009-external-benchmark-integration.md`.
Versions, licenses, subsets and provenance: `datasets/registry.json`.

Status (2026-10-29): both pipelines are validated **offline** (mock model /
replayed patches, official scorers). **No model has been run.** Nothing below
starts a model server; serving is covered by `docs/protocol/EXPERIMENT_PROTOCOL.md`.

| | BFCL | SWE-bench Verified |
|---|---|---|
| Data | inside the pinned `bfcl-eval==2026.3.23` wheel | HF `SWE-bench/SWE-bench_Verified@78f471bf…`, local parquet |
| Integrity | wheel sha256 (setup.sh); per-file sha256 in the subset file | parquet sha256 (`acquire.py`) |
| Subset v1 | 1,106 / 3,841 entries, 14 categories | 100 / 500 instances, 12 repositories |
| Generation | bfcl-eval's own FC handler → model server | upstage-cli agent (harness) in the official instance image |
| Scoring | `bfcl evaluate --partial-eval` | `swebench.harness.run_evaluation` |
| Offline validation | `results/bfcl-offline-validation-2026-10-29/` | `results/swebench-offline-validation-2026-10-29/` |

## Setup (CPU only, ~2.4 GB)

```bash
benchmarks/setup.sh all     # .cache/venv-bfcl, .cache/venv-swebench; verifies wheel sha256
```

## BFCL

```bash
VB=.cache/venv-bfcl/bin/python
$VB benchmarks/bfcl/select_subset.py --check          # subset == fresh selection from the wheel's data
$VB benchmarks/bfcl/validate_offline.py               # official generate+evaluate against a mock (no GPU)

# A real run (after serving the model and passing `harness preflight`):
export BFCL_PROJECT_ROOT=$PWD/results/bfcl-<campaign>/<model>
mkdir -p "$BFCL_PROJECT_ROOT"
python3 -c 'import json; s=json.load(open("datasets/bfcl/subset-v1.json")); json.dump({c: v["ids"] for c, v in s["categories"].items()}, open("'"$BFCL_PROJECT_ROOT"'/test_case_ids_to_generate.json", "w"))'
$VB benchmarks/bfcl/kab_bfcl.py generate --model kab-<agent>-FC --run-ids --num-threads 1
$VB benchmarks/bfcl/kab_bfcl.py evaluate --model kab-<agent>-FC --test-category <categories> --partial-eval
```

Registered models: `benchmarks/bfcl/models.json` (kept equal to
`harness/src/agent/local-models.mjs` by `harness/tests/h28`). Report
per-category accuracy only, with upstream's partial-evaluation warning.

## SWE-bench Verified

```bash
VS=.cache/venv-swebench/bin/python
$VS benchmarks/swebench/acquire.py --check --export   # verify parquet sha256; local instance export
python3 benchmarks/swebench/select_subset.py --check   # subset == fresh selection from index.json
$VS benchmarks/swebench/validate_offline.py           # official evaluator on gold/empty/wrong/malformed (pulls ~1 GB image once)

# Prediction generation for one instance (after serving + preflight):
node harness/bin/harness.mjs swebench run --instance <id> --agent <agent> --preflight --runs-dir results/swebench-<campaign>/runs
node harness/bin/harness.mjs swebench predictions --model-name kab-<agent> --out preds.jsonl results/swebench-<campaign>/runs/run_*.json
$VS benchmarks/swebench/evaluate.py --predictions preds.jsonl --run-id <campaign>-<agent> --out results/swebench-<campaign>/eval-<agent>
```

`evaluate.py` refuses to pull images unless `--allow-pull` is given (about
1 GB compressed per instance). A run record's own `status` is not a score:
SWE-bench tasks have no local checks, so it is always `incomplete`.

Context feasibility (preregistered, needs the models' tokenizer files locally):

```bash
node benchmarks/swebench/capture_initial_request.mjs   # each agent's real first request, via a fake server
.cache/venv-bfcl/bin/python benchmarks/swebench/context_feasibility.py
```

## Licenses

BFCL is Apache-2.0; small result files with its prompts are committed as
evidence. The SWE-bench Verified card declares no license: the parquet, issue
texts, gold patches and logs containing them are not committed
(`results/swebench-offline-validation-2026-10-29/WITHHELD-SHA256.json`).
