// The SWE-bench agent sandbox in a real official instance image: the testbed
// interpreter is on PATH, pytest runs, and the agent's workspace copy (not the
// image's /testbed) is what gets imported. Docker tier; skipped without the
// image (SKIP_DOCKER=1 or image not pulled).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerSandbox, SandboxConfigError } from "../src/sandbox/docker.mjs";
import { buildTask } from "../src/benchmarks/swebench.mjs";

const IMAGE = "swebench/sweb.eval.x86_64.psf_1776_requests-6028:latest";
const haveImage = !process.env.SKIP_DOCKER && spawnSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore" }).status === 0;

describe("SWE-bench sandbox", () => {
  it("rejects task env keys other than PATH", () => {
    assert.throws(() => new DockerSandbox({ sandbox: { type: "docker", image: IMAGE, env: { OPENAI_API_KEY: "x" } } }), SandboxConfigError);
  });

  it("official image: testbed python + pytest on PATH; workspace copy imported", { skip: !haveImage && "official image not present" }, async () => {
    const ws = mkdtempSync(join(tmpdir(), "h31-"));
    try {
      mkdirSync(join(ws, "requests"));
      writeFileSync(join(ws, "requests", "__init__.py"), "MARKER = 'workspace-copy'\n");
      execFileSync("chmod", ["-R", "a+rX", ws]);
      const task = buildTask({ instance_id: "psf__requests-6028", repo: "psf/requests", base_commit: "x", problem_statement: "p", image: IMAGE }, { repoDir: ws });
      const sb = new DockerSandbox(task);
      await sb.setup(ws);
      const r = await sb.execShell("command -v python pytest; python -m pytest --version 2>&1 | tail -1; python -c 'import requests; print(requests.MARKER)'");
      await sb.teardown?.();
      assert.equal(r.infraError, null, r.stderr);
      assert.match(r.stdout, /\/opt\/miniconda3\/envs\/testbed\/bin\/python/);
      assert.match(r.stdout, /pytest \d/);
      assert.match(r.stdout, /workspace-copy/);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
