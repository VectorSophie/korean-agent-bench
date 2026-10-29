# Status

Snapshot as of **2026-10-29** (end of the consolidation session). Update with
a new date whenever a claim below changes. Legend: **implemented** (code
exists) · **tested** (automated tests) · **verified** (exercised against the
real upstream tool or data) · **not executed** · **planned** · **unsupported**.

## Repository state

| Area | State | Evidence |
|---|---|---|
| Harness extracted from upstage-cli with history (41 commits) | verified | `docs/MIGRATION.md` |
| upstage-cli as pinned submodule `7380ef6` (harness removed upstream) | verified | ADR 0002 pin history; `h24` (incl. every imported name exported at the pin) |
| upstage-cli#12 closed unmerged; held-out candidates retired as disclosed | done | `docs/MIGRATION.md` "PR #12" |
| upstage-cli#13 (cleanup) and #14 (session-index fix) merged | done | upstage-cli `7380ef6`, `160292b` |
| Synthetic fixtures reduced to 15 rows / 12 families, all excluded from comparison | tested | ADR 0007; `h20`, `h25` |
| Run provenance: harness + upstage-cli commit/pin/dirty | tested | `h24` |
| Serving preflight (declared vs observed, fail closed) | tested against fakes; **not executed against a live server** | ADR 0008; `h26`, `h27` |
| Solar launcher by digest at 8192 | tested (`print-config`, fake docker); **not executed** | `models/serving/kserve-solar.sh`; `h27` |
| Evidence disclosure audit; CI guard | done | `docs/audits/2026-10-29-evidence-disclosure-audit.md`; `scripts/check-evidence.sh` |
| BFCL official pipeline | verified offline (official generate + evaluate, mock model) | ADR 0009; `results/bfcl-offline-validation-2026-10-29/` |
| SWE-bench Verified official scoring | verified offline on 1 instance (official evaluator, official image) | `results/swebench-offline-validation-2026-10-29/` |
| SWE-bench agent prediction pipeline | verified with a replay agent; tested (`h29`) | same |
| Context feasibility for the SWE-bench subset | computed (preregistered) | `datasets/swe-bench-verified/context-feasibility-v1.json` |
| Any live model inference in this repository | **not executed** (the 2026-10 pilot predates it) | `results/pilot-2026-10/` |

## Verified on 2026-10-29

Local (Node v24.21.0, Python 3.12.3, Docker): harness unit **405/405**,
Docker tier **35/35**, lint, check, smoke, `benchmark:validate` (15, 0
warnings), `benchmark:qa` 15/15, evidence checksums (4 directories), evidence
guard. BFCL offline validation: official scorer gold **22/22**, invalid
**0/22** across 12 categories. SWE-bench offline validation: official
evaluator gold-via-agent-pipeline **resolved**, empty **empty_patch**, wrong
**unresolved**, malformed **error**. GitHub CI results per PR are listed in
`docs/MIGRATION.md`.

## Blockers before a reportable model comparison

1. **upstage-cli context limits for local models.** upstage-cli has no
   capability entries for `Kanana-2`, `EXAONE-4.5`, `A.X-4.0`,
   `solar-open2-250b` and uses a 65,536-token fallback. Its repository-context
   cap (23,592 chars) and context management therefore ignore the validated
   8K/16K windows. Affects every agent run (SWE-bench especially); not BFCL's
   official track, which does not use upstage-cli. Fix upstream, move the pin.
2. **Live preflight.** `harness preflight` has only run against fakes and
   against this machine with no server up (correctly BLOCKED). The first
   controlled live session must start with it and keep its output.
3. **Frozen envelopes.** SWE-bench agent envelope (30 turns, 1800 s, tool
   set) and BFCL settings are provisional; an ADR must freeze them, admit
   datasets (`mainComparison: admitted`) and fix the statistical analysis.
4. **Korean condition undefined.** BFCL and SWE-bench are English; how a
   Korean variant is produced and reviewed is open (ADR 0003).

## Known limits

- Serving: one machine, shared; contended timings; models served one at a
  time. Quantization and sampling are `declared_only` in preflight; the
  checkpoint check is by snapshot directory name.
- Solar Open 2 is an unofficial NVFP4 quantization and is validated to 8K
  context; 1 of 100 SWE-bench subset instances is certainly infeasible for it,
  99 depend on the retrieved repository context.
- BFCL: subset scored with `--partial-eval` (not comparable to the public
  leaderboard); `memory`, `web_search`, `format_sensitivity`,
  `multi_turn_long_context`, `multi_turn_miss_*` not covered; generation has
  only been exercised against a mock server.
- SWE-bench: official images are `:latest` tags (digest recorded per run);
  only one instance was evaluated offline; full-subset evaluation needs about
  100 images (~1 GB compressed each).
- An agent-mediated BFCL track is not built.
- SWE-bench Verified declares no dataset license, so its content is not
  committed.
- Synthetic fixtures remain AI-authored; they validate the harness only.

## Ready for a first live evaluation?

**Conditionally, and only for BFCL.** The BFCL official track does not depend
on blocker 1. A controlled first run of one model on a small BFCL slice is
technically possible after serving with `models/serving/`, a REPORTABLE
`harness preflight`, and recording outputs under `results/`. Its numbers would
be a pilot, not a main-comparison result (blocker 3). SWE-bench agent runs
should wait for blocker 1.
