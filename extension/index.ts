import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const SOURCE = "omp-herdr-title-sync";
export const PREFERRED_TITLE_CHARS = 5;
export const MAX_TITLE_CHARS = 10;

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_ALIAS_PATH = path.join(SKILL_ROOT, "config", "aliases.json");
const DEFAULT_STATE_DIR = path.join(SKILL_ROOT, "state");

const segmenter =
  typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter("zh-Hans", { granularity: "grapheme" })
    : null;

export function splitVisibleChars(value: string): string[] {
  if (segmenter) {
    return Array.from(segmenter.segment(value), (part) => part.segment);
  }
  return Array.from(value);
}

export function visibleCharCount(value: string): number {
  return splitVisibleChars(value).length;
}

export function middleEllipsis(value: string, limit = MAX_TITLE_CHARS): string {
  const chars = splitVisibleChars(value);
  if (chars.length <= limit) return value;
  if (limit <= 1) return "…";
  const head = Math.ceil((limit - 1) / 2);
  const tail = limit - 1 - head;
  return `${chars.slice(0, head).join("")}…${chars.slice(-tail).join("")}`;
}

function normalizeSourceTitle(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/^\s*π\s*(?:[>›❯]|[⠋-⠿]|[✓✔])?\s*/u, "")
    .replace(/^[\s>*›❯—–:：-]+/u, "")
    .replace(/\s+/g, " ")
    .trim();
}

const PHRASE_RULES: Array<[RegExp, string]> = [
  [/是否值得安装/gu, "可装性"],
  [/值不值得安装/gu, "可装性"],
  [/值得安装/gu, "可装性"],
  [/自动(?:重)?命名/gu, "自动 命名"],
  [/重命名/gu, "命名"],
  [/标题同步器/gu, "标题 同步"],
  [/自动标题/gu, "标题"],
  [/\btitle[\s-]*sync(?:ing)?\b/giu, "标题 同步"],
  [/\bauto[\s-]*titles?\b/giu, "标题"],
  [/\brefresh[\s-]*tokens?\b/giu, "刷新令牌"],
  [/\buser[\s-]*authentication\b/giu, "用户认证"],
  [/\bwindow[\s-]*titles?\b/giu, "窗口标题"],
  [/\bprompts?\b/giu, "提示词"],
  [/\btitles?\b/giu, "标题"],
  [/\bpriorit(?:y|ies)\b/giu, "优先级"],
  [/\bresidue\b|\bleftovers?\b/giu, "残留"],
  [/\bbugs?\b|\bissues?\b|\bproblems?\b/giu, "故障"],
  [/\bconfigs?\b|\bconfiguration\b/giu, "配置"],
  [/\bauth(?:entication)?\b/giu, "认证"],
  [/\blatency\b/giu, "延迟"],
  [/\bregressions?\b/giu, "回归"],
  [/\bdatabases?\b/giu, "数据库"],
  [/\bmigrations?\b/giu, "迁移"],
  [/\bdeploy(?:ment|ing|ed)?\b/giu, "部署"],
  [/\bbuild(?:ing|s)?\b/giu, "构建"],
  [/\btests?|testing\b/giu, "测试"],
  [/\bdocuments?|documentation|docs\b/giu, "文档"],
  [/\bbookmarks?\b/giu, "书签"],
  [/\bmemory\b/giu, "记忆"],
  [/\bpanels?\b/giu, "面板"],
  [/\bvertical\b/giu, "竖版"],
  [/\babstract\b/giu, "抽象"],
  [/\bmusic\b/giu, "音乐"],
  [/\bskills?\b/giu, "技能"],
  [/\bplugins?\b/giu, "插件"],
  [/\bhooks?\b/giu, "Hook"],
  [/\bpanes?\b/giu, "Pane"],
  [/\btabs?\b/giu, "Tab"],
  [/\bprojects?\b/giu, "项目"],
  [/\btools?\b/giu, "工具"],
  [/\bversions?\b/giu, "版本"],
  [/\bsynchroni[sz](?:e|ed|ing|ation)\b|\bsync(?:ed|ing)?\b/giu, "同步"],
  [/\bfix(?:ed|ing)?\b|\brepair(?:ed|ing)?\b/giu, "修复"],
  [/\bremove(?:d|s|ing)?\b|\bclean(?:ed|ing|up)?\b/giu, "清理"],
  [/\binstall(?:ed|ing|ation)?\b/giu, "安装"],
  [/\bverif(?:y|ied|ying|ication)\b/giu, "验证"],
  [/\bcompare(?:d|s|ing)?\b|\bcomparison\b/giu, "对比"],
  [/\bupdate(?:d|s|ing)?\b/giu, "更新"],
  [/\bevaluat(?:e|ed|es|ing|ion)\b|\bassess(?:ed|es|ing|ment)?\b/giu, "评估"],
  [/\binvestigat(?:e|ed|es|ing|ion)\b/giu, "分析"],
  [/\bimplement(?:ed|s|ing|ation)?\b/giu, "实现"],
  [/\bdesign(?:ed|s|ing)?\b/giu, "设计"],
  [/\bgenerat(?:e|ed|es|ing|ion)\b|\bcreat(?:e|ed|es|ing|ion)\b/giu, "生成"],
  [/\badjust(?:ed|s|ing|ment)?\b/giu, "调整"],
  [/\boptimi[sz](?:e|ed|es|ing|ation)\b|\bimprov(?:e|ed|es|ing|ement)\b/giu, "优化"],
];

const SIGNIFICANT_ACTIONS: Record<string, true> = {
  同步: true,
  修复: true,
  清理: true,
  安装: true,
  验证: true,
  测试: true,
  对比: true,
  更新: true,
  迁移: true,
  部署: true,
  构建: true,
  命名: true,
};

const GENERIC_ACTIONS: Record<string, true> = {
  评估: true,
  实现: true,
  设计: true,
  生成: true,
  创建: true,
  制作: true,
  调整: true,
  优化: true,
  分析: true,
  检查: true,
  讨论: true,
};

const CORE_TERMS: Record<string, true> = {
  标题: true,
  窗口标题: true,
  优先级: true,
  提示词: true,
  音乐: true,
  残留: true,
  故障: true,
  配置: true,
  认证: true,
  刷新令牌: true,
  延迟: true,
  回归: true,
  数据库: true,
  文档: true,
  书签: true,
  记忆: true,
  面板: true,
  可装性: true,
  无模型: true,
};

const GENERIC_OBJECTS: Record<string, true> = {
  技能: true,
  插件: true,
  项目: true,
  工具: true,
  版本: true,
  任务: true,
  功能: true,
  同步器: true,
  Hook: true,
  Pane: true,
  Tab: true,
};

const LOW_DESCRIPTORS: Record<string, true> = {
  竖版: true,
  抽象: true,
  自动: true,
  本地: true,
  具体: true,
  新的: true,
  新: true,
};

const FILLER_TERMS: Record<string, true> = {
  帮我: true,
  请: true,
  一下: true,
  这个: true,
  那个: true,
  一个: true,
  做个: true,
  做一个: true,
  最适合: true,
  我的: true,
  我们: true,
  需要: true,
  想要: true,
  是否: true,
  值得: true,
  的: true,
  并: true,
  和: true,
  与: true,
  及: true,
  到: true,
  为: true,
  把: true,
  将: true,
  来: true,
  给: true,
  and: true,
  or: true,
  to: true,
  for: true,
  with: true,
  from: true,
  of: true,
  the: true,
  a: true,
  an: true,
  on: true,
  in: true,
  into: true,
  vs: true,
};

const CHINESE_VOCABULARY = Object.keys({
  ...CORE_TERMS,
  ...GENERIC_OBJECTS,
  ...LOW_DESCRIPTORS,
  ...SIGNIFICANT_ACTIONS,
  ...GENERIC_ACTIONS,
  ...FILLER_TERMS,
})
  .filter((term) => /\p{Script=Han}/u.test(term))
  .sort((left, right) => visibleCharCount(right) - visibleCharCount(left));
const CHINESE_VOCABULARY_PATTERN = new RegExp(
  `(${CHINESE_VOCABULARY.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
  "gu",
);

function applyPhraseRules(value: string): string {
  let result = value;
  for (const [pattern, replacement] of PHRASE_RULES) {
    result = result.replace(pattern, ` ${replacement} `);
  }
  result = result.replace(CHINESE_VOCABULARY_PATTERN, " $1 ");
  return result.replace(/[→←↔|/\\,:：;；()（）[\]{}<>《》「」『』“”"'`~!?！？+*=—–_-]+/gu, " ");
}

function isAsciiToken(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+._-]*$/u.test(value);
}

function isProperToken(value: string): boolean {
  if (!isAsciiToken(value)) return false;
  return /[A-Z0-9]/u.test(value) || value.length <= 5;
}

type RankedTerm = {
  text: string;
  index: number;
  score: number;
  group: number;
  kind: "proper" | "core" | "object" | "other" | "action" | "descriptor";
};

function extractRankedTerms(value: string): RankedTerm[] {
  const prepared = applyPhraseRules(value);
  const rawTokens = prepared.match(/[A-Za-z][A-Za-z0-9+._-]*|[\p{Script=Han}]+|\d+/gu) ?? [];
  const seen = new Set<string>();
  const terms: RankedTerm[] = [];
  let properCount = 0;

  for (let index = 0; index < rawTokens.length; index += 1) {
    const token = rawTokens[index].trim();
    const key = isAsciiToken(token) ? token.toLocaleLowerCase("en-US") : token;
    if (!token || FILLER_TERMS[key] === true || seen.has(key)) continue;
    seen.add(key);

    if (SIGNIFICANT_ACTIONS[token] === true) {
      terms.push({ text: token, index, score: 70, group: 3, kind: "action" });
      continue;
    }
    if (GENERIC_ACTIONS[token] === true) {
      terms.push({ text: token, index, score: 0, group: 3, kind: "action" });
      continue;
    }
    if (CORE_TERMS[token] === true) {
      terms.push({ text: token, index, score: token === "无模型" ? 55 : 100, group: 2, kind: "core" });
      continue;
    }
    if (GENERIC_OBJECTS[token] === true) {
      terms.push({ text: token, index, score: 35, group: 1, kind: "object" });
      continue;
    }
    if (LOW_DESCRIPTORS[token] === true) {
      terms.push({ text: token, index, score: 15, group: 2, kind: "descriptor" });
      continue;
    }
    if (isProperToken(token)) {
      terms.push({
        text: token,
        index,
        score: properCount === 0 ? 90 : 60,
        group: 0,
        kind: "proper",
      });
      properCount += 1;
      continue;
    }
    terms.push({ text: token, index, score: isAsciiToken(token) ? 45 : 55, group: 2, kind: "other" });
  }

  const hasCore = terms.some((term) => term.kind === "core");
  const hasProper = terms.some((term) => term.kind === "proper");
  return terms.filter(
    (term) => !(hasCore && term.kind === "descriptor") && !(hasProper && term.kind === "object"),
  );
}

function renderSelected(terms: RankedTerm[]): string {
  return [...terms]
    .sort((left, right) => left.group - right.group || left.index - right.index)
    .map((term) => term.text)
    .join("");
}

function chooseTerms(terms: RankedTerm[]): string {
  let candidates = terms.filter((term) => term.score > 0);
  if (candidates.length === 0) {
    candidates = terms.slice(0, 1);
  }
  candidates = candidates.slice(0, 14).map((term) => ({
    ...term,
    text: middleEllipsis(term.text),
  }));

  let bestText = "";
  let bestScore = Number.NEGATIVE_INFINITY;
  let bestDistance = Number.POSITIVE_INFINITY;
  const combinations = 1 << candidates.length;

  for (let mask = 1; mask < combinations; mask += 1) {
    const selected: RankedTerm[] = [];
    let rawScore = 0;
    for (let index = 0; index < candidates.length; index += 1) {
      if ((mask & (1 << index)) === 0) continue;
      selected.push(candidates[index]);
      rawScore += candidates[index].score;
    }
    const text = renderSelected(selected);
    const length = visibleCharCount(text);
    if (length === 0 || length > MAX_TITLE_CHARS) continue;

    const hasCore = selected.some((term) => term.kind === "core");
    const hasFirstProper = selected.some((term) => term.kind === "proper" && term.score === 90);
    const adjustedScore =
      rawScore +
      (hasCore ? 15 : 0) +
      (hasFirstProper ? 10 : 0) +
      (length <= PREFERRED_TITLE_CHARS ? 8 : 0) -
      Math.max(0, length - PREFERRED_TITLE_CHARS) * 2;
    const distance = Math.abs(length - PREFERRED_TITLE_CHARS);

    if (
      adjustedScore > bestScore ||
      (adjustedScore === bestScore && distance < bestDistance) ||
      (adjustedScore === bestScore && distance === bestDistance && text < bestText)
    ) {
      bestText = text;
      bestScore = adjustedScore;
      bestDistance = distance;
    }
  }
  return bestText;
}

export function compressTitle(rawTitle: unknown, aliases: Record<string, string> = {}): string {
  const normalized = normalizeSourceTitle(rawTitle);
  if (!normalized) return "";

  const alias = aliases[normalized] ?? aliases[normalized.toLocaleLowerCase("en-US")];
  if (typeof alias === "string" && alias.trim()) {
    return middleEllipsis(normalizeSourceTitle(alias));
  }

  const selected = chooseTerms(extractRankedTerms(normalized));
  if (selected) return middleEllipsis(selected);

  const fallback = applyPhraseRules(normalized)
    .split(/\s+/u)
    .filter((part) => part && FILLER_TERMS[part.toLocaleLowerCase("en-US")] !== true)
    .join("");
  return middleEllipsis(fallback || normalized);
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

export function loadAliases(aliasPath = DEFAULT_ALIAS_PATH): Record<string, string> {
  const parsed = asRecord(readJsonFile(aliasPath));
  const source = asRecord(parsed?.aliases) ?? parsed;
  if (!source) return {};
  const aliases: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== "string" || !value.trim()) continue;
    const normalizedKey = normalizeSourceTitle(key);
    if (!normalizedKey) continue;
    aliases[normalizedKey] = value;
    aliases[normalizedKey.toLocaleLowerCase("en-US")] = value;
  }
  return aliases;
}

function safeFilePart(value: unknown): string {
  return String(value ?? "unknown").replace(/[^A-Za-z0-9._-]/g, "_") || "unknown";
}

function statePathFor(stateDir: string, terminalId: string): string {
  return path.join(stateDir, `${safeFilePart(terminalId)}.json`);
}

type LabelOwnership = {
  original_label?: string | null;
  last_auto_label?: string;
  pane_id?: string;
  updated_at?: string;
};

type RuntimeState = {
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

function loadRuntimeState(filePath: string, terminalId: string): RuntimeState {
  const parsed = asRecord(readJsonFile(filePath));
  const tabs: Record<string, LabelOwnership> = {};
  const rawTabs = asRecord(parsed?.tabs);
  if (rawTabs) {
    for (const [tabId, value] of Object.entries(rawTabs)) {
      tabs[tabId] = parseOwnership(value);
    }
  }
  return {
    version: 1,
    terminal_id: terminalId,
    pane: parseOwnership(parsed?.pane),
    tabs,
  };
}

function saveState(filePath: string, state: RuntimeState): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, filePath);
}

type HerdrPane = {
  pane_id: string;
  tab_id: string;
  terminal_id?: string;
  label?: string;
};

type HerdrTab = {
  tab_id: string;
  pane_count: number;
  label?: string;
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
        id: `${SOURCE}:${process.pid}:${Date.now()}:${Math.random().toString(16).slice(2)}`,
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

export type SyncOptions = {
  paneId: string;
  stateDir?: string;
  aliasPath?: string;
  aliases?: Record<string, string>;
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

export async function syncTitle(
  rawTitle: unknown,
  client: HerdrClient,
  options: SyncOptions,
): Promise<SyncResult> {
  const aliases = options.aliases ?? loadAliases(options.aliasPath ?? DEFAULT_ALIAS_PATH);
  const title = compressTitle(rawTitle, aliases);
  if (!title) return { ok: false, reason: "empty-title" };

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
      if (!responseSucceeded(renameResponse)) {
        return { ok: false, reason: "pane-rename-failed", title };
      }
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

  if (stateChanged) saveState(filePath, state);
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

function parsePollInterval(): number {
  const parsed = Number.parseInt(process.env.OMP_HERDR_TITLE_SYNC_INTERVAL_MS ?? "750", 10);
  if (!Number.isFinite(parsed)) return 750;
  return Math.max(250, Math.min(parsed, 5000));
}

type ManagedTimerContext = {
  hasUI?: boolean;
  setInterval(callback: () => void | Promise<void>, milliseconds: number): unknown;
  clearTimer(timer: unknown): void;
};

export default function ompHerdrTitleSync(pi: ExtensionAPI): void {
  const socketPath = process.env.HERDR_SOCKET_PATH;
  const launchPaneId = process.env.HERDR_PANE_ID;
  const disabled = /^(?:1|true|yes|on)$/iu.test(process.env.OMP_HERDR_TITLE_SYNC_DISABLE ?? "");
  if (disabled || process.env.HERDR_ENV !== "1" || !socketPath || !launchPaneId) return;

  const client = createHerdrSocketClient(socketPath);
  const stateDir = process.env.OMP_HERDR_TITLE_SYNC_STATE_DIR || DEFAULT_STATE_DIR;
  const aliasPath = process.env.OMP_HERDR_TITLE_SYNC_ALIAS_PATH || DEFAULT_ALIAS_PATH;
  const pollInterval = parsePollInterval();
  let pollTimer: unknown;
  let sessionActive = false;
  let lastHandledTitle = "";
  let checking = false;
  let checkAgain = false;

  async function inspectTitle(): Promise<void> {
    if (!sessionActive) return;
    if (checking) {
      checkAgain = true;
      return;
    }
    checking = true;
    try {
      do {
        checkAgain = false;
        let currentTitle = "";
        try {
          currentTitle = String(pi.getSessionName() ?? "").trim();
        } catch {
          currentTitle = "";
        }
        if (!currentTitle || currentTitle === lastHandledTitle) continue;
        const result = await syncTitle(currentTitle, client, {
          paneId: launchPaneId,
          stateDir,
          aliasPath,
        });
        if (result.ok) lastHandledTitle = currentTitle;
      } while (checkAgain);
    } finally {
      checking = false;
    }
  }

  function activate(ctx: ManagedTimerContext): void {
    if (ctx.hasUI !== true) return;
    sessionActive = true;
    lastHandledTitle = "";
    if (pollTimer !== undefined) ctx.clearTimer(pollTimer);
    void inspectTitle();
    pollTimer = ctx.setInterval(() => inspectTitle(), pollInterval);
  }

  pi.on("session_start", (_event, ctx) => activate(ctx));
  pi.on("session_switch", (_event, ctx) => activate(ctx));
  pi.on("message_end", () => void inspectTitle());
  pi.on("agent_end", () => void inspectTitle());
  pi.on("session_shutdown", (_event, ctx) => {
    if (pollTimer !== undefined) ctx.clearTimer(pollTimer);
    pollTimer = undefined;
    sessionActive = false;
  });
}
