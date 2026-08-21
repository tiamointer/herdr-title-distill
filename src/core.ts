import fs from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import path from "node:path";

export const SERVICE_NAME = "herdr-title-distill";
export const LEGACY_SERVICE_NAME = "omp-herdr-title-sync";
export const MIN_TITLE_CHARS = 2;
export const MAX_TITLE_CHARS = 10;
export const DEFAULT_STATE_DIR = path.join(homedir(), ".config", SERVICE_NAME, "state");
export const DEFAULT_SOCKET_PATH = path.join(homedir(), ".config", "herdr", "herdr.sock");

const segmenter =
  typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter("zh-Hans", { granularity: "grapheme" })
    : null;

export function splitVisibleChars(value: string): string[] {
  if (segmenter) return Array.from(segmenter.segment(value), (part) => part.segment);
  return Array.from(value);
}

export function visibleCharCount(value: string): number {
  return splitVisibleChars(value).length;
}

export function normalizeModelTitle(value: unknown): string {
  const source = String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/gu, "")
    .trim();
  if (!source || source.split(/\r?\n/u).filter((line) => line.trim()).length !== 1) return "";

  const title = source
    .replace(/^\s*<title>\s*/iu, "")
    .replace(/\s*<\/title>\s*$/iu, "")
    .replace(/^\s*π\s*(?:[>›❯]|[⠋-⠿]|[✓✔])?\s*/u, "")
    .replace(/^["'“”‘’`]+|["'“”‘’`]+$/gu, "")
    .replace(/[.!?。！？]+$/u, "")
    .replace(/\s+/gu, " ")
    .trim();
  const length = visibleCharCount(title);
  if (length < MIN_TITLE_CHARS || length > MAX_TITLE_CHARS || /[<>\r\n]/u.test(title)) return "";
  return title;
}

export function mayOverwriteLabel(current: unknown, previousAuto: unknown): boolean {
  const label = typeof current === "string" ? current.trim() : "";
  if (!label || /^\d+$/u.test(label)) return true;
  return typeof previousAuto === "string" && label === previousAuto;
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as JsonRecord;
}

function readJsonFile(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function safeFilePart(value: unknown): string {
  return String(value ?? "unknown").replace(/[^A-Za-z0-9._-]/g, "_") || "unknown";
}

export function statePathFor(stateDir: string, terminalId: string): string {
  return path.join(stateDir, `${safeFilePart(terminalId)}.json`);
}

export type LabelOwnership = {
  original_label?: string | null;
  last_auto_label?: string;
  pane_id?: string;
  updated_at?: string;
};

export type RuntimeState = {
  version: 1;
  terminal_id: string;
  pane: LabelOwnership;
  tabs: Record<string, LabelOwnership>;
};

function parseOwnership(value: unknown): LabelOwnership {
  const record = asRecord(value);
  if (!record) return {};
  const ownership: LabelOwnership = {};
  if (
    Object.prototype.hasOwnProperty.call(record, "original_label") &&
    (typeof record.original_label === "string" || record.original_label === null)
  ) {
    ownership.original_label = record.original_label;
  }
  if (typeof record.last_auto_label === "string") ownership.last_auto_label = record.last_auto_label;
  if (typeof record.pane_id === "string") ownership.pane_id = record.pane_id;
  if (typeof record.updated_at === "string") ownership.updated_at = record.updated_at;
  return ownership;
}

export function loadRuntimeState(filePath: string, terminalId: string): RuntimeState {
  const parsed = asRecord(readJsonFile(filePath));
  const tabs: Record<string, LabelOwnership> = {};
  const rawTabs = asRecord(parsed?.tabs);
  if (rawTabs) {
    for (const [tabId, value] of Object.entries(rawTabs)) tabs[tabId] = parseOwnership(value);
  }
  return {
    version: 1,
    terminal_id: terminalId,
    pane: parseOwnership(parsed?.pane),
    tabs,
  };
}

export function saveRuntimeState(filePath: string, state: RuntimeState): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, filePath);
}

export type HerdrPane = {
  pane_id: string;
  tab_id: string;
  terminal_id?: string;
  label?: string;
};

export type HerdrTab = {
  tab_id: string;
  pane_count: number;
  label?: string;
};

export type AgentSessionRef = {
  agent?: string;
  kind?: string;
  source?: string;
  value?: string;
};

export type HerdrAgentRecord = {
  agent?: string;
  agent_status?: string;
  agent_session?: AgentSessionRef;
  cwd?: string;
  pane_id: string;
  revision?: number;
  tab_id?: string;
  terminal_id?: string;
  terminal_title?: string;
  workspace_id?: string;
};

function paneFromResponse(response: unknown): HerdrPane | undefined {
  const root = asRecord(response);
  const pane = asRecord(asRecord(root?.result)?.pane);
  if (!root || root.error !== undefined || !pane) return undefined;
  if (typeof pane.pane_id !== "string" || typeof pane.tab_id !== "string") return undefined;
  return {
    pane_id: pane.pane_id,
    tab_id: pane.tab_id,
    ...(typeof pane.terminal_id === "string" ? { terminal_id: pane.terminal_id } : {}),
    ...(typeof pane.label === "string" ? { label: pane.label } : {}),
  };
}

function tabFromResponse(response: unknown): HerdrTab | undefined {
  const root = asRecord(response);
  const tab = asRecord(asRecord(root?.result)?.tab);
  if (!root || root.error !== undefined || !tab || typeof tab.tab_id !== "string") return undefined;
  return {
    tab_id: tab.tab_id,
    pane_count: Number(tab.pane_count),
    ...(typeof tab.label === "string" ? { label: tab.label } : {}),
  };
}

function responseSucceeded(response: unknown): boolean {
  const root = asRecord(response);
  return root !== undefined && root.error === undefined && Object.prototype.hasOwnProperty.call(root, "result");
}

export type HerdrClient = {
  call(method: string, params: Record<string, unknown>): Promise<unknown>;
};

export function createHerdrSocketClient(socketPath: string, timeoutMs = 1200): HerdrClient {
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;
  return {
    call(method: string, params: Record<string, unknown>): Promise<unknown> {
      const { promise, resolve } = Promise.withResolvers<unknown>();
      const request = {
        id: `${SERVICE_NAME}:${process.pid}:${Date.now()}:${Math.random().toString(16).slice(2)}`,
        method,
        params,
      };
      let settled = false;
      let buffer = "";
      const socket = net.createConnection(endpoint);
      const timer = setTimeout(() => finish(null), timeoutMs);
      timer.unref?.();

      function finish(value: unknown): void {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(value);
      }

      socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        try {
          finish(JSON.parse(buffer.slice(0, newline)) as unknown);
        } catch {
          finish(null);
        }
      });
      socket.on("error", () => finish(null));
      socket.on("end", () => finish(null));
      return promise;
    },
  };
}

export async function listHerdrAgents(client: HerdrClient): Promise<HerdrAgentRecord[]> {
  const response = asRecord(await client.call("agent.list", {}));
  const agents = asRecord(response?.result)?.agents;
  if (!Array.isArray(agents)) return [];

  const records: HerdrAgentRecord[] = [];
  for (const value of agents) {
    const record = asRecord(value);
    if (!record || typeof record.pane_id !== "string") continue;
    const rawSession = asRecord(record.agent_session);
    records.push({
      pane_id: record.pane_id,
      ...(typeof record.agent === "string" ? { agent: record.agent } : {}),
      ...(typeof record.agent_status === "string" ? { agent_status: record.agent_status } : {}),
      ...(typeof record.cwd === "string" ? { cwd: record.cwd } : {}),
      ...(typeof record.revision === "number" ? { revision: record.revision } : {}),
      ...(typeof record.tab_id === "string" ? { tab_id: record.tab_id } : {}),
      ...(typeof record.terminal_id === "string" ? { terminal_id: record.terminal_id } : {}),
      ...(typeof record.terminal_title === "string" ? { terminal_title: record.terminal_title } : {}),
      ...(typeof record.workspace_id === "string" ? { workspace_id: record.workspace_id } : {}),
      ...(rawSession
        ? {
            agent_session: {
              ...(typeof rawSession.agent === "string" ? { agent: rawSession.agent } : {}),
              ...(typeof rawSession.kind === "string" ? { kind: rawSession.kind } : {}),
              ...(typeof rawSession.source === "string" ? { source: rawSession.source } : {}),
              ...(typeof rawSession.value === "string" ? { value: rawSession.value } : {}),
            },
          }
        : {}),
    });
  }
  return records;
}

export type SyncOptions = {
  paneId: string;
  stateDir?: string;
};

export type SyncResult = {
  ok: boolean;
  reason?: string;
  title?: string;
  visible_chars?: number;
  pane_id?: string;
  tab_id?: string;
  pane_status?: string;
  tab_status?: string;
};

export async function syncGeneratedTitle(
  generatedTitle: unknown,
  client: HerdrClient,
  options: SyncOptions,
): Promise<SyncResult> {
  const title = normalizeModelTitle(generatedTitle);
  if (!title) return { ok: false, reason: "invalid-title" };

  const pane = paneFromResponse(await client.call("pane.get", { pane_id: options.paneId }));
  if (!pane) return { ok: false, reason: "pane-unavailable", title };

  const terminalId = pane.terminal_id ?? pane.pane_id;
  const stateDir = options.stateDir ?? DEFAULT_STATE_DIR;
  const filePath = statePathFor(stateDir, terminalId);
  const state = loadRuntimeState(filePath, terminalId);
  const paneOwnership = state.pane;
  let paneStatus = "manual-protected";
  let stateChanged = false;

  if (mayOverwriteLabel(pane.label, paneOwnership.last_auto_label)) {
    if (!Object.prototype.hasOwnProperty.call(paneOwnership, "original_label")) {
      paneOwnership.original_label = pane.label || null;
    }
    if (pane.label !== title) {
      const renameResponse = await client.call("pane.rename", { pane_id: pane.pane_id, label: title });
      if (!responseSucceeded(renameResponse)) return { ok: false, reason: "pane-rename-failed", title };
      paneStatus = "renamed";
    } else {
      paneStatus = "unchanged";
    }
    paneOwnership.pane_id = pane.pane_id;
    paneOwnership.last_auto_label = title;
    paneOwnership.updated_at = new Date().toISOString();
    stateChanged = true;
  }

  let tabStatus = "unavailable";
  const tab = tabFromResponse(await client.call("tab.get", { tab_id: pane.tab_id }));
  if (tab) {
    if (tab.pane_count !== 1) {
      tabStatus = "multi-pane-preserved";
    } else {
      const tabOwnership = state.tabs[tab.tab_id] ?? {};
      if (mayOverwriteLabel(tab.label, tabOwnership.last_auto_label)) {
        if (!Object.prototype.hasOwnProperty.call(tabOwnership, "original_label")) {
          tabOwnership.original_label = tab.label || null;
        }
        if (tab.label !== title) {
          const renameResponse = await client.call("tab.rename", { tab_id: tab.tab_id, label: title });
          if (!responseSucceeded(renameResponse)) {
            return { ok: false, reason: "tab-rename-failed", title, pane_status: paneStatus };
          }
          tabStatus = "renamed";
        } else {
          tabStatus = "unchanged";
        }
        tabOwnership.last_auto_label = title;
        tabOwnership.updated_at = new Date().toISOString();
        state.tabs[tab.tab_id] = tabOwnership;
        stateChanged = true;
      } else {
        tabStatus = "manual-protected";
      }
    }
  }

  if (stateChanged) saveRuntimeState(filePath, state);
  return {
    ok: true,
    title,
    visible_chars: visibleCharCount(title),
    pane_id: pane.pane_id,
    tab_id: pane.tab_id,
    pane_status: paneStatus,
    tab_status: tabStatus,
  };
}
