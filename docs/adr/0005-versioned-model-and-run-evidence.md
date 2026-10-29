# ADR 0005 — Model-serving evidence and raw run records are versioned with checksums

## Status

**Accepted** (2026-10-29).

## Context

Two kinds of evidence that the harness's claims rest on were not under
version control:

- **Model-serving records.** `harness/src/agent/local-models.mjs` states that
  "nothing here is invented": every checkpoint revision, quantization,
  parser, image digest and context ceiling comes from
  `~/workspace/model-prep`. That directory has no git history.
- **Pilot run records.** `harness/docs/PILOT_REPORT.md` reports three live
  runs, but its 27 run JSON files were written to a session scratchpad under
  `/tmp`, which is not durable.

A claim whose evidence can disappear is not reproducible.

## Decision

- Copy such evidence **verbatim** into the repository — model records to
  `models/serving-records/`, run records to `results/<campaign>/` — with a
  `SHA256SUMS` file verified against the source at copy time.
- Record what git cannot keep (source path, copy date, source mtimes) in a
  `PROVENANCE.md` or `README.md` next to the copy.
- Do not edit copied evidence. Where a later record supersedes an earlier
  one, say so in the provenance note.
- Scan for credentials and held-out references before copying.
- Large artifacts (model weights, full external datasets) are **referenced**
  by pinned revision and checksum, never committed.

## Consequences

- The model cards in `docs/models/` cite files in this repository.
- Future live runs should write directly into `results/<campaign>/` (or be
  copied there with the same procedure) before their summary is written.
- `models/serving-records/` describes one machine. Paths such as
  `/data/jackb/...` inside it are that machine's layout, not requirements.
