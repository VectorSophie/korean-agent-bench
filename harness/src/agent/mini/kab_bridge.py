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
    agent_cfg = dict(config["agent"])
    agent_cfg["output_path"] = Path(cfg["trajectoryPath"]) if cfg.get("trajectoryPath") else None
    agent = DefaultAgent(model, env, **agent_cfg)

    error = None
    try:
        info = agent.run(cfg["task"])
    except Exception as e:  # upstream already appended an exit message
        info = agent.messages[-1].get("extra", {}) if agent.messages else {}
        error = f"{type(e).__name__}: {e}"

    usage = {"promptTokens": 0, "completionTokens": 0, "modelCalls": 0}
    finish_reasons = []
    for m in agent.messages:
        resp = (m.get("extra") or {}).get("response")
        if isinstance(resp, dict):
            u = resp.get("usage") or {}
            usage["promptTokens"] += u.get("prompt_tokens") or 0
            usage["completionTokens"] += u.get("completion_tokens") or 0
            usage["modelCalls"] += 1
            finish_reasons.append(((resp.get("choices") or [{}])[0]).get("finish_reason"))

    send({
        "type": "result",
        "exitStatus": info.get("exit_status", ""),
        "submission": info.get("submission", ""),
        "error": error,
        "nCalls": agent.n_calls,
        "nActions": env._n,
        "installVerifiedFiles": verified_files,
        "usage": usage,
        "finishReasons": finish_reasons,
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
