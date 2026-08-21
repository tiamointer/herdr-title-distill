import fs from "node:fs";
import path from "node:path";

import { extractDistillContext } from "./adapters.ts";
import {
  DEFAULT_STATE_DIR,
  listHerdrAgents,
  normalizeModelTitle,
  syncGeneratedTitle,
  type HerdrAgentRecord,
  type HerdrClient,
} from "./core.ts";
import { generateTitleWithOmp, type TitleProvider } from "./model.ts";

type AgentSnapshot = {
  revision?: number;
  sessionKey: string;
  status: string;
};

type ProcessedPane = {
  fingerprint: string;
  session_key: string;
  title: string;
  updated_at: string;
};

type ServiceState = {
  version: 1;
  panes: Record<string, ProcessedPane>;
};

export type ServiceLogEvent = {
  event: string;
  harness?: string;
  pane_id?: string;
  reason?: string;
  session?: string;
  source?: string;
  title?: string;
};

export type DistillServiceOptions = {
  client: HerdrClient;
  log?: (event: ServiceLogEvent) => void;
  pollIntervalMs?: number;
  provider?: TitleProvider;
  runtimeFile?: string;
  stateDir?: string;
};

function readServiceState(filePath: string): ServiceState {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<ServiceState>;
    if (parsed.version === 1 && parsed.panes && typeof parsed.panes === "object") {
      return { version: 1, panes: parsed.panes };
    }
  } catch {
    // Missing or malformed runtime state starts empty; ownership lives in separate files.
  }
  return { version: 1, panes: {} };
}

function writeServiceState(filePath: string, state: ServiceState): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, filePath);
}

function sessionKey(agent: HerdrAgentRecord): string {
  const session = agent.agent_session;
  return `${agent.agent || "unknown"}:${session?.kind || "unknown"}:${session?.value || "unknown"}`;
}

function isActiveStatus(status: string): boolean {
  return status === "working" || status === "blocked";
}

function isTerminalStatus(status: string): boolean {
  return status === "idle" || status === "done";
}

export class DistillService {
  readonly #client: HerdrClient;
  readonly #log: (event: ServiceLogEvent) => void;
  readonly #pollIntervalMs: number;
  readonly #provider: TitleProvider;
  readonly #runtimeFile: string;
  readonly #stateDir: string;
  readonly #processed: ServiceState;
  readonly #snapshots = new Map<string, AgentSnapshot>();
  readonly #pending = new Map<string, HerdrAgentRecord>();
  readonly #running = new Set<string>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #primed = false;
  #polling = false;

  constructor(options: DistillServiceOptions) {
    this.#client = options.client;
    this.#log = options.log ?? (() => {});
    this.#pollIntervalMs = Math.max(250, Math.min(options.pollIntervalMs ?? 750, 5_000));
    this.#provider = options.provider ?? generateTitleWithOmp;
    this.#stateDir = options.stateDir ?? DEFAULT_STATE_DIR;
    this.#runtimeFile = options.runtimeFile ?? path.join(path.dirname(this.#stateDir), "service.json");
    this.#processed = readServiceState(this.#runtimeFile);
  }

  async pollOnce(): Promise<void> {
    if (this.#polling) return;
    this.#polling = true;
    try {
      const agents = await listHerdrAgents(this.#client);
      if (agents.length === 0) return;

      const seen = new Set<string>();
      for (const agent of agents) {
        seen.add(agent.pane_id);
        const status = agent.agent_status || "unknown";
        const next: AgentSnapshot = {
          revision: agent.revision,
          sessionKey: sessionKey(agent),
          status,
        };
        const previous = this.#snapshots.get(agent.pane_id);
        this.#snapshots.set(agent.pane_id, next);
        if (!this.#primed) continue;

        const newPane = previous === undefined;
        const completedTransition = previous !== undefined && isActiveStatus(previous.status) && isTerminalStatus(status);
        const changedSession = previous !== undefined && previous.sessionKey !== next.sessionKey && isTerminalStatus(status);
        const changedRevision =
          previous !== undefined &&
          previous.revision !== next.revision &&
          isTerminalStatus(previous.status) &&
          isTerminalStatus(status);
        if (newPane || completedTransition || changedSession || changedRevision) this.#queue(agent);
      }

      for (const paneId of this.#snapshots.keys()) {
        if (!seen.has(paneId)) this.#snapshots.delete(paneId);
      }
      this.#primed = true;
    } finally {
      this.#polling = false;
    }
  }

  start(): void {
    if (this.#timer !== undefined) return;
    void this.pollOnce();
    this.#timer = setInterval(() => void this.pollOnce(), this.#pollIntervalMs);
    this.#timer.unref?.();
    this.#log({ event: "service-started" });
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#log({ event: "service-stopped" });
  }

  async flush(): Promise<void> {
    while (this.#running.size > 0 || this.#pending.size > 0) {
      await Bun.sleep(25);
    }
  }

  #queue(agent: HerdrAgentRecord): void {
    if (!isTerminalStatus(agent.agent_status || "unknown")) return;
    this.#pending.set(agent.pane_id, agent);
    if (!this.#running.has(agent.pane_id)) void this.#drain(agent.pane_id);
  }

  async #drain(paneId: string): Promise<void> {
    this.#running.add(paneId);
    try {
      while (this.#pending.has(paneId)) {
        const agent = this.#pending.get(paneId);
        this.#pending.delete(paneId);
        if (agent) await this.#process(agent);
      }
    } finally {
      this.#running.delete(paneId);
    }
  }

  async #process(agent: HerdrAgentRecord): Promise<void> {
    const context = extractDistillContext(agent);
    if (!context) {
      this.#log({ event: "context-unavailable", pane_id: agent.pane_id, harness: agent.agent });
      return;
    }
    const previous = this.#processed.panes[agent.pane_id];
    if (previous?.fingerprint === context.fingerprint && previous.session_key === context.sessionKey) return;

    const generated = await this.#provider(context);
    const title = normalizeModelTitle(generated.title);
    if (!generated.ok || !title) {
      this.#log({
        event: "title-generation-failed",
        pane_id: agent.pane_id,
        harness: context.harness,
        reason: generated.reason || "invalid-title",
        source: context.source,
      });
      return;
    }

    const currentAgents = await listHerdrAgents(this.#client);
    const current = currentAgents.find((candidate) => candidate.pane_id === agent.pane_id);
    const currentContext = current ? extractDistillContext(current) : undefined;
    if (
      !current ||
      !isTerminalStatus(current.agent_status || "unknown") ||
      currentContext?.fingerprint !== context.fingerprint ||
      currentContext.sessionKey !== context.sessionKey
    ) {
      if (current && isTerminalStatus(current.agent_status || "unknown")) this.#queue(current);
      this.#log({ event: "stale-generation-discarded", pane_id: agent.pane_id, harness: context.harness });
      return;
    }

    const result = await syncGeneratedTitle(title, this.#client, {
      paneId: agent.pane_id,
      stateDir: this.#stateDir,
    });
    if (!result.ok) {
      this.#log({
        event: "title-sync-failed",
        pane_id: agent.pane_id,
        harness: context.harness,
        reason: result.reason,
        title,
      });
      return;
    }

    this.#processed.panes[agent.pane_id] = {
      fingerprint: context.fingerprint,
      session_key: context.sessionKey,
      title,
      updated_at: new Date().toISOString(),
    };
    writeServiceState(this.#runtimeFile, this.#processed);
    this.#log({
      event: "title-synced",
      pane_id: agent.pane_id,
      harness: context.harness,
      source: context.source,
      title,
    });
  }
}
