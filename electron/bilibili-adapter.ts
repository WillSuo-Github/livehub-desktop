import { cleanText, fetchJson, mapWithConcurrency, toNumber } from "./platform-http";
import type {
  PlatformCategoryFailure,
  PlatformListResult,
  PlatformRoomData,
} from "./platform-adapter";

const areaListUrl = "https://api.live.bilibili.com/room/v1/Area/getList";
const roomListUrl = "https://api.live.bilibili.com/room/v1/area/getRoomList";
const allRoomListUrl = "https://api.live.bilibili.com/room/v3/area/getRoomList";
const requestHeaders = {
  Referer: "https://live.bilibili.com/",
};
const pageSize = 30;
const maxPagesPerArea = 100;
const allSitePageSize = 99;
const maxAllSitePages = 1_000;
const maxPageFailures = 8;
const featuredPageLimit = 3;

interface BilibiliAreaResponse {
  code: number;
  message?: string;
  data?: Array<{
    id: number;
    name: string;
    list?: Array<{
      id: number;
      name: string;
      parent_id?: number;
      parent_name?: string;
    }>;
  }>;
}

interface BilibiliRoomResponse {
  code: number;
  message?: string;
  data?: Array<{
    roomid: number;
    title?: string;
    uname?: string;
    online?: number;
    user_cover?: string;
    system_cover?: string;
    cover?: string;
    parent_name?: string;
    area_name?: string;
  }>;
}

interface BilibiliAllSiteRoomResponse {
  code: number;
  message?: string;
  data?: {
    count?: number;
    list?: Array<NonNullable<BilibiliRoomResponse["data"]>[number]>;
  };
}

interface BilibiliArea {
  id: number;
  name: string;
  parentName: string;
}

interface AreaResult {
  rooms: PlatformRoomData[];
  failure?: PlatformCategoryFailure;
}

export class BilibiliAdapter {
  async listFeaturedRooms(): Promise<PlatformListResult> {
    const pages = Array.from({ length: featuredPageLimit }, (_, index) => index + 1);
    const pageResults = await mapWithConcurrency(pages, 2, async (page) => {
      try {
        return { page, rooms: (await this.fetchAllSitePage(page)).rooms };
      } catch (error) {
        return {
          page,
          rooms: [],
          failure: {
            id: `page-${page}`,
            name: `热门第 ${page} 页`,
            error: error instanceof Error ? error.message : String(error),
          },
        };
      }
    });
    const failedPages = pageResults.flatMap((result) => result.failure ? [result.failure] : []);

    return {
      rooms: dedupeRooms(pageResults.flatMap((result) => result.rooms)),
      categoryCount: pages.length,
      successfulCategories: pages.length - failedPages.length,
      failedCategories: failedPages,
      partial: failedPages.length > 0,
      source: "bilibili-featured-pagination",
    };
  }

  async listRooms(): Promise<PlatformListResult> {
    const areas = await this.listAreas();
    try {
      return await this.listAllSiteRooms(areas.length);
    } catch (error) {
      const fallback = await this.listRoomsByAreas(areas);
      if (fallback.rooms.length > 0) {
        return fallback;
      }

      throw error;
    }
  }

  private async listAllSiteRooms(categoryCount: number): Promise<PlatformListResult> {
    const firstPage = await this.fetchAllSitePage(1);
    const totalCount = toNumber(firstPage.count);
    const totalPages = Math.min(
      maxAllSitePages,
      Math.max(1, Math.ceil(totalCount / allSitePageSize)),
    );
    const pageNumbers = Array.from({ length: totalPages - 1 }, (_, index) => index + 2);
    let pageFailureCount = 0;
    const pageResults = await mapWithConcurrency(pageNumbers, 4, async (page) => {
      if (pageFailureCount >= maxPageFailures) {
        return { page, rooms: [], skipped: true };
      }

      try {
        return { page, rooms: (await this.fetchAllSitePage(page)).rooms };
      } catch (error) {
        pageFailureCount += 1;
        return {
          page,
          rooms: [],
          failure: {
            id: `page-${page}`,
            name: `全站第 ${page} 页`,
            error: error instanceof Error ? error.message : String(error),
          },
        };
      }
    });
    const failedPages = pageResults.flatMap((result) => result.failure ? [result.failure] : []);
    const rooms = dedupeRooms([
      ...firstPage.rooms,
      ...pageResults.flatMap((result) => result.rooms),
    ]);

    return {
      rooms,
      categoryCount,
      successfulCategories: failedPages.length > 0 ? Math.max(0, categoryCount - 1) : categoryCount,
      failedCategories: failedPages,
      partial: failedPages.length > 0,
      source: "bilibili-all-site-pagination",
    };
  }

  private async fetchAllSitePage(page: number): Promise<{ count: number; rooms: PlatformRoomData[] }> {
    const params = new URLSearchParams({
      platform: "web",
      parent_area_id: "0",
      cate_id: "0",
      area_id: "0",
      sort_type: "online",
      page: String(page),
      page_size: String(allSitePageSize),
      tag_version: "1",
    });
    const response = await fetchJson<BilibiliAllSiteRoomResponse>(`${allRoomListUrl}?${params}`, requestHeaders, 10_000);
    if (response.code !== 0 || !response.data) {
      throw new Error(response.message || `Bilibili all-site page ${page} request failed`);
    }

    return {
      count: toNumber(response.data.count),
      rooms: (response.data.list ?? []).map((room) => mapRoom(room)),
    };
  }

  private async listRoomsByAreas(areas: BilibiliArea[]): Promise<PlatformListResult> {
    const results = await mapWithConcurrency(areas, 6, (area) => this.listAreaRooms(area));
    const failedCategories = results.flatMap((result) => result.failure ? [result.failure] : []);
    const rooms = dedupeRooms(results.flatMap((result) => result.rooms));

    return {
      rooms,
      categoryCount: areas.length,
      successfulCategories: areas.length - failedCategories.length,
      failedCategories,
      partial: failedCategories.length > 0,
      source: "bilibili-area-aggregation",
    };
  }

  private async listAreas(): Promise<BilibiliArea[]> {
    const response = await fetchJson<BilibiliAreaResponse>(areaListUrl, requestHeaders);
    if (response.code !== 0 || !response.data) {
      throw new Error(response.message || "Bilibili area list request failed");
    }

    const areas = response.data.flatMap((parent) => {
      const children = parent.list ?? [];
      if (children.length === 0) {
        return [{ id: parent.id, name: parent.name, parentName: parent.name }];
      }

      return children.map((child) => ({
        id: child.id,
        name: child.name,
        parentName: child.parent_name || parent.name,
      }));
    });

    return Array.from(new Map(areas.map((area) => [area.id, area])).values());
  }

  private async listAreaRooms(area: BilibiliArea): Promise<AreaResult> {
    try {
      const rooms: PlatformRoomData[] = [];
      const seenPages = new Set<string>();

      for (let page = 1; page <= maxPagesPerArea; page += 1) {
        const params = new URLSearchParams({
          area_id: String(area.id),
          sort_type: "online",
          page: String(page),
          page_size: String(pageSize),
        });
        const response = await fetchJson<BilibiliRoomResponse>(`${roomListUrl}?${params}`, requestHeaders);
        if (response.code !== 0) {
          throw new Error(response.message || `Bilibili area ${area.id} request failed`);
        }

        const pageRooms = response.data ?? [];
        const pageKey = pageRooms.map((room) => room.roomid).join(",");
        if (!pageKey || seenPages.has(pageKey)) {
          break;
        }
        seenPages.add(pageKey);
        rooms.push(...pageRooms.map((room) => mapRoom(room, area)));

        if (pageRooms.length < pageSize) {
          break;
        }
      }

      return { rooms };
    } catch (error) {
      return {
        rooms: [],
        failure: {
          id: String(area.id),
          name: `${area.parentName} / ${area.name}`,
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }
}

function mapRoom(
  room: NonNullable<BilibiliRoomResponse["data"]>[number],
  area?: BilibiliArea,
): PlatformRoomData {
  const viewers = toNumber(room.online);

  return {
    id: `bilibili-${room.roomid}`,
    title: cleanText(room.title, "哔哩哔哩直播"),
    anchor: cleanText(room.uname, "未知主播"),
    category: cleanText(room.area_name, area?.name || room.parent_name || "直播"),
    viewers,
    viewerLabel: viewers.toLocaleString("zh-CN"),
    cover: room.cover || room.user_cover || room.system_cover || "",
    webUrl: `https://live.bilibili.com/${room.roomid}`,
    status: "live",
  };
}

function dedupeRooms(rooms: PlatformRoomData[]): PlatformRoomData[] {
  return Array.from(new Map(rooms.map((room) => [room.id, room])).values())
    .sort((left, right) => right.viewers - left.viewers);
}
