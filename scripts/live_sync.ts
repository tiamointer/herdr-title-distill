import { createHerdrSocketClient, syncGeneratedTitle, visibleCharCount } from "../src/core.ts";

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
const result = await syncGeneratedTitle(title, createHerdrSocketClient(socketPath), {
  paneId,
  stateDir,
});

console.log(JSON.stringify({ ...result, visible_chars: result.title ? visibleCharCount(result.title) : 0 }));
if (!result.ok) process.exitCode = 1;
