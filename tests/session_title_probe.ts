import fs from "node:fs";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function sessionTitleProbe(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.hasUI !== true) return;
    const target = process.env.OMP_TITLE_SYNC_TEST_TITLE ?? "";
    pi.setSessionName(target);
    fs.writeFileSync(
      process.env.OMP_TITLE_SYNC_PROBE_PATH ?? "/tmp/omp-title-sync-probe.json",
      `${JSON.stringify({ target, actual: pi.getSessionName(), hasUI: ctx.hasUI })}\n`,
      "utf8",
    );
  });
}
