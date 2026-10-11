const assert = require("node:assert/strict");
const Module = require("node:module");
const test = require("node:test");

// The playback decision runs in Electron's main process. Keep OS discovery
// out of these tests so an expired cache can never launch a real player.
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (name === "electron") return { app: { getPath: () => "/tmp" } };
  return originalLoad.call(this, name, ...args);
};
const { PlayerService } = require("../dist-electron/electron/player-service.js");
Module._load = originalLoad;

const room = {
  id: "douyin-123", platform: "douyin", title: "Live room", anchor: "Anchor",
  category: "Games", viewers: 1, tags: [], cover: "", status: "live",
  updatedAt: "", webUrl: "https://live.douyin.com/456",
  playback: { flv: { FULL_HD1: "https://example.com/stale.flv" } },
};

function makeService(resolve) {
  const launches = [];
  const service = new PlayerService();
  service.resolvePlayers = async () => [{
    id: "vunio", name: "Vunio", launch: async (...args) => launches.push(args),
  }];
  service.getState = async () => ({ defaultPlayerId: "vunio" });
  service.streamService = { resolve };
  service.danmakuService = { createSession: async () => null, dispose() {} };
  return { service, launches };
}

test("Douyin lookup failure never launches the cached list URL", async () => {
  const { service, launches } = makeService(async () => {
    throw new Error("该抖音直播间已下播");
  });
  const result = await service.requestPlay(room);
  assert.equal(result.ok, false);
  assert.match(result.message, /已下播/);
  assert.equal(launches.length, 0);
});

test("Douyin hands the fresh HTTPS URL and headers to Vunio", async () => {
  const fresh = "https://example.com/current.flv";
  const headers = { Referer: room.webUrl, "User-Agent": "Browser UA" };
  const { service, launches } = makeService(async () => ({
    flv: { source: fresh }, headers,
  }));
  const result = await service.requestPlay(room);
  assert.equal(result.ok, true);
  assert.equal(result.url, fresh);
  assert.equal(launches[0][0], fresh);
  assert.deepEqual(launches[0][1].headers, headers);
});

test("Other platforms retain their existing cached-stream fallback", async () => {
  const { service, launches } = makeService(async () => {
    throw new Error("Temporary lookup failure");
  });
  const result = await service.requestPlay({ ...room, platform: "douyu" });
  assert.equal(result.ok, true);
  assert.equal(launches[0][0], room.playback.flv.FULL_HD1);
});
