import {
  createHerdrSocketClient,
  syncTitle,
  visibleCharCount,
} from "../extension/index.ts";

function argumentValue(name: string): string {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) {
    throw new Error(`missing ${name}`);
  }
  return process.argv[index + 1];
}

const socketPath = process.env.HERDR_SOCKET_PATH;
if (!socketPath) throw new Error("HERDR_SOCKET_PATH is required");

const paneId = argumentValue("--pane");
const title = argumentValue("--title");
const stateDir = argumentValue("--state-dir");
const aliasPathIndex = process.argv.indexOf("--alias-path");
const aliasPath = aliasPathIndex >= 0 ? argumentValue("--alias-path") : undefined;
const result = await syncTitle(title, createHerdrSocketClient(socketPath), {
  paneId,
  stateDir,
  ...(aliasPath ? { aliasPath } : {}),
});

console.log(JSON.stringify({ ...result, visible_chars: result.title ? visibleCharCount(result.title) : 0 }));
if (!result.ok) process.exitCode = 1;
