"""KAB bridge for mini-swe-agent (Harness v2, docs/research/HARNESS_V2.md §7).

Runs mini-swe-agent's own DefaultAgent, LitellmModel and SWE-bench config
UNCHANGED, except for the environment: KabBridgeEnvironment executes nothing
itself. Every action is sent to the Node adapter (harness/src/agent/adapters/
mini-swe-agent.mjs), which runs it in the task's KAB DockerSandbox and returns
the result. This process never spawns a shell.

Protocol (JSON lines):
  stdin  line 1         Node -> bridge  run config (see adapter)
  fd 3   {"type":"exec"} bridge -> Node  one action
  stdin  {"id":..}      Node -> bridge  its result
  fd 3   {"type":"result"} bridge -> Node  final outcome (last line)
stdout/stderr are free-form logs (mini prints there).
"""

import base64
import hashlib
import importlib.metadata as md
import json
import os
import platform
import sys
from pathlib import Path
from typing import Any

PROTO = os.fdopen(3, "w", buffering=1, encoding="utf-8")


def send(msg: dict) -> None:
    PROTO.write(json.dumps(msg) + "\n")


def verify_install(lock: dict) -> tuple[str | None, int]:
    """Every installed distribution (mini-swe-agent and all its dependencies)
    must be byte-identical to its wheel, per the wheel's RECORD hashes; every
    locked dependency must be installed at its locked version; and no .pth
    file (code run at interpreter start) may exist. Returns (problem or None,
    files checked). About 1 s for the pinned set."""
    import site

    checked = 0
    for dist in md.distributions():
        for f in dist.files or []:
            if not f.hash or f.hash.mode != "sha256":
                continue
            digest = base64.urlsafe_b64encode(hashlib.sha256(f.locate().read_bytes()).digest()).rstrip(b"=").decode()
            if digest != f.hash.value:
                return f"installed file differs from its wheel: {dist.metadata['Name']}: {f}", checked
            checked += 1
    if checked == 0:
        return "no RECORD hashes to verify", 0
    for sp in site.getsitepackages():
        pth = sorted(Path(sp).glob("*.pth"))
        if pth:
            return f"unexpected .pth file(s) in site-packages: {[p.name for p in pth]}", checked
    for name, version in lock.items():
        try:
            got = md.version(name)
        except md.PackageNotFoundError:
            return f"locked dependency {name}=={version} is not installed", checked
        if got != version:
            return f"dependency {name} is {got}, lock says {version}", checked
    return None, checked


def _count(v: Any) -> int | None:
    """A provider-reported token count, or None when absent (never 0 for missing)."""
    return v if isinstance(v, int) and not isinstance(v, bool) and v >= 0 else None


def call_record(index: int, response: Any) -> dict:
    """One model call as KAB records it (trace.modelCalls, kab.model-call/v1).
    Token counts are the provider's own usage fields, or None."""
    r = response if isinstance(response, dict) else {}
    u = r.get("usage") if isinstance(r.get("usage"), dict) else {}
    # litellm turns an absent usage block into zeros. A chat prompt is never 0
    # tokens (the template alone has some), so prompt == total == 0 is that
    # placeholder: unknown, not 0.
    if u.get("prompt_tokens") == 0 and u.get("total_tokens") == 0:
        u = {}
    details = u.get("completion_tokens_details") if isinstance(u.get("completion_tokens_details"), dict) else {}
    c0 = (r.get("choices") or [None])[0]
    choice = c0 if isinstance(c0, dict) else {}
    message = choice.get("message") if isinstance(choice.get("message"), dict) else {}
    return {
        "index": index, "outcome": None, "error": None, "startedAt": None, "durationMs": None,
        "promptTokens": _count(u.get("prompt_tokens")), "completionTokens": _count(u.get("completion_tokens")),
        "totalTokens": _count(u.get("total_tokens")), "reasoningTokens": _count(details.get("reasoning_tokens")),
        # Characters of returned reasoning text (None if none): parser-independent,
        # unlike reasoning_tokens (Kanana's deepseek_r1 parser always reports 0).
        "reasoningChars": len(rt) if isinstance(rt := message.get("reasoning_content") or message.get("reasoning"), str) and rt else None,
        "finishReason": choice.get("finish_reason"), "toolCallsRequested": len(message.get("tool_calls") or []),
        "firstToolCall": None, "toolCallsExecuted": 0,
    }


def observed(query, calls: list):
    """Wraps model.query to record each call. Observation only: arguments,
    return value and exceptions pass through unchanged. One record per
    DefaultAgent model call (upstream's retries of one call are inside it,
    so durationMs includes their backoff)."""
    import time

    from minisweagent.exceptions import FormatError

    def wrapper(*args, **kwargs):
        started, t0 = time.time(), time.monotonic()
        rec = None
        try:
            message = query(*args, **kwargs)
            rec = call_record(len(calls), (message.get("extra") or {}).get("response"))
            rec["outcome"] = "response"
            return message
        except FormatError as e:  # upstream persisted the response on the error message
            rec = call_record(len(calls), ((e.messages[0] if e.messages else {}).get("extra") or {}).get("response"))
            rec["outcome"] = "format_error"
            raise
        except BaseException as e:
            rec = call_record(len(calls), None)
            rec["outcome"], rec["error"] = "error", f"{type(e).__name__}: {str(e)[:500]}"
            raise
        finally:
            rec["startedAt"], rec["durationMs"] = int(started * 1000), int((time.monotonic() - t0) * 1000)
            calls.append(rec)

    return wrapper


def main() -> int:
    cfg = json.loads(sys.stdin.readline())

    import yaml
    from pydantic import BaseModel

    import minisweagent
    from minisweagent.agents.default import DefaultAgent
    from minisweagent.environments.docker import DockerEnvironment
    from minisweagent.models import get_model
    from minisweagent.utils.serialize import recursive_merge

    if minisweagent.__version__ != cfg["expectedVersion"]:
        send({"type": "fatal", "error": f"mini-swe-agent {minisweagent.__version__} installed, {cfg['expectedVersion']} pinned"})
        return 2

    problem, verified_files = verify_install(cfg.get("lock", {}))
    if problem:
        send({"type": "fatal", "error": problem})
        return 2

    config_path = minisweagent.package_dir / "config" / "benchmarks" / cfg["configName"]
    raw = config_path.read_bytes()
    config_sha = hashlib.sha256(raw).hexdigest()
    if config_sha != cfg["expectedConfigSha256"]:
        send({"type": "fatal", "error": f"{cfg['configName']} sha256 {config_sha} != pinned {cfg['expectedConfigSha256']}"})
        return 2
    upstream = yaml.safe_load(raw)

    # KAB executes in its own sandbox; any other environment class would run
    # commands outside it, so it is refused rather than ignored.
    env_cls = cfg.get("overrides", {}).get("environment", {}).get("environment_class")
    if env_cls not in (None, "kab_bridge"):
        send({"type": "fatal", "error": f"environment_class '{env_cls}' refused: only the KAB bridge may execute"})
        return 2

    config = recursive_merge(upstream, cfg.get("overrides", {}))
    # The one prompt deviation: the KAB workspace is mounted at `workdir`
    # (/workspace), not the image's /testbed. Counted and reported.
    template = config["agent"]["instance_template"]
    substitutions = template.count("/testbed")
    config["agent"]["instance_template"] = template.replace("/testbed", cfg["workdir"])

    env_cfg = {k: v for k, v in config.get("environment", {}).items() if k != "environment_class"}
    calls: list[dict] = []

    class KabBridgeEnvironmentConfig(BaseModel):
        cwd: str
        timeout: int = 30
        env: dict[str, str] = {}
        interpreter: list[str] = ["bash", "-c"]

    class KabBridgeEnvironment:
        # Upstream's own submission check (first output line ==
        # COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT and returncode 0).
        _check_finished = DockerEnvironment._check_finished

        def __init__(self, **kwargs):
            self.config = KabBridgeEnvironmentConfig(**kwargs)
            self._n = 0

        def execute(self, action: dict, cwd: str = "", *, timeout: int | None = None) -> dict[str, Any]:
            self._n += 1
            if calls:  # the model call whose response asked for this action
                calls[-1]["toolCallsExecuted"] += 1
                if calls[-1]["firstToolCall"] is None:
                    calls[-1]["firstToolCall"] = self._n - 1
            send({
                "type": "exec", "id": self._n, "command": action.get("command", ""),
                "cwd": cwd or self.config.cwd, "timeout": timeout or self.config.timeout,
                "interpreter": self.config.interpreter, "env": self.config.env,
            })
            reply = json.loads(sys.stdin.readline())
            if reply.get("id") != self._n:
                raise RuntimeError(f"bridge protocol: expected reply {self._n}, got {reply.get('id')}")
            output = {"output": reply.get("output", ""), "returncode": reply.get("returncode", -1),
                      "exception_info": reply.get("exception_info", "")}
            if reply.get("exception_info"):
                output["extra"] = {"exception_type": "KabSandboxError", "exception": reply["exception_info"]}
            self._check_finished(output)
            return output

        def get_template_vars(self, **kwargs) -> dict[str, Any]:
            return recursive_merge(self.config.model_dump(), platform.uname()._asdict(), kwargs)

        def serialize(self) -> dict:
            return {"info": {"config": {"environment": self.config.model_dump(mode="json"),
                                        "environment_type": "kab_bridge.KabBridgeEnvironment"}}}

    env = KabBridgeEnvironment(**env_cfg)
    model = get_model(config=config["model"])
    model.query = observed(model.query, calls)
    agent_cfg = dict(config["agent"])
    agent_cfg["output_path"] = Path(cfg["trajectoryPath"]) if cfg.get("trajectoryPath") else None
    agent = DefaultAgent(model, env, **agent_cfg)

    error = None
    try:
        info = agent.run(cfg["task"])
    except Exception as e:  # upstream already appended an exit message
        info = agent.messages[-1].get("extra", {}) if agent.messages else {}
        error = f"{type(e).__name__}: {e}"

    send({
        "type": "result",
        "exitStatus": info.get("exit_status", ""),
        "submission": info.get("submission", ""),
        "error": error,
        "nCalls": agent.n_calls,
        "nActions": env._n,
        "installVerifiedFiles": verified_files,
        "modelCalls": calls,
        "finishReasons": [c["finishReason"] for c in calls if c["outcome"] != "error"],
        "miniVersion": minisweagent.__version__,
        "modelClass": f"{type(model).__module__}.{type(model).__name__}",
        "configName": cfg["configName"],
        "configSha256": config_sha,
        "promptSubstitutions": substitutions,
        "effectiveAgentConfig": {k: v for k, v in agent.config.model_dump(mode="json").items()
                                 if k not in ("system_template", "instance_template")},
        "python": platform.python_version(),
    })
    return 0


if __name__ == "__main__":
    sys.exit(main())
