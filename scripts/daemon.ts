#!/usr/bin/env bun

import fs from "node:fs";
import path from "node:path";

import {
  createHerdrSocketClient,
  DEFAULT_SOCKET_PATH,
  DEFAULT_STATE_DIR,
  SERVICE_NAME,
} from "../src/core.ts";
import { DistillService, type ServiceLogEvent } from "../src/service.ts";

function emit(logFile: string, event: ServiceLogEvent): void {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.appendFileSync(logFile, `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`, "utf8");
}

const configuredSocketPath =
  process.env.HERDR_TITLE_DISTILL_SOCKET_PATH || process.env.HERDR_SOCKET_PATH || DEFAULT_SOCKET_PATH;
const stateDir = process.env.HERDR_TITLE_DISTILL_STATE_DIR || DEFAULT_STATE_DIR;
const logFile = process.env.HERDR_TITLE_DISTILL_LOG || path.join(path.dirname(stateDir), "service.log");
const pollIntervalMs = Number.parseInt(process.env.HERDR_TITLE_DISTILL_INTERVAL_MS || "750", 10) || 750;
const rescanIntervalMs =
  Number.parseInt(process.env.HERDR_TITLE_DISTILL_RESCAN_MS || "30000", 10) || 30_000;

// Named herdr sessions live in <herdr-config>/sessions/<name>/herdr.sock; the
// default session listens on <herdr-config>/herdr.sock. A named session's
// panes are invisible on the default socket, so the daemon must watch every
// live session socket, not just the default one. If the configured socket is
// itself a named-session socket, normalize to the default socket so the
// session isn't double-counted under the wrong "default" label.
const sessionsRoot = path.join(path.dirname(DEFAULT_SOCKET_PATH), "sessions");
const defaultRelative = path.relative(sessionsRoot, configuredSocketPath);
const socketPath =
  defaultRelative && !defaultRelative.startsWith("..") && !path.isAbsolute(defaultRelative)
    ? DEFAULT_SOCKET_PATH
    : configuredSocketPath;

function socketLabel(candidate: string): string {
  if (candidate === socketPath) return "default";
  const relative = path.relative(sessionsRoot, candidate);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return relative.split(path.sep)[0] || "default";
  }
  return candidate
    .split(path.sep)
    .filter(Boolean)
    .slice(-2)
    .join("_")
    .replace(/[^A-Za-z0-9._-]/g, "_");
}

function discoverSocketPaths(): string[] {
  const found = [socketPath];
  try {
    for (const entry of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(sessionsRoot, entry.name, "herdr.sock");
      try {
        fs.accessSync(candidate);
        found.push(candidate);
      } catch {
        // Session directory without a socket yet; skip.
      }
    }
  } catch {
    // No sessions directory (older herdr); default socket only.
  }
  return found;
}

const services = new Map<string, DistillService>();

function runtimeFileFor(label: string): string {
  const base = path.dirname(stateDir);
  // Pane IDs are per-session namespaces, so processed-state must not be shared
  // across sessions. Keep the legacy filename for the default session.
  return label === "default" ? path.join(base, "service.json") : path.join(base, `service.${label}.json`);
}

function startServiceFor(candidate: string): void {
  if (services.has(candidate)) return;
  const label = socketLabel(candidate);
  const service = new DistillService({
    client: createHerdrSocketClient(candidate, 2_000),
    log: (event) => emit(logFile, { ...event, session: label }),
    pollIntervalMs,
    stateDir,
    runtimeFile: runtimeFileFor(label),
  });
  services.set(candidate, service);
  emit(logFile, { event: "session-watch-started", session: label });
  service.start();
}

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  for (const service of services.values()) service.stop();
  await Promise.all(Array.from(services.values(), (service) => service.flush()));
  emit(logFile, { event: "daemon-exit", reason: signal });
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGHUP", () => void shutdown("SIGHUP"));
process.on("uncaughtException", (error) => {
  emit(logFile, { event: "uncaught-exception", reason: error.message });
});
process.on("unhandledRejection", (error) => {
  emit(logFile, { event: "unhandled-rejection", reason: String(error) });
});

emit(logFile, { event: "daemon-start", reason: SERVICE_NAME });
for (const candidate of discoverSocketPaths()) startServiceFor(candidate);
// Pick up herdr sessions started after daemon launch.
setInterval(() => {
  for (const candidate of discoverSocketPaths()) startServiceFor(candidate);
}, rescanIntervalMs).unref?.();
await new Promise<never>(() => {});
