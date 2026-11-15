const assert = require("node:assert/strict");
const { test } = require("node:test");
const { roomSyncMessage, fullSyncToast } = require("../dist-electron/shared/sync-status.js");
const { PlatformService } = require("../dist-electron/electron/platform-service.js");

test("limited and failed syncs never announce full completion", () => {
  assert.doesNotMatch(roomSyncMessage("full", 15, 30, { partial: false, complete: false, coverageNote: "公开分类，非全站" }), /完整同步/);
  assert.match(roomSyncMessage("full", 15, 30, { partial: true, failedCategories: [{}] }), /未完成.*1 个分类未完成/);
  assert.match(roomSyncMessage("full", 30, 30, { partial: false, complete: true }), /完整同步/);
  const info = { platforms: ["douyin"], douyin: { state: "connected", partial: false, complete: false } };
  assert.doesNotMatch(fullSyncToast(info, 30), /全量同步完成/);
  info.douyin.complete = true;
  info.douyin.partial = true;
  assert.doesNotMatch(fullSyncToast(info, 30), /全量同步完成/);
  info.douyin.partial = false;
  info.douyin.state = "error";
  assert.doesNotMatch(fullSyncToast(info, 30), /全量同步完成/);
  info.douyin.state = "connected";
  assert.match(fullSyncToast(info, 30), /全量同步完成/);
});

test("a limited full Douyin sync retains cached rooms and exposes coverage", async (t) => {
  const raw = (id) => ({ id, douyinId: id, title: id, anchor: id === "2" ? "昊天" : "Anchor", category: "Games", viewers: 100, viewerLabel: "100", cover: "", webUrl: `https://live.douyin.com/${id}`, status: "live", flvStreamUrls: {}, hlsStreamUrls: {} });
  let current = { rooms: [raw("1")], categoryCount: 1, successfulCategories: 1, partial: false, complete: false, coverageNote: "公开分类热门采样" };
  const adapter = { listFeaturedRooms: async () => current, listRooms: async () => current };
  const service = new PlatformService(adapter);
  t.after(() => service.dispose());
  service.setBackgroundFullSyncEnabled(false);
  for (const platform of ["douyu", "huya", "bilibili"]) service.adapters[platform] = { listRooms: async () => ({ rooms: [], partial: false, complete: true }) };
  await service.listRooms("douyin");
  current = { ...current, rooms: [raw("2")], pagesFetched: 2, coverageNote: "公开分类分页，非全站" };
  const rooms = await service.listRooms("all", "full");
  assert.equal(rooms.length, 2, "limited index must not delete other cached rooms");
  assert.ok(rooms.some((room) => room.anchor === "昊天"));
  const status = service.getAppInfo("test").douyin;
  assert.equal(status.complete, false);
  assert.equal(status.pagesFetched, 2);
  assert.equal(status.coverageNote, current.coverageNote);
  assert.doesNotMatch(status.message, /完整同步/);
  current = { ...current, partial: true, failedCategories: [{}] };
  await service.listRooms("all", "full");
  assert.match(service.getAppInfo("test").douyin.message, /未完成/);
});
