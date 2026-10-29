#!/usr/bin/env python3
"""Deterministic OpenAI-compatible mock for OFFLINE validation of the BFCL pipeline.

    fake_server.py <plan.json> <port> <requests.jsonl>

It is not a model. It answers each chat-completions request from a plan built
from BFCL's own ground truth (validate_offline.py), so the official generator
and scorer can be exercised end to end without a GPU:
  mode "gold":    emit the ground-truth calls (single turn) or each turn's
                  ground-truth calls, then end the turn with text (multi turn);
                  for no-call entries, answer in text.
  mode "invalid": emit a call with a wrong argument value, a call where none is
                  expected, no call where one is expected (relevance), or no
                  calls in a multi-turn entry.
Every request body is appended to requests.jsonl (request-contract evidence).
"""
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PLAN = json.loads(open(sys.argv[1]).read())
PORT = int(sys.argv[2])
LOG = sys.argv[3]
LOCK = threading.Lock()
WRONG = "__kab_invalid_value__"


def first_user(messages):
    for m in messages:
        if m.get("role") == "user":
            c = m.get("content")
            return c if isinstance(c, str) else json.dumps(c)
    return None


def calls_message(calls, seq):
    return {"role": "assistant", "content": None, "tool_calls": [
        {"id": f"call_{seq}_{i}", "type": "function", "function": {"name": c["name"], "arguments": json.dumps(c["args"])}}
        for i, c in enumerate(calls)]}


def respond(body):
    msgs = body.get("messages", [])
    entry = PLAN["entries"].get(first_user(msgs))
    mode = PLAN["mode"]
    if entry is None:
        return {"role": "assistant", "content": "kab-mock: no plan entry for this request"}
    if entry["kind"] == "relevance":
        return calls_message(entry["calls"], 0) if mode == "gold" else {"role": "assistant", "content": "No call."}
    if entry["kind"] == "single":
        calls = entry["calls"]
        if mode == "gold":
            return calls_message(calls, 0) if calls else {"role": "assistant", "content": "None of the provided functions apply."}
        if calls:
            bad = [{"name": c["name"], "args": {k: WRONG for k in c["args"]} or {"unexpected_arg": WRONG}} for c in calls]
            return calls_message(bad, 0)
        tool = (body.get("tools") or [{}])[0].get("function", {}).get("name", "unexpected_call")
        return calls_message([{"name": tool, "args": {}}], 0)
    # multi turn: turn index = number of user messages so far - 1
    turn = sum(1 for m in msgs if m.get("role") == "user") - 1
    if mode != "gold" or msgs[-1].get("role") == "tool" or turn >= len(entry["turns"]) or not entry["turns"][turn]:
        return {"role": "assistant", "content": "Done."}
    return calls_message(entry["turns"][turn], turn)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def _send(self, obj, code=200):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.rstrip("/").endswith("/models"):
            return self._send({"object": "list", "data": [{"id": PLAN["servedModelName"], "object": "model"}]})
        self._send({"error": "not found"}, 404)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
        with LOCK, open(LOG, "a") as f:
            f.write(json.dumps(body) + "\n")
        if not self.path.rstrip("/").endswith("/chat/completions"):
            return self._send({"error": "not found"}, 404)
        message = respond(body)
        finish = "tool_calls" if message.get("tool_calls") else "stop"
        self._send({"id": "kab-mock", "object": "chat.completion", "created": 0, "model": body.get("model"),
                    "choices": [{"index": 0, "message": message, "finish_reason": finish}],
                    "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}})


if __name__ == "__main__":
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"kab-mock listening on {PORT}", flush=True)
    srv.serve_forever()
