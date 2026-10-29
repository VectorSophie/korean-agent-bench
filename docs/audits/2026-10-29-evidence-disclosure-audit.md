# Evidence disclosure audit — 2026-10-29

Audit of what this public repository discloses, focused on the evidence
copied from local operational material: `models/serving-records/` (from the
unversioned `model-prep` workspace) and `results/pilot-2026-10/` (live pilot
run records), plus `datasets/`, model configuration, and docs.

**Result: no credentials, private endpoints, or held-out benchmark content
found. Nothing redacted; no rotation required.** Some low-sensitivity personal
and infrastructure details are present and were kept deliberately (below).
This is a pattern-and-review audit, not proof of absence; see Limitations.

## Scope

- Tree: all 268 tracked files at `main` 966d879, excluding the
  `vendor/upstage-cli` submodule (a separate repository).
- History: every commit reachable from any ref after `git fetch`, including
  the 13 synthetic rows dropped in korean-agent-bench#1.
- Commit metadata (author/committer identities).
- Not in scope: the private `model-prep` directory itself, upstage-cli,
  GitHub PR/issue text.

## Method and findings

| # | Check | Tool / method | Finding |
|---|---|---|---|
| 1 | High-entropy strings and keyword secrets in the tree | `detect-secrets` 1.5.0 `scan --all-files` | 187 hits outside `vendor/`, each reviewed. 176: commit SHAs, image digests, file hashes, run tokens (`T3-…`, `BV1H-…`) in hash/revision fields. 11 others: fake test keys (`up_sk_abcdef123456` in h11, `"secret"` in h14), a hex test constant (h18), HF snapshot paths containing revision SHAs, run ids. **0 real secrets.** |
| 2 | Known credential formats in all history (Anthropic, OpenAI, GitHub, HF, Upstage, AWS, Slack, PEM private keys) | regex over `git log -p --all` | only the fake test key `up_sk_abcdef123456` (3 occurrences). |
| 3 | Credential-bearing env assignments / auth headers | regex over evidence + docs | one doc placeholder (`UPSTAGE_API_KEY=your_key` in HARNESS.md). |
| 4 | Endpoints | URL + IPv4 extraction | `http://` only to `127.0.0.1:8101/8102` (loopback). `https://` only to public sites (github.com, huggingface.co, example.com in tests, three public reference links). No private hosts or IPs. |
| 5 | Environment / host leakage in run records | key walk of all 27 records; list of all 105 agent tool calls | records contain no env, header or token fields. Every tool call targets fixture files in the task workspace (`read_file`, `write_file`, `node gen.mjs`, `ls -la`, …); no env dumps, dotfiles or host paths read. 23 records ran in the native sandbox, 4 in Docker. |
| 6 | Held-out benchmark content | regex for held-out ids/pack names over tree and all history | 0 (ADR 0004). |
| 7 | Binary files that text scans cannot read | `file --mime-encoding` | none; every tracked file is ASCII/UTF-8 text. |

## Retained low-sensitivity disclosures

Kept because they are part of the verbatim evidence (ADR 0005), have
negligible security impact, and are already public in git history (removing
them now would not remove them from history; no history rewrite is done):

| Item | Where | Assessment |
|---|---|---|
| Personal email `jay7math@gmail.com` as commit author (102 commits) | commit metadata | Already public in upstage-cli's history, from which these commits were extracted. Future commits can use the GitHub noreply address. |
| Local username `jackb` and disk layout (`/home/jackb/workspace/…`, `/data/jackb/…`, HF cache path) | serving records, `PILOT_REPORT.md`, provenance | Reveals a username and directory layout, not credentials. Useful to interpret the records. |
| Other workloads on the shared machine (Sinsan, GLM/MiMo, RAGAS, `karmic-kraken` image, krasis, scopeweaver) | serving notes, launchers, pilot report | Names only. They explain the GPU-sharing guard in the launchers (foreign-compute allowance) and the `contended` tag. |
| GPU model and driver version | `models-manifest.json` | Needed for reproducibility. |
| Hugging Face username `VectorSophie` and that it lacks access to one gated repo (KRAFTON Raon) | `models-manifest.json` | Public username; access status is low sensitivity. |

## Guard going forward

`scripts/check-evidence.sh` (run in CI's evidence job) fails on credential
formats, non-loopback `http://` endpoints, or held-out identifiers under
`models/`, `results/`, `datasets/`. Mutation-checked: a fake HF token and a
private `http://10.0.0.5` endpoint each fail it. `SHA256SUMS` in both
evidence directories are unchanged by this audit (nothing was modified).

## Limitations

- Pattern-based detection finds known shapes; a secret in an unusual format
  could be missed. The manual review covered flagged lines and the run-record
  structure, not a line-by-line read of the 2.5 MB `probe_raw.json` (a
  Hugging Face API file listing, by its generator `probe_models.py`).
- Checksums prove the copies match their sources; they say nothing about
  what the sources contain.
- GitHub PR descriptions, comments, and forks are outside this repository and
  were not audited.
