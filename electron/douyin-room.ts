import {
  browserUserAgent,
  fetchJson,
  fetchTextWithResponse,
} from "./platform-http";
import type { LiveRoom, PlaybackUrls } from "../shared/types";

const douyinOrigin = "https://live.douyin.com";
const douyinHeaders = {
  Referer: `${douyinOrigin}/`,
  "User-Agent": browserUserAgent,
};

export interface DouyinPlaybackHttp {
  fetchHome(url: string, headers: Record<string, string>): Promise<{
    response: Pick<Response, "headers">;
  }>;
  fetchRoom(url: string, headers: Record<string, string>): Promise<unknown>;
}

const defaultHttp: DouyinPlaybackHttp = {
  fetchHome: fetchTextWithResponse,
  fetchRoom: fetchJson,
};

// Category rooms contain cached stream URLs and an internal room ID. A web_rid
// from the room's website URL is required to obtain the current live session.
export function douyinWebRoomId(room: Pick<LiveRoom, "webUrl" | "url">): string {
  let url: URL;
  try {
    url = new URL(room.webUrl ?? room.url ?? "");
  } catch {
    throw new Error("抖音房间地址无效");
  }
  const match = url.pathname.match(/^\/(?:room\/)?([0-9]+)\/?$/);
  if (!match || url.hostname !== "live.douyin.com"
    || !["http:", "https:"].includes(url.protocol)
    || url.username || url.password || url.port) {
    throw new Error("抖音房间地址或房间号无效");
  }
  return match[1];
}

export async function resolveDouyinPlayback(
  room: LiveRoom,
  http: DouyinPlaybackHttp = defaultHttp,
): Promise<PlaybackUrls> {
  const webRid = douyinWebRoomId(room);
  const home = await http.fetchHome(`${douyinOrigin}/`, douyinHeaders);
  const ttwid = home.response.headers.get("set-cookie")
    ?.match(/(?:^|[;,]\s*)ttwid=([^;\s,]+)/)?.[1];
  if (!ttwid) {
    throw new Error("抖音 ttwid 获取失败");
  }

  const params = new URLSearchParams({
    aid: "6383",
    app_name: "douyin_web",
    live_id: "1",
    device_platform: "web",
    language: "zh-CN",
    enter_from: "web_live",
    cookie_enabled: "true",
    screen_width: "1920",
    screen_height: "1080",
    browser_language: "zh-CN",
    browser_platform: "Win32",
    browser_name: "Mozilla",
    browser_version: browserUserAgent,
    browser_online: "true",
    tz_name: "Asia/Shanghai",
    web_rid: webRid,
  });
  const response = await http.fetchRoom(
    `${douyinOrigin}/webcast/room/web/enter/?${params.toString()}`,
    {
      ...douyinHeaders,
      Referer: `${douyinOrigin}/${webRid}`,
      Cookie: `ttwid=${ttwid}`,
    },
  );
  return parseDouyinPlayback(response, webRid);
}

export function parseDouyinPlayback(response: unknown, webRid: string): PlaybackUrls {
  if (!/^\d+$/.test(webRid)) {
    throw new Error("抖音房间号无效");
  }
  const payload = asRecord(response);
  if (payload.status_code !== 0) {
    throw new Error("抖音直播间信息获取失败");
  }
  const rooms = asRecord(payload.data).data;
  const room = asRecord(Array.isArray(rooms) ? rooms[0] : undefined);
  if (room.status !== 2) {
    if (typeof room.status === "number") {
      throw new Error("该抖音直播已结束或尚未开播，请刷新直播列表");
    }
    throw new Error("抖音直播间状态获取失败，请刷新后重试");
  }

  const stream = asRecord(room.stream_url);
  const flv: Record<string, string> = {};
  const hls: Record<string, string> = {};
  const pull = asRecord(asRecord(stream.live_core_sdk_data).pull_data);
  const sdkStreams = asRecord(parseObject(pull.stream_data).data);
  const qualities = asRecord(pull.options).qualities;
  const qualityOptions = new Map<string, Record<string, unknown>>();
  if (Array.isArray(qualities)) {
    for (const value of qualities) {
      const quality = asRecord(value);
      if (typeof quality.sdk_key === "string") {
        qualityOptions.set(quality.sdk_key, quality);
      }
    }
  }

  const sdkQualities = Object.entries(sdkStreams)
    .filter(([key]) => !["ao", "audio"].includes(key.toLowerCase())
      && !isDisabled(qualityOptions.get(key)))
    .map(([key, value]) => {
      const variants = asRecord(value);
      const sdkParams = parseObject(asRecord(variants.main).sdk_params);
      return { key, variants, score: qualityScore(key, qualityOptions.get(key), sdkParams) };
    })
    .sort((left, right) => compareScores(left.score, right.score));

  for (const { key, variants } of sdkQualities) {
    for (const variant of ["main", "backup"]) {
      const urls = asRecord(variants[variant]);
      addStreamUrl(flv, variant === "main" ? key : `${key}_backup`, urls.flv);
      addStreamUrl(hls, variant === "main" ? key : `${key}_backup`, urls.hls);
    }
  }

  // Use legacy URLs only for formats absent from the current SDK response.
  // Never use the URLs carried by the room passed in from the category cache.
  if (Object.keys(flv).length === 0) {
    addLegacyStreams(flv, stream.flv_pull_url);
  }
  if (Object.keys(hls).length === 0) {
    addLegacyStreams(hls, stream.hls_pull_url_map);
    if (Object.keys(hls).length === 0) {
      addStreamUrl(hls, "source", stream.hls_pull_url);
    }
  }
  if (Object.keys(flv).length === 0 && Object.keys(hls).length === 0) {
    throw new Error("抖音直播间没有返回可播放的直播流，请刷新后重试");
  }

  return {
    ...(Object.keys(flv).length > 0 ? { flv } : {}),
    ...(Object.keys(hls).length > 0 ? { hls } : {}),
    headers: {
      ...douyinHeaders,
      Referer: `${douyinOrigin}/${webRid}`,
      Origin: douyinOrigin,
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") {
    return asRecord(value);
  }
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return {};
  }
}

function isDisabled(quality: Record<string, unknown> | undefined): boolean {
  return quality?.disable === 1 || quality?.disable === true
    || quality?.disabled === 1 || quality?.disabled === true;
}

function qualityScore(
  key: string,
  quality: Record<string, unknown> = {},
  sdkParams: Record<string, unknown> = {},
): number[] {
  const ranks: Record<string, number> = {
    origin: 5, original: 5, source: 5, uhd: 4, full_hd1: 4,
    hd: 3, hd1: 3, sd: 2, sd1: 2, ld: 1, sd2: 1, md: 0.5,
  };
  const resolution = sdkParams.resolution || quality.resolution;
  const match = typeof resolution === "string" ? resolution.match(/^(\d+)[xX](\d+)$/) : null;
  return [
    positiveNumber(quality.level) || ranks[key.toLowerCase()] || 0,
    positiveNumber(sdkParams.vbitrate) || positiveNumber(quality.v_bit_rate),
    match ? Number(match[1]) * Number(match[2]) : 0,
  ];
}

function positiveNumber(value: unknown): number {
  const number = typeof value === "number" || typeof value === "string" ? Number(value) : 0;
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function compareScores(left: number[], right: number[]): number {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return right[index] - left[index];
    }
  }
  return 0;
}

function addLegacyStreams(target: Record<string, string>, value: unknown): void {
  const streams = Object.entries(asRecord(value))
    .sort(([left], [right]) => compareScores(qualityScore(left), qualityScore(right)));
  for (const [key, url] of streams) {
    addStreamUrl(target, key, url);
  }
}

function addStreamUrl(target: Record<string, string>, key: string, value: unknown): void {
  if (typeof value !== "string" || !value.trim()) {
    return;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return;
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    return;
  }
  url.protocol = "https:";
  if (!Object.values(target).includes(url.href)) {
    target[key] = url.href;
  }
}
