const assert = require("node:assert/strict");
const { test } = require("node:test");
const { once } = require("node:events");
const { createStremioServer, StremioService, stremioPlatforms } = require("../dist-electron/electron/stremio-service.js");

function room(platform, number = 1) {
  return {
    id: `${platform}-${number}`, platform, title: `Live ${number}`, anchor: `主播 ${number}`,
    category: "三角洲行动", viewers: 100 - number, viewerLabel: "100 online", tags: ["Gaming"],
    cover: 'url("https://images.example/cover.jpg?q=1") center center / cover no-repeat',
    status: "live", updatedAt: "", webUrl: `https://example.com/${number}`,
  };
}

async function fixture(t, { rooms = stremioPlatforms.map((platform) => room(platform)), resolve } = {}) {
  const loads = [];
  const resolutions = [];
  let listener;
  const states = Object.fromEntries(stremioPlatforms.map((platform) => [platform, { state: "connected", message: "" }]));
  const directory = {
    async listRooms(platform) { loads.push(platform); return rooms.filter((value) => value.platform === platform); },
    getAppInfo() { return states; },
    subscribe(value) { listener = value; return () => { listener = undefined; }; },
  };
  const addon = new StremioService(directory, { async resolve(value) {
    resolutions.push(value.id);
    return resolve ? resolve(value, resolutions.length) : {
      flv: { source: `https://cdn.example/current-${resolutions.length}.flv` },
      hls: { HD: "https://cdn.example/live.m3u8" },
      headers: { Referer: "https://live.example/", Origin: "https://live.example", "User-Agent": "LiveHub" },
    };
  } }, "0.1.28");
  const server = createStremioServer(addon);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { addon.dispose(); server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { addon, loads, resolutions, states, emit: (value) => listener(value),
    get: async (path, options) => fetch(base + path, options),
    json: async (path) => (await fetch(base + path)).json(),
  };
}

test("one manifest exposes four live catalogs with search, paging and CORS", async (t) => {
  const f = await fixture(t);
  const response = await f.get("/manifest.json");
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  const manifest = await response.json();
  assert.deepEqual(manifest.catalogs.map((value) => value.id), stremioPlatforms.map((p) => `livehub-${p}`));
  assert.ok(manifest.catalogs.every((value) => value.type === "tv" && value.extra.some((extra) => extra.name === "skip")
    && value.extra.some((extra) => extra.name === "search")));
  for (const platform of stremioPlatforms) {
    const { metas } = await f.json(`/catalog/tv/livehub-${platform}.json`);
    assert.equal(metas[0].id, `livehub:${platform}-1`);
    assert.equal(metas[0].poster, "https://images.example/cover.jpg?q=1");
    assert.match(metas[0].name, /主播/);
  }
  assert.equal(f.resolutions.length, 0);
});

test("Unicode search, encoded separators, pagination and offline filtering match Vunio requests", async (t) => {
  const rooms = Array.from({ length: 63 }, (_, index) => room("douyin", index + 1));
  rooms.push({ ...room("douyin", 70), status: "offline" });
  rooms[0].title = "A&B=C/中文";
  const f = await fixture(t, { rooms });
  assert.equal((await f.json("/catalog/tv/livehub-douyin.json")).metas.length, 50);
  assert.equal((await f.json("/catalog/tv/livehub-douyin/skip=50.json")).metas.length, 13);
  assert.deepEqual((await f.json("/catalog/tv/livehub-douyin/skip=63.json")).metas, []);
  for (const search of ["主播 1", "三角洲行动", "ＧＡＭＩＮＧ", "A&B=C/中文"]) {
    const results = await f.json(`/catalog/tv/livehub-douyin/search=${encodeURIComponent(search)}&skip=0.json`);
    assert.ok(results.metas.length > 0, search);
  }
  assert.deepEqual((await f.json("/catalog/tv/livehub-douyin/search=missing.json")).metas, []);
  assert.deepEqual(f.loads, ["douyin"], "search keystrokes reuse the directory, not the upstream API");
});

test("metadata and fresh multi-quality streams preserve request headers for all four platforms", async (t) => {
  const f = await fixture(t);
  for (const platform of stremioPlatforms) {
    const id = encodeURIComponent(`livehub:${platform}-1`);
    const { meta } = await f.json(`/meta/tv/${id}.json`);
    assert.equal(meta.type, "tv");
    const first = await f.json(`/stream/tv/${id}.json`);
    const second = await f.json(`/stream/tv/${id}.json`);
    assert.equal(first.streams.length, 2);
    assert.notEqual(first.streams[0].url, second.streams[0].url);
    assert.equal(first.streams[0].behaviorHints.notWebReady, true);
    assert.deepEqual(first.streams[0].behaviorHints.proxyHeaders.request, {
      Referer: "https://live.example/", Origin: "https://live.example", "User-Agent": "LiveHub",
    });
  }
  assert.equal(f.resolutions.length, 8);
});

test("concurrent stream lookups coalesce without caching the result for later playback", async (t) => {
  let release;
  const f = await fixture(t, { resolve: async (_, count) => {
    await new Promise((resolve) => { release = resolve; });
    return { flv: { source: `https://cdn.example/${count}.flv` } };
  } });
  const first = f.addon.streams("livehub:huya-1");
  const second = f.addon.streams("livehub:huya-1");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.resolutions.length, 1);
  release();
  assert.deepEqual(await first, await second);
  const next = f.addon.streams("livehub:huya-1");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.resolutions.length, 2);
  release(); await next;
});

test("background directory updates remove ended rooms and update health", async (t) => {
  const f = await fixture(t);
  await f.addon.warmup();
  f.emit({ platform: "huya", rooms: [], status: { state: "connected", lastUpdatedAt: new Date().toISOString() } });
  assert.deepEqual((await f.json("/catalog/tv/livehub-huya.json")).metas, []);
  assert.equal((await f.get("/stream/tv/livehub%3Ahuya-1.json")).status, 404);
  assert.equal((await f.json("/health.json")).platforms.huya.rooms, 0);
});

test("invalid resources, arbitrary URLs, methods and pagination never resolve an upstream stream", async (t) => {
  const f = await fixture(t);
  for (const path of ["/stream/movie/livehub:huya-1.json", "/catalog/tv/unknown.json",
    "/stream/tv/https%3A%2F%2Flocalhost.json", "/stream/tv/livehub%3Ahuya-999.json"]) {
    assert.equal((await f.get(path)).status, 404, path);
  }
  for (const path of ["/meta/tv/%FF.json", "/catalog/tv/livehub-huya/skip=-1.json",
    "/stream/tv/livehub%3Ahuya-1/extra=1.json"]) {
    assert.equal((await f.get(path)).status, 400, path);
  }
  assert.equal((await f.get("/manifest.json", { method: "POST" })).status, 405);
  assert.equal((await f.get("/manifest.json", { method: "OPTIONS" })).status, 204);
  assert.equal((await f.get("/manifest.json", { method: "HEAD" })).status, 200);
  assert.deepEqual(f.resolutions, []);
});

test("upstream failures are retryable errors without leaking signed URLs or using cached playback", async (t) => {
  const f = await fixture(t, { resolve: async () => { throw new Error("https://secret.example/?token=private"); } });
  const response = await f.get("/stream/tv/livehub%3Adouyin-1.json");
  assert.equal(response.status, 502);
  assert.ok(!(await response.text()).includes("private"));
  f.states.douyu.state = "error";
  const empty = await fixture(t, { rooms: [] });
  empty.states.douyu.state = "error";
  assert.equal((await empty.get("/catalog/tv/livehub-douyu.json")).status, 502);
});

test("unsafe and duplicate provider URLs are excluded without losing valid streams", async (t) => {
  const f = await fixture(t, { resolve: async () => ({
    flv: { local: "file:///tmp/video", credentials: "https://user:secret@cdn.example/live",
      good: "https://cdn.example/live.flv", duplicate: "https://cdn.example/live.flv" },
  }) });
  assert.equal((await f.json("/stream/tv/livehub%3Abilibili-1.json")).streams.length, 1);
});
