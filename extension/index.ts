import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export {
  createHerdrSocketClient,
  DEFAULT_STATE_DIR,
  LEGACY_SERVICE_NAME,
  listHerdrAgents,
  MAX_TITLE_CHARS,
  mayOverwriteLabel,
  MIN_TITLE_CHARS,
  normalizeModelTitle,
  SERVICE_NAME,
  splitVisibleChars,
  statePathFor,
  syncGeneratedTitle,
  visibleCharCount,
  type HerdrAgentRecord,
  type HerdrClient,
  type LabelOwnership,
  type RuntimeState,
  type SyncOptions,
  type SyncResult,
} from "../src/core.ts";

/**
 * Compatibility extension. The Herdr-centered launchd service owns title
 * distillation; OMP needs no per-session title generator after migration.
 */
export default function herdrTitleDistillExtension(_pi: ExtensionAPI): void {
  // Intentionally empty: keeping the extension entrypoint preserves package compatibility.
}
