# korean-agent-bench

Reproducible evaluation of Korean LLMs as coding agents: four locally served
models (Kanana 2, EXAONE 4.5, A.X 4.0, Solar Open 2) driven through the real
agent loop and tools of [upstage-cli](https://github.com/VectorSophie/upstage-cli),
in isolated sandboxes, with trusted evaluators and per-run provenance.

**Status (2026-10-29): infrastructure verified, no model comparison yet.**
BFCL and SWE-bench Verified are integrated with their official evaluators and
validated offline (mock model / replayed patches); no model has been run on
them. A serving preflight checks live servers against their declared
configuration. The repository's own task sets are AI-authored regression
fixtures, excluded from model comparison. Blockers and readiness:
[`docs/STATUS.md`](docs/STATUS.md).

## Quick start

```bash
git clone --recurse-submodules https://github.com/VectorSophie/korean-agent-bench.git
cd korean-agent-bench
(cd vendor/upstage-cli && bun install --frozen-lockfile)
cd harness && npm ci && npm test
node bin/harness.mjs run tasks/fix-flaky-test.yaml --agent mock
```

Requires Node.js >= 22, Bun >= 1.3, and Docker for the Docker tier. Full
verification: [`docs/VERIFY.md`](docs/VERIFY.md). Evaluating a local model
requires serving it first: [`docs/protocol/EXPERIMENT_PROTOCOL.md`](docs/protocol/EXPERIMENT_PROTOCOL.md).

## Map

| | |
|---|---|
| [`docs/STATUS.md`](docs/STATUS.md) | dated status: what works, what is verified, what is not yet known |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | layout, dependency boundary with upstage-cli, run data flow |
| [`docs/adr/`](docs/adr/) | architecture decision records |
| [`docs/models/`](docs/models/README.md) | one card per model: checkpoint, revision, quantization, serving, hardware, limitations |
| [`docs/protocol/`](docs/protocol/EXPERIMENT_PROTOCOL.md) | how runs are prepared, executed and reported |
| [`docs/research/`](docs/research/README.md) | dated research history (pilot, benchmark-v1 audit, trace evaluation) |
| [`docs/MIGRATION.md`](docs/MIGRATION.md) | what moved from upstage-cli, how, and how it was verified |
| [`benchmarks/`](benchmarks/README.md) | BFCL and SWE-bench Verified: acquisition, generation, official scoring |
| [`datasets/registry.json`](datasets/registry.json) | every task set, its origin, version, license and permitted use |
| [`docs/audits/`](docs/audits/) | dated audits (evidence disclosure) |
| [`harness/`](harness/) | the harness ([`harness/docs/HARNESS.md`](harness/docs/HARNESS.md)) |
| [`models/serving/`](models/serving/) | maintained model launchers |
| [`models/serving-records/`](models/serving-records/) | model-serving evidence (verbatim, checksummed) |
| [`results/`](results/) | raw run records (verbatim, checksummed) |
| `vendor/upstage-cli` | the agent under test, pinned submodule |

## Principles

- Claims cite evidence in this repository: a record, a test, or a run.
- Synthetic tasks are for building the instrument, not for ranking models.
- External benchmarks keep their original task identity and evaluator.
- Held-out material never enters the repository.
- Limitations are written down, with dates.

## License

MIT — see [`LICENSE`](LICENSE). Model weights, external benchmarks and
upstage-cli carry their own licenses (see `docs/models/` and
`datasets/registry.json`).
