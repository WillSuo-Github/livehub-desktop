// Run after npm run build:electron: node_modules/.bin/electron scripts/qa-douyin-browser.cjs
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const { createServer } = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow, session } = require("electron");
const { startDouyinBrowser } = require("../dist-electron/electron/douyin-browser");

const profile = mkdtempSync(path.join(os.tmpdir(), "livehub-douyin-qa-"));
app.setPath("userData", profile);
process.on("exit", () => rmSync(profile, { recursive: true, force: true }));
app.on("window-all-closed", () => {});

const directorySessions = [];
app.on("session-created", (created) => {
  if (created.storagePath === null) directorySessions.push(created);
});

const requests = [];
let pendingResponse;
let notifyRequestStarted;
const requestStarted = new Promise((resolve) => { notifyRequestStarted = resolve; });
const fixture = createServer((request, response) => {
  const { pathname, searchParams } = new URL(request.url, "http://127.0.0.1");
  if (pathname !== "/webcast/web/partition/detail/room/v2") {
    response.writeHead(200, { "Content-Type": "text/html" }).end("<!doctype html>");
    return;
  }
  const offset = Number(searchParams.get("offset"));
  requests.push(offset);
  const respond = () => response.writeHead(200, {
    "Content-Type": "application/json",
    "Cache-Control": "public, max-age=3600",
  }).end(JSON.stringify({ offset }));
  if (offset === 45) {
    pendingResponse = respond;
    notifyRequestStarted();
    return;
  }
  respond();
});

const loadURL = BrowserWindow.prototype.loadURL;
const bridges = [];
async function openBridge() {
  const bridge = await startDouyinBrowser();
  bridges.push(bridge);
  return bridge;
}

async function readPage(bridge, offset) {
  const response = await fetch(`${bridge.url}?category=4_101&offset=${offset}`, {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { offset });
}

async function run() {
  await new Promise((resolve, reject) => {
    fixture.once("error", reject);
    fixture.listen(0, "127.0.0.1", resolve);
  });
  BrowserWindow.prototype.loadURL = function (url) {
    assert.equal(url, "https://live.douyin.com/categorynew/4_101");
    return loadURL.call(this, `http://127.0.0.1:${fixture.address().port}/categorynew/4_101`);
  };

  for (let cycle = 0; cycle < 4; cycle += 1) {
    const bridge = await openBridge();
    await readPage(bridge, 0);
    await readPage(bridge, 0);
    bridge.close();
    assert.equal(BrowserWindow.getAllWindows().length, 0);
  }
  assert.deepEqual(requests, Array(8).fill(0), "Directory responses must bypass the HTTP cache");

  const [first, second] = await Promise.all([openBridge(), openBridge()]);
  assert.equal(directorySessions.length, 1, "Refreshes must reuse one in-memory partition");
  assert.notEqual(directorySessions[0], session.defaultSession);
  assert.notEqual(first.url, second.url);

  const inFlight = readPage(second, 45);
  await Promise.race([requestStarted, inFlight]);
  first.close();
  pendingResponse();
  await inFlight;
  await readPage(second, 15);
  second.close();
  assert.equal(BrowserWindow.getAllWindows().length, 0);
  console.log("Passed: one isolated session across six bridges, HTTP cache disabled, and overlapping requests survive bridge cleanup.");
}

const watchdog = setTimeout(() => {
  console.error("Douyin browser smoke test timed out");
  app.exit(1);
}, 20000);

app.whenReady().then(run).catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  clearTimeout(watchdog);
  BrowserWindow.prototype.loadURL = loadURL;
  for (const bridge of bridges) bridge.close();
  fixture.close();
  fixture.closeAllConnections();
  app.exit(process.exitCode ?? 0);
});
