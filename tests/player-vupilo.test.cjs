const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const installed = new Set();
const launches = [];
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (name === "electron") return { app: { getPath: () => "/tmp/livehub-vupilo-test" } };
  const value = originalLoad.call(this, name, ...args);
  if (name === "node:fs") return { ...value, existsSync: (target) => installed.has(target) };
  if (name === "node:child_process") return {
    ...value,
    execFile: (_command, _args, callback) => callback(new Error("Not installed")),
    spawn: (command, args) => {
      launches.push({ command, args });
      const child = new EventEmitter();
      child.unref = () => {};
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
  };
  return value;
};
const { PlayerService } = require("../dist-electron/electron/player-service.js");
Module._load = originalLoad;

const systemApp = (name) => path.join("/Applications", name);
const userApp = (name) => path.join(os.homedir(), "Applications", name);

function fixture(paths) {
  installed.clear();
  for (const location of paths) installed.add(location);
  launches.length = 0;
  const service = new PlayerService();
  service.readSettings = async () => ({ defaultPlayerId: "vunio" });
  service.writeSettings = async () => assert.fail("The existing default player should survive the rename");
  service.streamService = { resolve: async () => ({ flv: { source: "https://cdn.example/live+a.flv" }, headers: { Referer: "https://live.bilibili.com/", "User-Agent": "Player UA + literal" } }) };
  service.danmakuService = { createSession: async () => ({ url: "ws://127.0.0.1:1234/danmaku", dispose() {} }), dispose() {} };
  return service;
}

const room = { id: "bilibili-1", platform: "bilibili", status: "live", title: "Live", anchor: "Anchor", category: "Live", tags: [], cover: "", viewers: 0, updatedAt: "" };

test("Vupilo detection prefers the new app and preserves the legacy saved default", async () => {
  const service = fixture([systemApp("Vupilo.app"), systemApp("Vunio.app")]);
  const state = await service.getState();
  assert.equal(state.defaultPlayerId, "vunio");
  assert.deepEqual(state.players.map(({ id, name, location }) => ({ id, name, location })), [{ id: "vunio", name: "Vupilo", location: systemApp("Vupilo.app") }]);
  assert.equal((await service.requestPlay(room)).ok, true);
  assert.equal(launches[0].command, "open");
  assert.equal(launches[0].args[1], systemApp("Vupilo.app"));
  const handoff = new URL(launches[0].args[2]);
  assert.equal(handoff.protocol, "vupilo:");
  assert.equal(handoff.searchParams.get("url"), "https://cdn.example/live+a.flv");
  assert.deepEqual(handoff.searchParams.getAll("header"), ["Referer: https://live.bilibili.com/", "User-Agent: Player UA + literal"]);
  assert.equal(handoff.searchParams.get("danmakuUrl"), "ws://127.0.0.1:1234/danmaku");
  assert.ok(!handoff.search.includes("+"));
});

test("a user-installed Vupilo wins over the system-installed legacy app", async () => {
  const service = fixture([userApp("Vupilo.app"), systemApp("Vunio.app")]);
  assert.equal((await service.getState()).players[0].location, userApp("Vupilo.app"));
});

test("legacy Vunio remains launchable with its original scheme and the new display name", async () => {
  const service = fixture([systemApp("Vunio.app")]);
  assert.equal((await service.getState()).players[0].name, "Vupilo");
  assert.equal((await service.requestPlay(room)).ok, true);
  assert.equal(new URL(launches[0].args[2]).protocol, "vunio:");
});
