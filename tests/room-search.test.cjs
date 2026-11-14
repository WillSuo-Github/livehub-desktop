const assert = require("node:assert/strict");
const test = require("node:test");
const { RoomSearchService, parseSearchPage } = require("../dist-electron/electron/room-search-service.js");
const { mergeSearchRooms, appendSearchPages } = require("../dist-electron/shared/room-search.js");

const payloads = {
  bilibili: { code: 0, data: { numResults: 40, numPages: 2, result: [
    { roomid: 21852, uname: '<em class="keyword">老番茄</em>&amp;朋友', uface: '//images.example/avatar.png', live_status: 0, attentions: 999999 },
    { roomid: 12, uname: '轮播', live_status: 2 }, { roomid: 13, uname: '开播', live_status: 1 },
  ] } },
  douyu: { error: 0, data: { total: 10000, relateUser: [
    { anchorInfo: { rid: 99999, nickName: '旭旭宝宝', isLive: 2, fansNum: 999999 } },
    { anchorInfo: { rid: 2, nickName: '轮播', isLive: 1, roomType: 3 } },
    { anchorInfo: { rid: 3, nickName: '开播', isLive: 1, roomType: 0 } },
  ] } },
  huya: { response: { 1: { numFound: 1000, docs: [
    { room_id: 688, game_nick: '张大仙', gameLiveOn: false, game_activityCount: 999999 },
    { room_id: 2, game_nick: '开播', gameLiveOn: true },
    { room_id: 2, game_nick: '开播', gameLiveOn: true },
    { room_id: '1/evil', game_nick: '坏房间', gameLiveOn: true },
  ] } } },
};

test("search preserves offline anchors, identifies carousel rooms and never treats followers as viewers", () => {
  for (const platform of ['bilibili', 'douyu', 'huya']) {
    const page = parseSearchPage(platform, payloads[platform], 1);
    assert.equal(page.rooms[0].status, 'offline');
    assert.equal(page.rooms[0].viewers, 0);
    assert.equal(page.rooms[0].viewerLabel, '—');
    assert.equal(page.rooms.at(-1).status, 'live');
    assert.ok(page.rooms[0].webUrl.startsWith('https://'));
  }
  const bili = parseSearchPage('bilibili', payloads.bilibili, 1);
  assert.equal(bili.rooms[0].anchor, '老番茄&朋友');
  assert.equal(bili.rooms[1].status, 'offline');
  assert.equal(parseSearchPage('douyu', payloads.douyu, 1).rooms[1].status, 'offline');
  assert.equal(parseSearchPage('huya', payloads.huya, 1).rooms.length, 2);
});

test("provider errors and changed schemas remain failures instead of empty successful searches", () => {
  assert.throws(() => parseSearchPage('bilibili', { code: -412 }, 1));
  assert.throws(() => parseSearchPage('douyu', { error: 1, msg: 'limit' }, 1));
  assert.throws(() => parseSearchPage('huya', { response: {} }, 1));
  assert.throws(() => parseSearchPage('bilibili', { code: 0, data: { numResults: 20 } }, 1));
});

test("search paginates within provider limits and excludes Douyin without any request", async () => {
  const calls = [];
  const service = new RoomSearchService({
    bilibiliCookies: async () => 'buvid3=guest',
    json: async (url, headers) => {
      calls.push({ url: new URL(url), headers });
      return url.includes('bilibili') ? payloads.bilibili : url.includes('douyu') ? payloads.douyu : payloads.huya;
    },
  });
  assert.deepEqual(await service.search('张大仙', 'douyin'), []);
  assert.deepEqual(await service.search('   ', 'all'), []);
  assert.equal(calls.length, 0);
  const pages = await service.search('  小 & test  ', 'all', 2);
  assert.equal(pages.length, 3);
  assert.equal(calls.find((c) => c.url.hostname.includes('douyu')).url.searchParams.get('kw'), '小 & test');
  assert.equal(calls.find((c) => c.url.hostname.includes('bilibili')).headers.Cookie, 'buvid3=guest');
  assert.equal(calls.find((c) => c.url.hostname.includes('huya')).url.searchParams.get('start'), '20');
  assert.equal(pages.find((p) => p.platform === 'bilibili').hasMore, false);
  assert.equal(parseSearchPage('douyu', payloads.douyu, 25).hasMore, false);
  assert.equal((await service.search('小', 'douyu', 26))[0].hasMore, false);
  await assert.rejects(service.search('小', 'evil'));
  await assert.rejects(service.search('小', 'all', 1.5));
  await assert.rejects(service.search('x'.repeat(51)));
});

test("one failed platform preserves other platforms and exposes a retry for the same page", async () => {
  const service = new RoomSearchService({ bilibiliCookies: async () => { throw new Error('private-cookie'); }, json: async (url) => url.includes('douyu') ? payloads.douyu : payloads.huya });
  const pages = await service.search('小');
  assert.equal(pages[0].page, 0);
  assert.ok(pages[0].error);
  assert.ok(!pages[0].error.includes('private-cookie'));
  assert.equal(pages[1].rooms[0].id, 'douyu-99999');
  assert.equal(pages[2].rooms[0].id, 'huya-688');
});

test("fuzzy search results survive local filtering; fresh offline data replaces a stale live directory row", () => {
  const remote = parseSearchPage('huya', payloads.huya, 1).rooms[0];
  const oldLive = { ...remote, status: 'live', checkedAt: 1 };
  const merged = mergeSearchRooms([oldLive], [remote], '大仙的别名');
  assert.deepEqual(merged, [remote]);
  const first = { platform: 'huya', page: 1, rooms: [oldLive], hasMore: true };
  const second = { ...first, page: 2, rooms: [remote] };
  assert.deepEqual(appendSearchPages([first], [second])[0].rooms, [remote]);
});

test("favorite lookups keep failed identities separate and detect ending a broadcast", async () => {
  const service = new RoomSearchService({ bilibiliCookies: async () => '', json: async (url) => {
    if (url.includes('betard/99999')) return { game: { tag_name: 'DNF' }, room: { room_id: 99999, nickname: '旭旭宝宝', show_status: 2 } };
    if (url.includes('roomid=688')) return { status: 200, data: { liveStatus: 'OFF', profileInfo: { profileRoom: '688', nick: '张大仙' } } };
    throw new Error('unavailable');
  } });
  const result = await service.refreshFavorites(['douyu-99999', 'huya-688', 'bilibili-21852']);
  assert.deepEqual(result.rooms.map((room) => room.status), ['offline', 'offline']);
  assert.equal(result.rooms[0].category, 'DNF');
  assert.deepEqual(result.failedIds, ['bilibili-21852']);
  await assert.rejects(service.refreshFavorites(['huya-688/../../../']));
  await assert.rejects(service.refreshFavorites(['douyin-123']));
});
