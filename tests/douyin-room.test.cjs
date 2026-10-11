const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  douyinWebRoomId,
  parseDouyinPlayback,
  resolveDouyinPlayback,
} = require("../dist-electron/electron/douyin-room.js");
const { browserUserAgent } = require("../dist-electron/electron/platform-http.js");

const room = {
  id: "douyin-1234567890123456789",
  platform: "douyin",
  webUrl: "https://live.douyin.com/510200350291",
  status: "live",
  playback: { flv: { FULL_HD1: "https://cached.example/expired.flv" } },
};

function response(status, stream_url = {}) {
  return { status_code: 0, data: { data: [{ status, stream_url }] } };
}

function sdkResponse() {
  return response(2, {
    default_resolution: "HD1",
    flv_pull_url: { FULL_HD1: "https://legacy.example/lower.flv" },
    hls_pull_url_map: { FULL_HD1: "https://legacy.example/lower.m3u8" },
    live_core_sdk_data: {
      pull_data: {
        options: {
          qualities: [
            { sdk_key: "ld", level: 1, v_bit_rate: 1000000 },
            { sdk_key: "uhd", level: 4, v_bit_rate: 15161344 },
            { sdk_key: "origin", level: 5, v_bit_rate: 15161344 },
          ],
        },
        stream_data: JSON.stringify({
          data: {
            ld: { main: { flv: "http://fresh.example/ld.flv" } },
            uhd: { main: { flv: "https://fresh.example/uhd.flv" } },
            md: { main: { flv: "https://fresh.example/md.flv" } },
            ao: { main: { flv: "https://fresh.example/audio.flv" } },
            origin: {
              main: {
                flv: "http://fresh.example/origin.flv?token=valid",
                hls: "https://fresh.example/origin.m3u8?token=valid",
                sdk_params: '{"vbitrate":15161344,"resolution":""}',
              },
              backup: { flv: "http://backup.example/origin.flv?token=valid" },
            },
          },
        }),
      },
    },
  });
}

function httpReturning(payload) {
  const calls = [];
  return {
    calls,
    async fetchHome(url, headers) {
      calls.push({ type: "home", url, headers });
      return { response: { headers: new Headers({ "set-cookie": "session=abc; Path=/, ttwid=fresh-cookie; Path=/; HttpOnly" }) } };
    },
    async fetchRoom(url, headers) {
      calls.push({ type: "room", url, headers });
      return payload;
    },
  };
}

test("current offline room rejects even when the category supplies a cached URL", async () => {
  const http = httpReturning(response(4, {
    flv_pull_url: { FULL_HD1: "https://expired.example/offline.flv" },
  }));
  await assert.rejects(resolveDouyinPlayback(room, http), /已结束或尚未开播/);
  assert.equal(http.calls.length, 2);
});

test("current SDK origin streams win over cached and legacy default quality", async () => {
  const http = httpReturning(sdkResponse());
  const playback = await resolveDouyinPlayback(room, http);
  assert.deepEqual(Object.keys(playback.flv), ["origin", "origin_backup", "uhd", "ld", "md"]);
  assert.equal(Object.values(playback.flv)[0], "https://fresh.example/origin.flv?token=valid");
  assert.equal(playback.hls.origin, "https://fresh.example/origin.m3u8?token=valid");
  assert.ok(!JSON.stringify(playback).includes("cached.example"));
  assert.ok(!JSON.stringify(playback).includes("legacy.example"));
  assert.ok(!JSON.stringify(playback).includes("audio.flv"));
  assert.deepEqual(playback.headers, {
    Referer: "https://live.douyin.com/510200350291",
    Origin: "https://live.douyin.com",
    "User-Agent": browserUserAgent,
  });
  const enter = http.calls[1];
  assert.equal(new URL(enter.url).searchParams.get("web_rid"), "510200350291");
  assert.equal(enter.headers.Cookie, "ttwid=fresh-cookie");
  assert.equal(enter.headers.Referer, playback.headers.Referer);
});

test("legacy current response orders FULL_HD1 before HD1 and upgrades HTTP", () => {
  const playback = parseDouyinPlayback(response(2, {
    flv_pull_url: {
      SD2: "http://fresh.example/ld.flv",
      HD1: "http://fresh.example/hd.flv",
      FULL_HD1: "http://fresh.example/full.flv",
    },
    hls_pull_url: "http://fresh.example/source.m3u8",
  }), "123");
  assert.deepEqual(Object.keys(playback.flv), ["FULL_HD1", "HD1", "SD2"]);
  assert.equal(playback.flv.FULL_HD1, "https://fresh.example/full.flv");
  assert.equal(playback.hls.source, "https://fresh.example/source.m3u8");
});

test("SDK metadata orders nonstandard quality keys by level", () => {
  const payload = response(2, {
    live_core_sdk_data: {
      pull_data: {
        options: { qualities: [{ sdk_key: "custom_low", level: 1 }, { sdk_key: "custom_high", level: 5 }] },
        stream_data: JSON.stringify({ data: {
          custom_low: { main: { flv: "https://fresh.example/low.flv" } },
          custom_high: { main: { flv: "https://fresh.example/high.flv" } },
        } }),
      },
    },
  });
  assert.equal(Object.keys(parseDouyinPlayback(payload, "123").flv)[0], "custom_high");
});

test("invalid or missing website URLs never fall back to an internal room ID", async () => {
  const invalid = [
    undefined,
    "https://live.douyin.com/not-a-room",
    "https://live.douyin.com/123/extra",
    "https://live.douyin.com.evil.example/123",
    "https://evil.example/live.douyin.com/123",
    "https://user@live.douyin.com/123",
    "file://live.douyin.com/123",
  ];
  for (const webUrl of invalid) {
    const http = httpReturning(sdkResponse());
    await assert.rejects(resolveDouyinPlayback({ ...room, webUrl }, http), /地址/);
    assert.equal(http.calls.length, 0);
  }
  assert.equal(douyinWebRoomId({ webUrl: "https://live.douyin.com/room/123/?from=web" }), "123");
  assert.equal(douyinWebRoomId({ url: "https://live.douyin.com/123" }), "123");
});

test("missing room status, API errors, and empty or unsafe streams reject", () => {
  assert.throws(() => parseDouyinPlayback({ status_code: 0, data: { data: [] } }, "123"), /状态获取失败/);
  assert.throws(() => parseDouyinPlayback({ status_code: 1 }, "123"), /信息获取失败/);
  assert.throws(() => parseDouyinPlayback(response(2), "123"), /没有返回可播放/);
  assert.throws(() => parseDouyinPlayback(response(2, {
    flv_pull_url: { FULL_HD1: "file:///tmp/stream.flv", HD1: "https://user:secret@cdn.example/live.flv" },
  }), "123"), /没有返回可播放/);
});

test("malformed SDK data uses only fresh legacy streams of a live room", () => {
  const playback = parseDouyinPlayback(response(2, {
    live_core_sdk_data: { pull_data: { stream_data: "not JSON" } },
    flv_pull_url: { FULL_HD1: "https://fresh.example/live.flv" },
  }), "123");
  assert.deepEqual(playback.flv, { FULL_HD1: "https://fresh.example/live.flv" });
});

test("missing ttwid rejects before fetching a room", async () => {
  const http = httpReturning(sdkResponse());
  http.fetchHome = async () => ({ response: { headers: new Headers() } });
  await assert.rejects(resolveDouyinPlayback(room, http), /ttwid 获取失败/);
  assert.equal(http.calls.length, 0);
});
