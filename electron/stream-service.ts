import { createHash } from "node:crypto";
import { fetchJson, fetchJsonPost, fetchJsonWithResponse, fetchText } from "./platform-http";
import type { LiveRoom, PlaybackUrls } from "../shared/types";

const douyuHeaders = {
  Referer: "https://www.douyu.com/",
};
const huyaHeaders = {
  Origin: "https://www.huya.com",
  Referer: "https://www.huya.com/",
};
const bilibiliHeaders = {
  Referer: "https://live.bilibili.com/",
};
const douyuDeviceId = "10000000000000000000000000001501";

interface DouyuEncryptionResponse {
  error: number;
  data?: {
    key: string;
    rand_str: string;
    enc_time: number;
    enc_data: string;
    is_special: number;
  } | null;
}

interface DouyuPlayResponse {
  error: number;
  msg?: string;
  data?: {
    rtmp_url?: string;
    rtmp_live?: string;
  } | null;
}

interface HuyaStreamInfo {
  sCdnType?: string;
  sStreamName?: string;
  sFlvUrl?: string;
  sFlvUrlSuffix?: string;
  sFlvAntiCode?: string;
}

interface HuyaPlayerConfig {
  data?: Array<{
    gameStreamInfoList?: HuyaStreamInfo[];
  }>;
  vMultiStreamInfo?: Array<{
    iBitRate?: number | string;
  }>;
}

interface BilibiliPlayUrlResponse {
  code: number;
  message?: string;
  data?: {
    durl?: Array<{ url?: string }>;
  };
}

interface BilibiliPlayInfoResponse {
  code: number;
  message?: string;
  data?: {
    playurl_info?: {
      playurl?: {
        stream?: BilibiliStream[];
      };
    };
  };
}

interface BilibiliStream {
  protocol_name?: string;
  format?: Array<{
    format_name?: string;
    codec?: Array<{
      codec_name?: string;
      base_url?: string;
      url_info?: Array<{
        host?: string;
        extra?: string;
      }>;
    }>;
  }>;
}

export class StreamService {
  async resolve(room: LiveRoom): Promise<PlaybackUrls> {
    switch (room.platform) {
      case "douyin":
        return room.playback ?? {};
      case "douyu":
        return this.resolveDouyu(room);
      case "huya":
        return this.resolveHuya(room);
      case "bilibili":
        return this.resolveBilibili(room);
    }
  }

  private async resolveDouyu(room: LiveRoom): Promise<PlaybackUrls> {
    const roomId = extractRoomId(room, /^https?:\/\/(?:www\.)?douyu\.com\/(?:topic\/)?(\d+)/, "douyu-");
    if (!/^\d+$/.test(roomId)) {
      throw new Error("斗鱼房间号无效");
    }

    const encryptionResult = await fetchJsonWithResponse<DouyuEncryptionResponse>(
      `https://www.douyu.com/wgapi/livenc/liveweb/websec/getEncryption?did=${encodeURIComponent(douyuDeviceId)}`,
      douyuHeaders,
    );
    const encryption = encryptionResult.data;
    if (encryption.error !== 0 || !encryption.data) {
      throw new Error("斗鱼加密参数获取失败");
    }

    const responseDate = encryptionResult.response.headers.get("date");
    const parsedDate = responseDate ? Date.parse(responseDate) : Number.NaN;
    const timestamp = Number.isFinite(parsedDate)
      ? Math.floor(parsedDate / 1000)
      : Math.floor(Date.now() / 1000);
    const auth = computeDouyuAuth(
      roomId,
      timestamp,
      encryption.data.key,
      encryption.data.rand_str,
      encryption.data.enc_time,
      encryption.data.is_special,
    );
    const body = new URLSearchParams({
      enc_data: encryption.data.enc_data,
      tt: String(timestamp),
      did: douyuDeviceId,
      auth,
      cdn: "",
      rate: "0",
      hevc: "0",
      fa: "0",
      ive: "0",
    });
    const playResponse = await fetchJsonPost<DouyuPlayResponse>(
      `https://www.douyu.com/lapi/live/getH5PlayV1/${roomId}`,
      body.toString(),
      {
        ...douyuHeaders,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    );
    const playData = playResponse.data;
    if (playResponse.error !== 0 || !playData?.rtmp_url || !playData.rtmp_live) {
      throw new Error(playResponse.msg || "斗鱼直连流获取失败");
    }

    return {
      flv: {
        source: joinStreamUrl(playData.rtmp_url, playData.rtmp_live),
      },
    };
  }

  private async resolveHuya(room: LiveRoom): Promise<PlaybackUrls> {
    if (!room.webUrl) {
      throw new Error("虎牙房间地址无效");
    }

    const html = await fetchText(room.webUrl, huyaHeaders);
    const playerConfig = extractHuyaPlayerConfig(html);
    const streamInfoList = playerConfig?.data?.[0]?.gameStreamInfoList ?? [];
    if (streamInfoList.length === 0) {
      throw new Error("虎牙页面没有返回直播流参数");
    }

    const bitRates = playerConfig?.vMultiStreamInfo
      ?.map((item) => toNumber(item.iBitRate))
      .filter((bitRate) => bitRate >= 0) ?? [];
    const selectedBitRates = bitRates.length > 0 ? bitRates : [0];
    const flv: Record<string, string> = {};

    for (const streamInfo of streamInfoList) {
      if (!streamInfo.sCdnType || !streamInfo.sStreamName || !streamInfo.sFlvUrl) {
        continue;
      }

      const antiCode = new URLSearchParams(decodeHtmlEntities(streamInfo.sFlvAntiCode ?? ""));
      for (const bitRate of selectedBitRates) {
        const streamUrl = buildHuyaStreamUrl(streamInfo, antiCode, bitRate);
        if (!streamUrl) {
          continue;
        }

        const quality = bitRate === 0 ? "source" : `${bitRate}k`;
        setUniqueUrl(flv, `${streamInfo.sCdnType.toLowerCase()}_${quality}`, streamUrl);
      }
    }

    if (Object.keys(flv).length === 0) {
      throw new Error("虎牙没有返回可播放的直播流");
    }

    return { flv };
  }

  private async resolveBilibili(room: LiveRoom): Promise<PlaybackUrls> {
    const roomId = extractRoomId(room, /^https?:\/\/live\.bilibili\.com\/(\d+)/, "bilibili-");
    if (!/^\d+$/.test(roomId)) {
      throw new Error("哔哩哔哩房间号无效");
    }

    try {
      const response = await fetchJson<BilibiliPlayUrlResponse>(
        `https://api.live.bilibili.com/room/v1/Room/playUrl?cid=${encodeURIComponent(roomId)}&platform=web&quality=4`,
        bilibiliHeaders,
      );
      const urls = (response.data?.durl ?? [])
        .map((item) => item.url)
        .filter((url): url is string => Boolean(url && url.trim()));
      if (response.code === 0 && urls.length > 0) {
        return {
          flv: Object.fromEntries(urls.map((url, index) => [`source-${index + 1}`, url])),
        };
      }
    } catch {
      // The v2 play-info endpoint below is the fallback for transient v1 failures.
    }

    const params = new URLSearchParams({
      room_id: roomId,
      no_playurl: "0",
      mask: "1",
      qn: "0",
      platform: "web",
      protocol: "0,1",
      format: "0,1,2",
      codec: "0,1,2",
      dolby: "5",
      panorama: "1",
    });
    const response = await fetchJson<BilibiliPlayInfoResponse>(
      `https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo?${params}`,
      bilibiliHeaders,
    );
    if (response.code !== 0) {
      throw new Error(response.message || "哔哩哔哩直连流获取失败");
    }

    const hls: Record<string, string> = {};
    for (const stream of response.data?.playurl_info?.playurl?.stream ?? []) {
      if (stream.protocol_name !== "http_hls") {
        continue;
      }
      for (const format of stream.format ?? []) {
        if (format.format_name !== "fmp4" && format.format_name !== "ts") {
          continue;
        }
        for (const codec of format.codec ?? []) {
          if (codec.codec_name !== "avc" || !codec.base_url) {
            continue;
          }
          for (const urlInfo of codec.url_info ?? []) {
            if (!urlInfo.host) {
              continue;
            }
            const url = `${urlInfo.host}${codec.base_url}${urlInfo.extra ?? ""}`;
            setUniqueUrl(hls, `${format.format_name}-${hlsCount(hls) + 1}`, url);
          }
        }
      }
    }

    if (Object.keys(hls).length === 0) {
      throw new Error("哔哩哔哩没有返回可播放的直播流");
    }
    return { hls };
  }
}

function computeDouyuAuth(
  roomId: string,
  timestamp: number,
  key: string,
  randomString: string,
  encryptionRounds: number,
  isSpecial: number,
): string {
  const suffix = isSpecial === 1 ? "" : `${roomId}${timestamp}`;
  let value = randomString;
  for (let index = 0; index < encryptionRounds; index += 1) {
    value = md5(`${value}${key}`);
  }
  return md5(`${value}${key}${suffix}`);
}

function extractHuyaPlayerConfig(html: string): HuyaPlayerConfig | null {
  const configIndex = html.indexOf("var hyPlayerConfig");
  const markerIndex = configIndex < 0 ? -1 : html.indexOf("stream", configIndex);
  if (markerIndex < 0) {
    return null;
  }

  const colonIndex = html.indexOf(":", markerIndex);
  if (colonIndex < 0) {
    return null;
  }

  let valueStart = colonIndex + 1;
  while (/\s/.test(html[valueStart] ?? "")) {
    valueStart += 1;
  }

  try {
    const raw = html[valueStart] === '"'
      ? Buffer.from(readQuotedValue(html, valueStart), "base64").toString("utf8")
      : readBalancedObject(html, valueStart);
    if (!raw) {
      return null;
    }
    return JSON.parse(raw) as HuyaPlayerConfig;
  } catch {
    return null;
  }
}

function readQuotedValue(source: string, start: number): string {
  let value = "";
  let escaped = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      value += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') {
      return value;
    }
    value += character;
  }
  throw new Error("unterminated quoted value");
}

function readBalancedObject(source: string, start: number): string | null {
  if (source[start] !== "{") {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }
  return null;
}

function buildHuyaStreamUrl(
  streamInfo: HuyaStreamInfo,
  antiCode: URLSearchParams,
  bitRate: number,
): string | null {
  const streamName = streamInfo.sStreamName;
  const flvUrl = streamInfo.sFlvUrl;
  if (!streamName || !flvUrl) {
    return null;
  }

  const fm = antiCode.get("fm");
  if (!fm) {
    return null;
  }

  let secretPrefix: string;
  try {
    secretPrefix = Buffer.from(decodeURIComponent(fm), "base64").toString("utf8").split("_")[0];
  } catch {
    return null;
  }
  if (!secretPrefix) {
    return null;
  }

  const uid = Math.floor(Math.random() * 1_000_000) + 12_340_000;
  const convertedUid = ((uid << 8) | (uid >>> 24)) >>> 0;
  const timestamp = Date.now();
  const sequenceId = uid + timestamp;
  const ctype = antiCode.get("ctype") || "huya_live";
  const wsTime = antiCode.get("wsTime") || "";
  const wsSecretHash = md5(`${sequenceId}|${ctype}|100`);
  const wsSecret = md5(`${secretPrefix}_${convertedUid}_${streamName}_${wsSecretHash}_${wsTime}`);
  const baseUrl = flvUrl.replace(/^http:\/\//i, "https://").replace(/\/+$/, "");
  const suffix = streamInfo.sFlvUrlSuffix ? `.${streamInfo.sFlvUrlSuffix}` : "";
  const url = new URL(`${baseUrl}/${streamName}${suffix}`);
  const params: Record<string, string | number> = {
    wsSecret,
    wsTime,
    ctype,
    fs: antiCode.get("fs") || "",
    seqid: sequenceId,
    u: convertedUid,
    sdk_sid: timestamp,
    ratio: bitRate,
    t: 100,
    ver: 1,
    sv: 2_401_090_219,
    codec: 264,
  };
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function extractRoomId(room: LiveRoom, urlPattern: RegExp, prefix: string): string {
  const urlMatch = room.webUrl?.match(urlPattern);
  return urlMatch?.[1] ?? room.id.replace(prefix, "");
}

function joinStreamUrl(baseUrl: string, streamPath: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${streamPath.replace(/^\/+/, "")}`;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)));
}

function hlsCount(values: Record<string, string>): number {
  return Object.keys(values).length;
}

function md5(value: string): string {
  return createHash("md5").update(value).digest("hex");
}

function setUniqueUrl(values: Record<string, string>, key: string, url: string): void {
  let uniqueKey = key;
  let suffix = 2;
  while (values[uniqueKey]) {
    uniqueKey = `${key}-${suffix}`;
    suffix += 1;
  }
  values[uniqueKey] = url;
}

function toNumber(value: unknown): number {
  const normalized = typeof value === "string" ? value.replace(/,/g, "") : value;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : 0;
}
