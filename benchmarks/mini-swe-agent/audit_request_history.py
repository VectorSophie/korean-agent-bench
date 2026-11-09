#!/usr/bin/env python3
"""What a mini-swe-agent run sent to the model, replayed without inference.

  capture   (mini venv)  re-issue every recorded model call of a KAB run record
            through mini's own LitellmModel (same config, same message list) to
            a local capture server that answers with the recorded response; the
            exact HTTP request bodies are written to OUT/bodies.jsonl.
  tokenize  (a venv with transformers)  render each captured body with the
            checkpoint's own chat template and tokenizer, as sent and with the
            reasoning of earlier assistant turns removed, and compare with the
            prompt_tokens the server reported for that call.

    .cache/venv-mini/bin/python -I benchmarks/mini-swe-agent/audit_request_history.py capture RUN.json OUT
    .cache/venv-bfcl/bin/python -I benchmarks/mini-swe-agent/audit_request_history.py tokenize OUT SNAPSHOT_DIR

Outputs hold the transcript (task content, reasoning): keep OUT under .cache/.
summary.json holds counts only.
"""
import json
import pathlib
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def calls_of(traj: dict) -> list[tuple[int, dict]]:
    """(position, recorded response) of every model call, in order. mini
    persists the response on the assistant message, or on the format-error
    message when parsing failed."""
    return [(i, m["extra"]["response"]) for i, m in enumerate(traj["messages"])
            if isinstance((m.get("extra") or {}).get("response"), dict)]


def capture(run_path: str, out: str) -> None:
    import os
    import tempfile

    # as the adapter does: no user-level mini config (keys, model defaults)
    os.environ["MSWEA_GLOBAL_CONFIG_DIR"] = tempfile.mkdtemp(prefix="kab-audit-")
    os.environ["MSWEA_SILENT_STARTUP"] = "1"
    from minisweagent.models.litellm_model import LitellmModel

    run = json.loads(pathlib.Path(run_path).read_text())
    traj = run["trace"]["agentTrajectory"]
    calls = calls_of(traj)
    pending, bodies = [], []

    class H(BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802
            bodies.append(json.loads(self.rfile.read(int(self.headers["content-length"]))))
            b = json.dumps(pending.pop(0)).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(b)))
            self.end_headers()
            self.wfile.write(b)

        def log_message(self, *_):
            pass

    srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    cfg = json.loads(json.dumps(traj["info"]["config"]["model"]))
    cfg["model_kwargs"]["api_base"] = f"http://127.0.0.1:{srv.server_address[1]}/v1"
    model = LitellmModel(**cfg)
    for pos, resp in calls:
        pending.append(resp)
        try:
            model.query(traj["messages"][:pos])
        except Exception as e:  # a recorded format error re-raises; the request was still sent
            if type(e).__name__ != "FormatError":
                raise
    srv.shutdown()
    o = pathlib.Path(out)
    o.mkdir(parents=True, exist_ok=True)
    with (o / "bodies.jsonl").open("w") as f:
        for (pos, resp), body in zip(calls, bodies, strict=True):
            f.write(json.dumps({"prompt_tokens": (resp.get("usage") or {}).get("prompt_tokens"), "body": body}) + "\n")
    print(f"captured {len(bodies)} request bodies for {len(calls)} recorded calls")


def tokenize(out: str, snapshot: str) -> None:
    from transformers import AutoTokenizer

    tok = AutoTokenizer.from_pretrained(snapshot, local_files_only=True)
    template = (pathlib.Path(snapshot) / "chat_template.jinja").read_text()
    rows = [json.loads(l) for l in (pathlib.Path(out) / "bodies.jsonl").read_text().splitlines()]

    def count(body: dict, keep_reasoning: bool, args_as_dict: bool) -> int:
        msgs = []
        for m in body["messages"]:
            m = dict(m)
            if not keep_reasoning:
                m.pop("reasoning_content", None)
                m.pop("reasoning", None)
            if args_as_dict and m.get("tool_calls"):
                m["tool_calls"] = [{**tc, "function": {**tc["function"], "arguments": json.loads(tc["function"]["arguments"])}}
                                   for tc in m["tool_calls"]]
            msgs.append(m)
        ids = tok.apply_chat_template(msgs, tools=body.get("tools"), chat_template=template, add_generation_prompt=True,
                                      tokenize=True, **(body.get("chat_template_kwargs") or {}))
        return len(ids["input_ids"] if hasattr(ids, "keys") else ids)  # a BatchEncoding in newer transformers

    per_call, variants = [], {}
    for k, r in enumerate(rows):
        b = r["body"]
        prior = [m for m in b["messages"] if m.get("role") == "assistant"]
        with_r = [m for m in prior if m.get("reasoning_content") or m.get("reasoning")]
        row = {"call": k, "messages": len(b["messages"]), "priorAssistant": len(prior), "priorWithReasoningField": len(with_r),
               "reasoningChars": sum(len(m.get("reasoning_content") or m.get("reasoning") or "") for m in with_r),
               "serverPromptTokens": r["prompt_tokens"]}
        for keep in (True, False):
            for as_dict in (False, True):
                name = f"{'with' if keep else 'without'}Reasoning{'_argsDict' if as_dict else ''}"
                row[name] = count(b, keep, as_dict)
                variants.setdefault(name, 0)
                variants[name] += row[name] == r["prompt_tokens"]
        per_call.append(row)
    summary = {"kind": "mini-request-history-audit", "calls": len(rows), "exactMatchesPerVariant": variants, "perCall": per_call,
               "note": "Counts only. Rendering by the checkpoint's chat_template.jinja + tokenizer.json via transformers; "
                       "a variant matching the server's prompt_tokens on every call is how the server rendered the request."}
    (pathlib.Path(out) / "summary.json").write_text(json.dumps(summary, indent=1) + "\n")
    print(json.dumps({"calls": len(rows), "exactMatchesPerVariant": variants}, indent=1))


if __name__ == "__main__":
    {"capture": capture, "tokenize": tokenize}[sys.argv[1]](*sys.argv[2:])
