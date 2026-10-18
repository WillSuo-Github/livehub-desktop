const assert = require("node:assert/strict");
const test = require("node:test");
const { favoriteKey, getFavoriteRooms, isFavoriteRoom, toggleFavoriteRoom, parseFavoriteIds } = require("../dist-electron/shared/favorites.js");
const { migrateFavoriteIds, resolveLegacyDouyinFavorite } = require("../dist-electron/electron/favorites-migration.js");

const room = {
  id: "douyin-7697467031960013595", platform: "douyin",
  webUrl: "https://live.douyin.com/335610475439",
};

test("a favorite survives a Douyin session change and can be removed from the next session", () => {
  const ids = toggleFavoriteRoom(room, []);
  const nextSession = { ...room, id: "douyin-7697934304546196234" };
  assert.deepEqual(ids, ["douyin-web-335610475439"]);
  assert.equal(isFavoriteRoom(nextSession, ids), true);
  assert.deepEqual(toggleFavoriteRoom(nextSession, ids), []);
  assert.equal(nextSession.id, "douyin-7697934304546196234");
});

test("legacy and stable aliases are removed together; other platforms keep their IDs", () => {
  assert.deepEqual(toggleFavoriteRoom(room, [room.id, favoriteKey(room), "huya-60066"]), ["huya-60066"]);
  assert.equal(favoriteKey({ ...room, platform: "huya", id: "huya-60066" }), "huya-60066");
  assert.equal(favoriteKey({ ...room, webUrl: "https://live.douyin.com.evil.test/123" }), room.id);
});

test("overlapping directory snapshots show and count a favorited anchor once", () => {
  const ended = { ...room, status: "offline" };
  const live = { ...room, id: "douyin-7697934304546196234", status: "live" };
  const result = getFavoriteRooms([ended, live, { ...live, id: "douyin-999" }], [favoriteKey(room)]);
  assert.deepEqual(result, [live]);
});

test("malformed saved data is rejected instead of replaced with an empty list", () => {
  assert.deepEqual(parseFavoriteIds(null), []);
  assert.throws(() => parseFavoriteIds('{"unexpected":true}'));
  assert.throws(() => parseFavoriteIds('[null]'));
  assert.throws(() => parseFavoriteIds('broken'));
});

test("migration restores and merges sessions with a preexisting stable favorite, preserving other platforms", async () => {
  const input = ["huya-60066", room.id, "douyin-7697934304546196234", "douyin-web-335610475439", "bilibili-23438368"];
  const original = [...input];
  const result = await migrateFavoriteIds(input, async () => "douyin-web-335610475439");
  assert.deepEqual(result, { ids: ["huya-60066", "douyin-web-335610475439", "bilibili-23438368"], migratedCount: 2, unresolvedCount: 0, mergedCount: 2 });
  assert.deepEqual(input, original);
  assert.deepEqual((await migrateFavoriteIds(result.ids, () => { throw new Error("must not look up stable IDs"); })).ids, result.ids);
});

test("failed lookups preserve the exact old favorite and can recover on the next launch", async () => {
  const result = await migrateFavoriteIds([room.id, "douyin-123"], async (id) => {
    if (id === "123") throw new Error("offline");
    return "douyin-web-335610475439";
  });
  assert.deepEqual(result.ids, ["douyin-web-335610475439", "douyin-123"]);
  assert.equal(result.unresolvedCount, 1);
  const retry = await migrateFavoriteIds(result.ids, async () => "douyin-web-335610475439");
  assert.deepEqual(retry.ids, ["douyin-web-335610475439"]);
});

test("duplicates are resolved once and partial lookup failures never erase entries", async () => {
  let calls = 0;
  const result = await migrateFavoriteIds([room.id, room.id, "huya-60066"], async () => {
    calls += 1;
    return "unexpected";
  });
  assert.equal(calls, 1);
  assert.deepEqual(result.ids, [room.id, "huya-60066"]);
  assert.equal(result.unresolvedCount, 1);
  await assert.rejects(migrateFavoriteIds([null]));
});

test("live lookup validates the returned room identity and accepts ended sessions", async () => {
  const originalFetch = global.fetch;
  try {
    global.fetch = async (url, options) => {
      assert.equal(url.searchParams.get("room_id"), "123");
      assert.ok(options.signal);
      return { ok: true, json: async () => ({ status_code: 0, data: { room: { id_str: "123", status: 4, owner: { web_rid: "456" } } } }) };
    };
    assert.equal(await resolveLegacyDouyinFavorite("123"), "douyin-web-456");
    global.fetch = async () => ({ ok: true, json: async () => ({ status_code: 0, data: { room: { id_str: "999", owner: { web_rid: "456" } } } }) });
    await assert.rejects(resolveLegacyDouyinFavorite("123"), /requested room/);
    await assert.rejects(resolveLegacyDouyinFavorite("123&room_id=999"), /Invalid legacy/);
  } finally {
    global.fetch = originalFetch;
  }
});
