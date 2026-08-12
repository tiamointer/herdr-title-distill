import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  MAX_TITLE_CHARS,
  compressTitle,
  mayOverwriteLabel,
  syncTitle,
  visibleCharCount,
  type HerdrClient,
} from "../extension/index.ts";

type PaneFixture = {
  pane_id: string;
  tab_id: string;
  terminal_id: string;
  label?: string;
};

type TabFixture = {
  tab_id: string;
  pane_count: number;
  label: string;
};

class FakeHerdrClient implements HerdrClient {
  readonly calls: Array<{ method: string; params: Record<string, unknown> }> = [];

  constructor(
    readonly pane: PaneFixture,
    readonly tab: TabFixture,
  ) {}

  async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === "pane.get") return { result: { pane: { ...this.pane } } };
    if (method === "tab.get") return { result: { tab: { ...this.tab } } };
    if (method === "pane.rename") {
      assert.equal(params.pane_id, this.pane.pane_id);
      assert.equal(typeof params.label, "string");
      this.pane.label = params.label;
      return { result: { pane: { ...this.pane } } };
    }
    if (method === "tab.rename") {
      assert.equal(params.tab_id, this.tab.tab_id);
      assert.equal(typeof params.label, "string");
      this.tab.label = params.label;
      return { result: { tab: { ...this.tab } } };
    }
    return { error: { code: "unsupported-method" } };
  }
}

const fixtures: Array<[string, string]> = [
  ["评估一下这个skill是否值得安装", "技能可装性"],
  ["实现 OMP 到 Herdr 的无模型标题同步器 skill", "OMP无模型标题同步"],
  ["设计提示词并生成音乐", "提示词音乐"],
  ["Evaluate Herdr auto-title skill", "Herdr标题"],
  ["Sync Codex priority to Claude", "Codex优先级同步"],
  ["Remove OpenClaw and clean residue", "OpenClaw残留"],
  ["Create vertical abstract memory panel", "记忆面板"],
  ["安装 OfficeCLI 工具", "OfficeCLI"],
  ["修复 Herdr pane 重命名故障", "Herdr故障修复"],
  ["Investigate frobnicator latency regression", "延迟回归"],
  ["π ⠋ Evaluate Herdr auto-title skill", "Herdr标题"],
  ["Supercalifragilistic", "Super…stic"],
];

for (const [source, expected] of fixtures) {
  const actual = compressTitle(source);
  assert.equal(actual, expected, source);
  assert.ok(visibleCharCount(actual) <= MAX_TITLE_CHARS, `${source}: ${actual}`);
}

assert.equal(
  compressTitle("Evaluate Herdr auto-title skill", {
    "Evaluate Herdr auto-title skill": "标题审计",
  }),
  "标题审计",
);
assert.equal(mayOverwriteLabel(undefined, undefined), true);
assert.equal(mayOverwriteLabel("", undefined), true);
assert.equal(mayOverwriteLabel("7", undefined), true);
assert.equal(mayOverwriteLabel("上次自动名", "上次自动名"), true);
assert.equal(mayOverwriteLabel("手工名", "上次自动名"), false);

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-herdr-title-sync-test-"));
const pane: PaneFixture = {
  pane_id: "w1:p1",
  tab_id: "w1:t1",
  terminal_id: "term-test",
};
const tab: TabFixture = {
  tab_id: "w1:t1",
  pane_count: 1,
  label: "3",
};
const client = new FakeHerdrClient(pane, tab);

const first = await syncTitle("Evaluate Herdr auto-title skill", client, {
  paneId: pane.pane_id,
  stateDir,
});
assert.equal(first.ok, true);
assert.equal(first.title, "Herdr标题");
assert.equal(first.pane_status, "renamed");
assert.equal(first.tab_status, "renamed");
assert.equal(pane.label, "Herdr标题");
assert.equal(tab.label, "Herdr标题");

const second = await syncTitle("Remove OpenClaw and clean residue", client, {
  paneId: pane.pane_id,
  stateDir,
});
assert.equal(second.ok, true);
assert.equal(pane.label, "OpenClaw残留");
assert.equal(tab.label, "OpenClaw残留");

pane.label = "手工窗";
const paneProtected = await syncTitle("设计提示词并生成音乐", client, {
  paneId: pane.pane_id,
  stateDir,
});
assert.equal(paneProtected.pane_status, "manual-protected");
assert.equal(pane.label, "手工窗");
assert.equal(tab.label, "提示词音乐");

pane.label = "OpenClaw残留";
tab.label = "手工页";
const tabProtected = await syncTitle("Create vertical abstract memory panel", client, {
  paneId: pane.pane_id,
  stateDir,
});
assert.equal(tabProtected.pane_status, "renamed");
assert.equal(tabProtected.tab_status, "manual-protected");
assert.equal(pane.label, "记忆面板");
assert.equal(tab.label, "手工页");

pane.label = "记忆面板";
tab.label = "提示词音乐";
tab.pane_count = 2;
const multiPane = await syncTitle("评估一下这个skill是否值得安装", client, {
  paneId: pane.pane_id,
  stateDir,
});
assert.equal(multiPane.pane_status, "renamed");
assert.equal(multiPane.tab_status, "multi-pane-preserved");
assert.equal(pane.label, "技能可装性");
assert.equal(tab.label, "提示词音乐");

const allowedMethods = ["pane.get", "pane.rename", "tab.get", "tab.rename"];
for (const call of client.calls) {
  assert.ok(allowedMethods.includes(call.method), call.method);
}
assert.ok(fs.readdirSync(stateDir).some((name) => name.endsWith(".json")));
fs.rmSync(stateDir, { recursive: true, force: true });

console.log(
  JSON.stringify(
    {
      status: "pass",
      title_fixtures: fixtures.length,
      max_visible_chars: Math.max(...fixtures.map(([source]) => visibleCharCount(compressTitle(source)))),
      sync_scenarios: 5,
      herdr_methods: allowedMethods,
    },
    null,
    2,
  ),
);
