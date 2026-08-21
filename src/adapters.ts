import { createHash } from "node:crypto";
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

import type { HerdrAgentRecord } from "./core.ts";

export const SUPPORTED_HARNESSES = ["omp", "pi", "claude", "codex", "grok", "copilot", "hermes"] as const;
export type SupportedHarness = (typeof SUPPORTED_HARNESSES)[number];

export type ConversationMessage = {
  role: "user" | "assistant";
  text: string;
};

export type DistillContext = {
  fingerprint: string;
  harness: string;
  messages: ConversationMessage[];
  sessionKey: string;
  source: "transcript" | "terminal-title";
  transcriptPath?: string;
};
export type AdapterOptions = {
  homeDir?: string;
  hermesDatabasePath?: string;
};


type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as JsonRecord;
}

function normalizeHarness(value: unknown): string {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "claude-code") return "claude";
  return normalized;
}

function readJsonlTail(filePath: string, maxBytes = 12_000_000): unknown[] {
  let descriptor: number | undefined;
  try {
    const size = fs.statSync(filePath).size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const buffer = Buffer.allocUnsafe(length);
    descriptor = fs.openSync(filePath, "r");
    fs.readSync(descriptor, buffer, 0, length, start);
    let text = buffer.toString("utf8");
    if (start > 0) {
      const firstNewline = text.indexOf("\n");
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
    }
    const records: unknown[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as unknown);
      } catch {
        // A concurrently appended final line is intentionally ignored until the next poll.
      }
    }
    return records;
  } catch {
    return [];
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function textFromContent(value: unknown, depth = 0): string {
  if (depth > 5) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => textFromContent(item, depth + 1))
      .filter(Boolean)
      .join("\n");
  }
  const record = asRecord(value);
  if (!record) return "";

  const type = typeof record.type === "string" ? record.type.toLowerCase() : "";
  if (type.includes("thinking") || type.includes("reasoning") || type.includes("tool")) return "";
  if (typeof record.text === "string") return record.text;
  if (typeof record.content === "string") return record.content;
  if (record.content !== undefined) return textFromContent(record.content, depth + 1);
  if (record.message !== undefined) return textFromContent(record.message, depth + 1);
  return "";
}

function cleanConversationText(value: string): string {
  let text = value
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\u0000/gu, "")
    .trim();

  const queryMatches = Array.from(text.matchAll(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/giu));
  if (queryMatches.length > 0) {
    text = queryMatches.at(-1)?.[1]?.trim() ?? text;
  } else if (text.startsWith("[IMPORTANT: User invoked")) {
    const userMarker = text.lastIndexOf("\nUser: ");
    if (userMarker >= 0) text = text.slice(userMarker + "\nUser: ".length).trim();
  }

  text = text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/giu, " ")
    .replace(/<user_info>[\s\S]*?<\/user_info>/giu, " ")
    .replace(/<system-directive>[\s\S]*?<\/system-directive>/giu, " ")
    .replace(/<recommended_plugins>[\s\S]*?<\/recommended_plugins>/giu, " ")
    .replace(/<skills_instructions>[\s\S]*?<\/skills_instructions>/giu, " ")
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/giu, " ")
    .replace(/<permissions instructions>[\s\S]*?<\/permissions instructions>/giu, " ")
    .replace(/# AGENTS\.md instructions\s*<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/giu, " ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();


  const maxChars = 6_000;
  if (text.length > maxChars) text = text.slice(text.length - maxChars);
  return text;
}

function appendMessage(messages: ConversationMessage[], role: unknown, content: unknown): void {
  if (role !== "user" && role !== "assistant") return;
  const text = cleanConversationText(textFromContent(content));
  if (!text) return;
  const previous = messages.at(-1);
  if (previous?.role === role) {
    previous.text = cleanConversationText(`${previous.text}\n${text}`);
    return;
  }
  messages.push({ role, text });
}
function isAcknowledgement(text: string): boolean {
  return /^(?:可以|好|好的|行|开始|继续|同意|确认|ok|okay|yes|go|do it)[。.!！ ]*$/iu.test(text.trim());
}


function isCompletionAssistant(record: JsonRecord, harness: string): boolean {
  if (harness !== "omp" && harness !== "pi") return true;
  const stopReason = typeof record.stopReason === "string" ? record.stopReason : "";
  if (stopReason === "toolUse") return false;
  return stopReason !== "" || record.usage !== undefined;
}


function parseTranscriptRecords(records: unknown[], harness: string): ConversationMessage[] {
  const messages: ConversationMessage[] = [];
  for (const value of records) {
    const record = asRecord(value);
    if (!record || record.synthetic_reason !== undefined) continue;

    if (harness === "copilot") {
      const data = asRecord(record.data);
      if (record.type === "user.message") appendMessage(messages, "user", data?.content);
      if (record.type === "assistant.message") appendMessage(messages, "assistant", data?.content);
      continue;
    }

    if (record.type === "response_item") {
      const payload = asRecord(record.payload);
      const phase = typeof payload?.phase === "string" ? payload.phase : "";
      if (
        payload?.type === "message" &&
        (payload.role === "user" || (payload.role === "assistant" && phase !== "commentary"))
      ) {
        appendMessage(messages, payload.role, payload.content);
      }
      continue;
    }
    const nested = asRecord(record.message);
    if (
      record.type === "message" &&
      nested &&
      nested.role !== "toolResult" &&
      (nested.role !== "assistant" || isCompletionAssistant(nested, harness))
    ) {
      appendMessage(messages, nested.role, nested.content);
      continue;
    }

    if (
      (record.type === "user" || record.type === "assistant") &&
      (record.content !== undefined || nested?.content !== undefined)
    ) {
      appendMessage(messages, nested?.role || record.type, nested?.content ?? record.content);
      continue;
    }

  }

  let lastUser = messages.findLastIndex((message) => message.role === "user");
  const lastAssistant = messages.findLastIndex((message) => message.role === "assistant");
  if (lastUser < 0 || lastAssistant < 0) return [];
  if (lastAssistant <= lastUser) {
    lastUser = messages.findLastIndex((message, index) => index < lastAssistant && message.role === "user");
    if (lastUser < 0) return [];
  }
  if (isAcknowledgement(messages[lastUser]?.text ?? "")) {
    for (let index = lastUser - 1; index >= 0; index -= 1) {
      if (messages[index]?.role !== "user" || isAcknowledgement(messages[index]?.text ?? "")) continue;
      messages[lastUser] = {
        role: "user",
        text: `${messages[index]?.text}\n\n用户随后确认：${messages[lastUser]?.text}`,
      };
      break;
    }
  }
  return messages.slice(Math.max(0, lastUser - 4), lastAssistant + 1).slice(-6);
}

function findNewestMatchingFile(
  root: string,
  sessionId: string,
  accept: (filePath: string) => boolean,
): string | undefined {
  if (!fs.existsSync(root)) return undefined;
  const stack = [root];
  let visited = 0;
  let newest: { path: string; modified: number } | undefined;

  while (stack.length > 0 && visited < 20_000) {
    const directory = stack.pop();
    if (!directory) break;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited += 1;
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }
      if (!entry.isFile() || (!entry.name.includes(sessionId) && !entryPath.includes(sessionId)) || !accept(entryPath)) {
        continue;
      }
      try {
        const modified = fs.statSync(entryPath).mtimeMs;
        if (!newest || modified > newest.modified) newest = { path: entryPath, modified };
      } catch {
        // File disappeared between directory read and stat.
      }
    }
  }
  return newest?.path;
}

export function readHermesConversation(databasePath: string, sessionId: string): ConversationMessage[] {
  if (!fs.existsSync(databasePath)) return [];
  let database: Database | undefined;
  try {
    database = new Database(databasePath, { readonly: true, strict: true });
    const rows = database
      .query(
        "SELECT role, content FROM messages WHERE session_id = ? AND role IN ('user', 'assistant') ORDER BY id DESC LIMIT 80",
      )
      .all(sessionId) as Array<{ role: string; content: string | null }>;
    const records = rows.reverse().map((row) => ({
      type: row.role,
      content: row.content || "",
    }));
    return parseTranscriptRecords(records, "hermes");
  } catch {
    return [];
  } finally {
    database?.close();
  }
}

function resolveTranscriptPath(agent: HerdrAgentRecord, harness: string, home: string): string | undefined {
  const session = agent.agent_session;
  const value = session?.value?.trim();
  if (value && fs.existsSync(value)) return value;
  if (!value) return undefined;
  if (harness === "omp") {
    return findNewestMatchingFile(path.join(home, ".omp", "agent", "sessions"), value, (filePath) =>
      filePath.endsWith(".jsonl"),
    );
  }
  if (harness === "pi") {
    return findNewestMatchingFile(path.join(home, ".pi", "agent", "sessions"), value, (filePath) =>
      filePath.endsWith(".jsonl"),
    );
  }
  if (harness === "claude") {
    return findNewestMatchingFile(path.join(home, ".claude", "projects"), value, (filePath) =>
      filePath.endsWith(".jsonl"),
    );
  }
  if (harness === "codex") {
    return findNewestMatchingFile(path.join(home, ".codex", "sessions"), value, (filePath) => filePath.endsWith(".jsonl"));
  }
  if (harness === "grok") {
    return findNewestMatchingFile(
      path.join(home, ".grok", "sessions"),
      value,
      (filePath) => path.basename(filePath) === "chat_history.jsonl",
    );
  }
  if (harness === "copilot") {
    const direct = path.join(home, ".copilot", "session-state", value, "events.jsonl");
    if (fs.existsSync(direct)) return direct;
  }
  if (harness === "hermes") {
    return findNewestMatchingFile(path.join(home, ".hermes", "sessions"), value, (filePath) =>
      filePath.endsWith(".jsonl"),
    );
  }
  return undefined;
}

function cleanTerminalTitle(value: unknown, harness: string): string {
  const title = String(value ?? "")
    .normalize("NFKC")
    .replace(/^\s*π\s*(?:[>›❯-]|[⠋-⠿]|[✓✔])?\s*/u, "")
    .replace(new RegExp(`\\s+-\\s+${harness}\\s*$`, "iu"), "")
    .trim();
  if (!title || /^(?:aloha greeting message|shell|terminal|new session)$/iu.test(title)) return "";
  return title;
}

function contextFingerprint(harness: string, sessionKey: string, messages: ConversationMessage[]): string {
  return createHash("sha256").update(JSON.stringify({ harness, sessionKey, messages })).digest("hex");
}

export function extractDistillContext(
  agent: HerdrAgentRecord,
  options: AdapterOptions = {},
): DistillContext | undefined {
  const harness = normalizeHarness(agent.agent_session?.agent || agent.agent);
  if (!harness) return undefined;
  const sessionValue = agent.agent_session?.value?.trim() || "unknown";
  const sessionKey = `${harness}:${agent.agent_session?.kind || "unknown"}:${sessionValue}`;
  const home = options.homeDir ?? homedir();

  if (harness === "hermes" && sessionValue !== "unknown" && !fs.existsSync(sessionValue)) {
    const databasePath = options.hermesDatabasePath ?? path.join(home, ".hermes", "state.db");
    const messages = readHermesConversation(databasePath, sessionValue);
    if (messages.length > 0) {
      return {
        fingerprint: contextFingerprint(harness, sessionKey, messages),
        harness,
        messages,
        sessionKey,
        source: "transcript",
        transcriptPath: databasePath,
      };
    }
  }

  const transcriptPath = resolveTranscriptPath(agent, harness, home);
  if (transcriptPath) {
    const messages = parseTranscriptRecords(readJsonlTail(transcriptPath), harness);
    if (messages.length > 0) {
      return {
        fingerprint: contextFingerprint(harness, sessionKey, messages),
        harness,
        messages,
        sessionKey,
        source: "transcript",
        transcriptPath,
      };
    }
  }

  const terminalTitle = cleanTerminalTitle(agent.terminal_title, harness);
  if (!terminalTitle) return undefined;
  const messages: ConversationMessage[] = [
    { role: "user", text: `当前终端目标：${terminalTitle}` },
    { role: "assistant", text: terminalTitle },
  ];
  return {
    fingerprint: contextFingerprint(harness, sessionKey, messages),
    harness,
    messages,
    sessionKey,
    source: "terminal-title",
  };
}
