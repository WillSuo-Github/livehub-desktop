import type { FavoriteRoomsRefresh, LiveRoom, PlatformId, RoomSearchPage, SearchPlatformId } from "../shared/types";
import { browserUserAgent, mapWithConcurrency } from "./platform-http";
import { fetchDouyinRoom, parseDouyinFavorite, type DouyinPlaybackHttp } from "./douyin-room";

type JsonObject = Record<string, unknown>;
const supportedPlatforms: SearchPlatformId[] = ["bilibili", "douyu", "huya"];
const pageSize = 20;
const origins: Record<SearchPlatformId, string> = {
  bilibili: "https://live.bilibili.com/", douyu: "https://www.douyu.com/", huya: "https://www.huya.com/",
};
const labels: Record<SearchPlatformId, string> = { bilibili: "B 站", douyu: "斗鱼", huya: "虎牙" };

export interface SearchHttp {
  json(url: string, headers: Record<string, string>): Promise<unknown>;
  bilibiliCookies(): Promise<string>;
  resetBilibiliCookies?(): void;
}

class PublicSearchHttp implements SearchHttp {
  private cookies: Promise<string> | null = null;
  private cookiesAt = 0;

  resetBilibiliCookies(): void { this.cookies = null; }

  async json(url: string, headers: Record<string, string>): Promise<unknown> {
    const response = await fetch(url, {
      headers: { "User-Agent": browserUserAgent, Accept: "application/json, text/plain, */*", ...headers },
      signal: AbortSignal.timeout(12_000),
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  bilibiliCookies(): Promise<string> {
    if (!this.cookies || Date.now() - this.cookiesAt > 30 * 60_000) {
      this.cookiesAt = Date.now();
      const pending = (async () => {
        const response = await fetch("https://www.bilibili.com/", {
          headers: { "User-Agent": browserUserAgent }, signal: AbortSignal.timeout(12_000),
        });
        await response.body?.cancel();
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const cookies = response.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ");
        if (!cookies.includes("buvid3=")) throw new Error("Bilibili guest session unavailable");
        return cookies;
      })();
      this.cookies = pending;
      void pending.catch(() => { if (this.cookies === pending) this.cookies = null; });
    }
    return this.cookies;
  }
}

export class RoomSearchService {
  constructor(
    private readonly http: SearchHttp = new PublicSearchHttp(),
    private readonly douyinHttp: DouyinPlaybackHttp = {
      fetchHome: async (url, headers) => {
        const response = await fetch(url, { headers, signal: AbortSignal.timeout(12_000), cache: "no-store" });
        await response.body?.cancel();
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return { response };
      },
      fetchRoom: (url, headers) => this.http.json(url, headers),
    },
  ) {}

  async search(query: string, platform: PlatformId | "all" = "all", page = 1): Promise<RoomSearchPage[]> {
    if (typeof query !== "string" || query.trim().length > 50 || !Number.isInteger(page) || page < 1 || page > 50
      || !["all", "douyin", ...supportedPlatforms].includes(platform)) throw new Error("搜索参数无效。");
    const keyword = query.trim();
    if (!keyword || platform === "douyin") return [];
    const platforms = platform === "all" ? supportedPlatforms : [platform as SearchPlatformId];
    return Promise.all(platforms.map(async (target): Promise<RoomSearchPage> => {
      try {
        return await this.searchPlatform(keyword, target, page);
      } catch {
        if (target === "bilibili") this.http.resetBilibiliCookies?.();
        return { platform: target, page: page - 1, rooms: [], hasMore: false, error: `${labels[target]}搜索暂不可用，请重试。` };
      }
    }));
  }

  private async searchPlatform(keyword: string, platform: SearchPlatformId, page: number): Promise<RoomSearchPage> {
    const headers = { Referer: origins[platform] };
    if (platform === "bilibili") {
      const url = apiUrl("https://api.bilibili.com/x/web-interface/search/type", {
        search_type: "live_user", keyword, page, page_size: pageSize, highlight: 0, cover_type: "user_cover",
      });
      const data = await this.http.json(url, { ...headers, Cookie: await this.http.bilibiliCookies() });
      return parseSearchPage(platform, data, page);
    }
    if (platform === "douyu") {
      if (page > 25) return { platform, page, rooms: [], hasMore: false };
      const url = apiUrl("https://www.douyu.com/japi/search/api/searchUser", { kw: keyword, page, pageSize, filterType: 1 });
      return parseSearchPage(platform, await this.http.json(url, headers), page);
    }
    const url = apiUrl("https://search.cdn.huya.com/", {
      m: "Search", do: "getSearchContent", q: keyword, uid: 0, v: 1, typ: -5, livestate: 0,
      rows: pageSize, start: (page - 1) * pageSize,
    });
    return parseSearchPage(platform, await this.http.json(url, headers), page);
  }

  async refreshFavorites(ids: string[]): Promise<FavoriteRoomsRefresh> {
    if (!Array.isArray(ids) || ids.length > 100 || !ids.every((id) => typeof id === "string"
      && /^(bilibili|douyu|huya|douyin-web)-\d{1,20}$/.test(id))) throw new Error("收藏房间参数无效。");
    const results = await mapWithConcurrency([...new Set(ids)], 3, async (id) => {
      try { return { id, room: await this.lookupRoom(id) }; } catch { return { id }; }
    });
    return { rooms: results.flatMap((item) => item.room ? [item.room] : []), failedIds: results.filter((item) => !item.room).map((item) => item.id) };
  }

  private async lookupRoom(id: string): Promise<LiveRoom> {
    if (id.startsWith("douyin-web-")) {
      const webRid = id.slice("douyin-web-".length);
      return parseDouyinFavorite(await fetchDouyinRoom(webRid, this.douyinHttp), webRid);
    }
    const [platform, roomId] = id.split("-") as [SearchPlatformId, string];
    const headers = { Referer: origins[platform] };
    if (platform === "bilibili") {
      const payload = object(await this.http.json(apiUrl("https://api.live.bilibili.com/room/v1/Room/get_info", { room_id: roomId }), headers));
      checkCode(payload, "code");
      const info = object(payload.data);
      if (text(info.room_id) !== roomId) throw new Error("Room identity mismatch");
      const statusPayload = object(await this.http.json(apiUrl("https://api.live.bilibili.com/room/v1/Room/get_status_info_by_uids", { "uids[]": text(info.uid) }), headers));
      checkCode(statusPayload, "code");
      const anchor = object(object(statusPayload.data)[text(info.uid)]);
      if (text(anchor.room_id) !== roomId) throw new Error("Anchor identity mismatch");
      return makeRoom(platform, roomId, {
        anchor: anchor.uname, title: info.title, category: info.area_name || info.parent_area_name,
        cover: info.user_cover || info.keyframe || anchor.face, status: bilibiliStatus(info.live_status), viewers: info.online,
      });
    }
    if (platform === "douyu") {
      const payload = object(await this.http.json(`https://www.douyu.com/betard/${roomId}`, headers));
      const info = object(payload.room);
      if (text(info.room_id) !== roomId || !["1", "2"].includes(text(info.show_status))) throw new Error("Invalid room detail");
      return makeRoom(platform, roomId, {
        anchor: info.nickname, title: info.room_name, category: object(payload.game).tag_name,
        cover: info.room_pic || info.avatar_mid,
        status: text(info.show_status) === "1" && text(info.videoLoop) !== "1" && !text(info.room_name).startsWith("【回放】") ? "live" : "offline",
      });
    }
    const payload = object(await this.http.json(apiUrl("https://mp.huya.com/cache.php", { m: "Live", do: "profileRoom", roomid: roomId }), headers));
    if (Number(payload.status) !== 200) throw new Error("Invalid room detail");
    const data = object(payload.data); const profile = object(data.profileInfo); const info = object(data.liveData);
    if (text(profile.profileRoom) !== roomId || !["ON", "OFF", "OFFLINE", "CLOSED", "REPLAY"].includes(text(data.liveStatus))) throw new Error("Invalid room state");
    return makeRoom(platform, roomId, {
      anchor: profile.nick, title: info.introduction || info.roomName, category: info.gameFullName,
      cover: info.screenshot || profile.avatar180, viewers: info.totalCount, status: data.liveStatus === "ON" ? "live" : "offline",
    });
  }
}

export function parseSearchPage(platform: SearchPlatformId, response: unknown, page: number): RoomSearchPage {
  const root = object(response);
  let docs: unknown[]; let total: number; let maxPages = 50;
  if (platform === "bilibili") {
    checkCode(root, "code"); const data = object(root.data);
    docs = array(data.result); total = Number(data.numResults);
    maxPages = Math.min(50, Number(data.numPages) || 0);
  } else if (platform === "douyu") {
    checkCode(root, "error"); const data = object(root.data);
    docs = array(data.relateUser).map((item) => object(item).anchorInfo); total = Number(data.total); maxPages = 25;
  } else {
    const data = object(object(root.response)["1"]);
    docs = array(data.docs); total = Number(data.numFound);
  }
  if (!Number.isFinite(total)) throw new Error("Invalid search response");
  const unique = new Map<string, LiveRoom>();
  for (const raw of docs) {
    const item = object(raw);
    const id = text(platform === "bilibili" ? item.roomid : platform === "douyu" ? item.rid : item.room_id);
    if (!/^\d{1,20}$/.test(id) || /^0+$/.test(id)) continue;
    const status = platform === "bilibili" ? bilibiliStatus(item.live_status)
      : platform === "douyu" ? douyuStatus(item)
        : item.gameLiveOn === true || item.gameLiveOn === 1 ? "live" : item.gameLiveOn === false || item.gameLiveOn === 0 ? "offline" : "unknown";
    const room = makeRoom(platform, id, {
      anchor: platform === "bilibili" ? item.uname : platform === "douyu" ? item.nickName : item.game_nick,
      title: platform === "douyu" ? item.description : platform === "huya" ? item.live_intro : undefined,
      category: platform === "bilibili" ? item.cate_name : platform === "douyu" ? item.cateName : item.game_name,
      cover: platform === "bilibili" ? item.uface : platform === "douyu" ? item.avatar : item.game_avatarUrl180,
      status,
    });
    unique.set(room.id, room);
  }
  return { platform, page, rooms: [...unique.values()], hasMore: docs.length > 0 && page < maxPages && page * pageSize < total };
}

function makeRoom(platform: SearchPlatformId, id: string, data: JsonObject): LiveRoom {
  const anchor = plainText(data.anchor) || `${labels[platform]}主播`;
  const image = safeImage(data.cover);
  const category = plainText(data.category) || "直播";
  const status = data.status as LiveRoom["status"];
  return {
    id: `${platform}-${id}`, platform, anchor, title: plainText(data.title) || `${anchor}的直播间`,
    category, tags: category === "直播" ? [] : [category], status,
    viewers: status === "live" ? Math.max(0, Number(data.viewers) || 0) : 0,
    // Anchor search returns follower counts, not audience counts.
    audienceMetric: "heat", viewerLabel: data.viewers === undefined ? "—" : undefined,
    cover: image ? `url(${JSON.stringify(image)}) center center / cover no-repeat` : "linear-gradient(135deg, #24334b, #695185)",
    updatedAt: "刚刚", checkedAt: Date.now(), webUrl: origins[platform] + id,
  };
}

function bilibiliStatus(value: unknown): LiveRoom["status"] {
  return text(value) === "1" ? "live" : ["0", "2"].includes(text(value)) ? "offline" : "unknown";
}
function douyuStatus(item: JsonObject): LiveRoom["status"] {
  if (text(item.isLive) === "2") return "offline";
  if (text(item.isLive) === "1") return Number(item.roomType ?? 0) === 0 ? "live" : "offline";
  return "unknown";
}
function checkCode(data: JsonObject, key: string): void { if (Number(data[key]) !== 0) throw new Error("Platform request failed"); }
function object(value: unknown): JsonObject { return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {}; }
function array(value: unknown): unknown[] { if (!Array.isArray(value)) throw new Error("Missing search results"); return value; }
function text(value: unknown): string { return typeof value === "string" || typeof value === "number" ? String(value) : ""; }
function plainText(value: unknown): string {
  return text(value).replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
}
function safeImage(value: unknown): string {
  try { const url = new URL(text(value).replace(/^\/\//, "https://")); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : ""; } catch { return ""; }
}
function apiUrl(base: string, params: Record<string, string | number>): string { return `${base}?${new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)]))}`; }
