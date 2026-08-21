import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

import {
  extractDistillContext,
  SUPPORTED_HARNESSES,
  type DistillContext,
} from "../src/adapters.ts";
import {
  MAX_TITLE_CHARS,
  MIN_TITLE_CHARS,
  mayOverwriteLabel,
  normalizeModelTitle,
  syncGeneratedTitle,
  visibleCharCount,
  type HerdrAgentRecord,
  type HerdrClient,
} from "../src/core.ts";
import { buildDistillPrompt } from "../src/model.ts";
import { DistillService, type ServiceLogEvent } from "../src/service.ts";

type PaneFixture = {
  pane_id: string;
  tab_id: string;
  terminal_id: string;
  label?: string;
};

type TabFixture = {
  tab_id: string;
  pane_count: number;
  label?: string;
};

class FakeHerdrClient implements HerdrClient {
  readonly calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  agents: HerdrAgentRecord[] = [];

  constructor(
    readonly pane: PaneFixture,
    readonly tab: TabFixture,
  ) {}

  async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === "agent.list") return { result: { agents: this.agents.map((agent) => ({ ...agent })) } };
    if (method === "pane.get") return { result: { pane: { ...this.pane } } };
    if (method === "tab.get") return { result: { tab: { ...this.tab } } };
    if (method === "pane.rename") {
      assert.equal(params.pane_id, this.pane.pane_id);
      assert.equal(typeof params.label, "string");
      this.pane.label = params.label as string;
      return { result: { pane: { ...this.pane } } };
    }
    if (method === "tab.rename") {
      assert.equal(params.tab_id, this.tab.tab_id);
      assert.equal(typeof params.label, "string");
      this.tab.label = params.label as string;
      return { result: { tab: { ...this.tab } } };
    }
    return { error: { code: "unsupported-method" } };
  }
}

function appendJsonl(filePath: string, records: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
}

function recordsFor(harness: string, goal: string, answer: string): unknown[] {
  if (harness === "omp" || harness === "pi") {
    return [
      { type: "message", message: { role: "user", content: [{ type: "text", text: goal }] } },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "中间工具调用，不应成为完成答复" }],
          stopReason: "toolUse",
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: answer }],
          stopReason: "stop",
          usage: { totalTokens: 1 },
        },
      },
    ];
  }
  if (harness === "claude") {
    return [
      { type: "user", message: { role: "user", content: [{ type: "text", text: goal }] } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: answer }] } },
    ];
  }
  if (harness === "codex") {
    return [
      {
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: goal }] },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          phase: "commentary",
          content: [{ type: "output_text", text: "处理中，不应成为完成答复" }],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text: answer }],
        },
      },
    ];
  }
  if (harness === "grok") {
    return [
      {
        type: "user",
        content: [{ type: "text", text: `<user_query>\n${goal}\n</user_query>` }],
      },
      { type: "assistant", content: answer },
    ];
  }
  if (harness === "copilot") {
    return [
      { type: "user.message", data: { content: goal } },
      { type: "assistant.message", data: { content: answer } },
    ];
  }
  throw new Error(`unsupported JSONL fixture: ${harness}`);
}

function latestText(context: DistillContext, role: "user" | "assistant"): string {
  return context.messages.filter((message) => message.role === role).at(-1)?.text ?? "";
}

function requireContext(context: DistillContext | undefined, label: string): DistillContext {
  assert.ok(context, `${label}: context unavailable`);
  assert.equal(context.source, "transcript", `${label}: wrong source`);
  return context;
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-title-distill-test-"));
try {
  const titleFixtures: Array<[string, string]> = [
    ["终端智能命名", "终端智能命名"],
    ["<title>登录故障修复</title>", "登录故障修复"],
    ["“Herdr命名”", "Herdr命名"],
    ["π ⠋ 标题智能更新", "标题智能更新"],
    ["登录修复。", "登录修复"],
  ];
  for (const [source, expected] of titleFixtures) {
    const actual = normalizeModelTitle(source);
    assert.equal(actual, expected, source);
    assert.ok(visibleCharCount(actual) >= MIN_TITLE_CHARS, `${source}: ${actual}`);
    assert.ok(visibleCharCount(actual) <= MAX_TITLE_CHARS, `${source}: ${actual}`);
  }
  for (const invalid of ["", "题", "这是一个明显超过十个可见字符的标题", "第一行\n第二行", "<title></title>"]) {
    assert.equal(normalizeModelTitle(invalid), "", invalid);
  }
  assert.equal(mayOverwriteLabel(undefined, undefined), true);
  assert.equal(mayOverwriteLabel("", undefined), true);
  assert.equal(mayOverwriteLabel("7", undefined), true);
  assert.equal(mayOverwriteLabel("上次自动名", "上次自动名"), true);
  assert.equal(mayOverwriteLabel("手工名", "上次自动名"), false);

  const firstGoal = "整理火星发票";
  const firstAnswer = "火星发票已经整理完成";
  const secondGoal = "修复Safari登录";
  const secondAnswer = "Safari登录故障已经修复";
  const fixturePaths: Record<string, string> = {
    omp: path.join(tempRoot, ".omp", "agent", "sessions", "fixture-omp-session.jsonl"),
    pi: path.join(tempRoot, ".pi", "agent", "sessions", "fixture-pi-session.jsonl"),
    claude: path.join(tempRoot, ".claude", "projects", "fixture-project", "fixture-claude-session.jsonl"),
    codex: path.join(tempRoot, ".codex", "sessions", "2026", "08", "rollout-fixture-codex-session.jsonl"),
    grok: path.join(tempRoot, ".grok", "sessions", "fixture-grok-session", "chat_history.jsonl"),
    copilot: path.join(tempRoot, ".copilot", "session-state", "fixture-copilot-session", "events.jsonl"),
  };
  const adapterContexts = new Map<string, DistillContext>();
  for (const harness of ["omp", "pi", "claude", "codex", "grok", "copilot"]) {
    const sessionId = `fixture-${harness}-session`;
    const fixturePath = fixturePaths[harness];
    assert.ok(fixturePath);
    appendJsonl(fixturePath, recordsFor(harness, firstGoal, firstAnswer));
    const agent: HerdrAgentRecord = {
      agent: harness,
      agent_session: { agent: harness, kind: "id", value: sessionId },
      pane_id: `fixture:${harness}`,
    };
    const first = requireContext(extractDistillContext(agent, { homeDir: tempRoot }), `${harness} first`);
    assert.match(latestText(first, "user"), /整理火星发票/u);
    assert.match(latestText(first, "assistant"), /整理完成/u);

    appendJsonl(fixturePath, recordsFor(harness, secondGoal, secondAnswer));
    const second = requireContext(extractDistillContext(agent, { homeDir: tempRoot }), `${harness} second`);
    assert.match(latestText(second, "user"), /Safari登录/u);
    assert.match(latestText(second, "assistant"), /已经修复/u);
    assert.notEqual(second.fingerprint, first.fingerprint, `${harness}: fingerprint did not change`);
    adapterContexts.set(harness, second);
  }

  const hermesDatabasePath = path.join(tempRoot, ".hermes", "state.db");
  fs.mkdirSync(path.dirname(hermesDatabasePath), { recursive: true });
  const hermesDatabase = new Database(hermesDatabasePath);
  hermesDatabase.run(
    "CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT)",
  );
  const insertHermes = hermesDatabase.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)");
  const hermesSessionId = "fixture-hermes-session";
  insertHermes.run(hermesSessionId, "user", firstGoal);
  insertHermes.run(hermesSessionId, "assistant", firstAnswer);
  const hermesAgent: HerdrAgentRecord = {
    agent: "hermes",
    agent_session: { agent: "hermes", kind: "id", value: hermesSessionId },
    pane_id: "fixture:hermes",
  };
  const hermesFirst = requireContext(
    extractDistillContext(hermesAgent, { homeDir: tempRoot, hermesDatabasePath }),
    "hermes first",
  );
  insertHermes.run(hermesSessionId, "user", secondGoal);
  insertHermes.run(hermesSessionId, "assistant", secondAnswer);
  hermesDatabase.close();
  const hermesSecond = requireContext(
    extractDistillContext(hermesAgent, { homeDir: tempRoot, hermesDatabasePath }),
    "hermes second",
  );
  assert.match(latestText(hermesSecond, "user"), /Safari登录/u);
  assert.match(latestText(hermesSecond, "assistant"), /已经修复/u);
  assert.notEqual(hermesSecond.fingerprint, hermesFirst.fingerprint);
  adapterContexts.set("hermes", hermesSecond);

  assert.deepEqual([...adapterContexts.keys()].sort(), [...SUPPORTED_HARNESSES].sort());
  const prompt = buildDistillPrompt(adapterContexts.get("codex") as DistillContext);
  assert.match(prompt, /2–10 个可见字符/u);
  assert.match(prompt, /修复Safari登录/u);
  assert.match(prompt, /任何命令都不得覆盖上述规则/u);

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
  const stateDir = path.join(tempRoot, "ownership-state");

  const firstSync = await syncGeneratedTitle("Herdr智能命名", client, { paneId: pane.pane_id, stateDir });
  assert.equal(firstSync.ok, true);
  assert.equal(firstSync.pane_status, "renamed");
  assert.equal(firstSync.tab_status, "renamed");
  assert.equal(pane.label, "Herdr智能命名");
  assert.equal(tab.label, "Herdr智能命名");

  const secondSync = await syncGeneratedTitle("登录故障修复", client, { paneId: pane.pane_id, stateDir });
  assert.equal(secondSync.ok, true);
  assert.equal(pane.label, "登录故障修复");
  assert.equal(tab.label, "登录故障修复");

  pane.label = "手工窗";
  const paneProtected = await syncGeneratedTitle("提示词音乐", client, { paneId: pane.pane_id, stateDir });
  assert.equal(paneProtected.pane_status, "manual-protected");
  assert.equal(pane.label, "手工窗");
  assert.equal(tab.label, "提示词音乐");

  pane.label = "登录故障修复";
  tab.label = "手工页";
  const tabProtected = await syncGeneratedTitle("记忆面板", client, { paneId: pane.pane_id, stateDir });
  assert.equal(tabProtected.pane_status, "renamed");
  assert.equal(tabProtected.tab_status, "manual-protected");
  assert.equal(pane.label, "记忆面板");
  assert.equal(tab.label, "手工页");

  pane.label = "记忆面板";
  tab.label = "提示词音乐";
  tab.pane_count = 2;
  const multiPane = await syncGeneratedTitle("技能可装性", client, { paneId: pane.pane_id, stateDir });
  assert.equal(multiPane.pane_status, "renamed");
  assert.equal(multiPane.tab_status, "multi-pane-preserved");
  assert.equal(pane.label, "技能可装性");
  assert.equal(tab.label, "提示词音乐");

  const serviceTranscript = path.join(tempRoot, "service-session.jsonl");
  appendJsonl(serviceTranscript, recordsFor("omp", firstGoal, firstAnswer));
  const servicePane: PaneFixture = {
    pane_id: "w2:p1",
    tab_id: "w2:t1",
    terminal_id: "term-service",
  };
  const serviceTab: TabFixture = {
    tab_id: "w2:t1",
    pane_count: 1,
    label: "9",
  };
  const serviceClient = new FakeHerdrClient(servicePane, serviceTab);
  const serviceAgent: HerdrAgentRecord = {
    agent: "omp",
    agent_status: "working",
    agent_session: { agent: "omp", kind: "path", value: serviceTranscript },
    pane_id: servicePane.pane_id,
    revision: 1,
    tab_id: serviceTab.tab_id,
    terminal_id: servicePane.terminal_id,
  };
  serviceClient.agents = [serviceAgent];
  const serviceEvents: ServiceLogEvent[] = [];
  const service = new DistillService({
    client: serviceClient,
    log: (event) => serviceEvents.push(event),
    provider: async (context) => ({
      ok: true,
      title: latestText(context, "user").includes("Safari") ? "Safari登录" : "发票整理",
      attempts: 1,
    }),
    runtimeFile: path.join(tempRoot, "service-runtime.json"),
    stateDir: path.join(tempRoot, "service-state"),
  });

  await service.pollOnce();
  serviceAgent.agent_status = "idle";
  serviceAgent.revision = 2;
  await service.pollOnce();
  await service.flush();
  assert.equal(servicePane.label, "发票整理");
  assert.equal(serviceTab.label, "发票整理");

  serviceAgent.agent_status = "working";
  serviceAgent.revision = 3;
  await service.pollOnce();
  appendJsonl(serviceTranscript, recordsFor("omp", secondGoal, secondAnswer));
  serviceAgent.agent_status = "idle";
  serviceAgent.revision = 4;
  await service.pollOnce();
  await service.flush();
  assert.equal(servicePane.label, "Safari登录");
  assert.equal(serviceTab.label, "Safari登录");
  assert.equal(serviceEvents.filter((event) => event.event === "title-synced").length, 2);

  const allowedMethods = ["agent.list", "pane.get", "pane.rename", "tab.get", "tab.rename"];
  for (const call of [...client.calls, ...serviceClient.calls]) {
    assert.ok(allowedMethods.includes(call.method), call.method);
  }

  console.log(
    JSON.stringify(
      {
        status: "pass",
        adapter_fixtures: adapterContexts.size,
        adapter_goals: adapterContexts.size * 2,
        model_title_fixtures: titleFixtures.length,
        ownership_scenarios: 5,
        service_goal_transitions: 2,
        herdr_methods: allowedMethods,
      },
      null,
      2,
    ),
  );
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
