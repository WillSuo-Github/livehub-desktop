import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import type { AddressInfo, Server } from "node:net";
import type { Duplex } from "node:stream";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import {
  browserUserAgent,
  fetchJson,
  fetchText,
  fetchTextWithResponse,
} from "./platform-http";
import type {
  DanmakuEvent,
  DanmakuHello,
  DanmakuKind,
  DanmakuKindFilter,
  DanmakuMetadataValue,
  DanmakuSender,
  LiveRoom,
  PlatformId,
} from "../shared/types";
import {
  allowsDanmakuEvent,
  defaultDanmakuKindFilter,
  normalizeDanmakuKindFilter,
} from "../shared/danmaku";

const localHost = "127.0.0.1";
const danmakuPathPrefix = "/v1/danmaku/";
const maxWebSocketPayload = 64 * 1024;
const reconnectDelaysMs = [1_000, 2_000, 5_000, 10_000, 20_000];
const wbiMixinKeyTable = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];
const wbiKeyCacheTTL = 24 * 60 * 60 * 1000;

let wbiKeysCache: { imgKey: string; subKey: string; expiresAt: number } | null = null;

const bilibiliHeaders = {
  Referer: "https://live.bilibili.com/",
  "User-Agent": browserUserAgent,
};

const huyaPageHeaders = {
  Referer: "https://www.huya.com/",
  "User-Agent": browserUserAgent,
};

const huyaWebSocketHeaders = {
  Origin: "https://www.huya.com",
  Referer: "https://www.huya.com/",
  "User-Agent": browserUserAgent,
};

const douyinHeaders = {
  Referer: "https://live.douyin.com/",
  "User-Agent": browserUserAgent,
};

const douyinWebSocketHeaders = {
  Origin: "https://live.douyin.com",
  Referer: "https://live.douyin.com/",
  "User-Agent": browserUserAgent,
};

const douyinWebcastHost = "webcast100-ws-web-lq.douyin.com";
const douyinWebcastSdkVersion = "1.0.14-beta.0";
const douyinSignatureAlphabet = "Dkdpgh4ZKsQB80/Mfvw36XI1R25+WUAlEi7NLboqYTOPuzmFjJnryx9HVGcaStCe";
const douyinStandardBase64Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const douyinSignatureKeys = [
  "live_id",
  "aid",
  "version_code",
  "webcast_sdk_version",
  "room_id",
  "sub_room_id",
  "sub_channel_id",
  "did_rule",
  "user_unique_id",
  "device_platform",
  "device_type",
  "ac",
  "identity",
] as const;

export interface DanmakuSessionHandle {
  url: string;
  dispose(): void;
}

interface DanmakuConnection {
  close(): void;
}

type DanmakuEmitter = (event: DanmakuEvent) => void;

interface DanmakuSessionCallbacks {
  onClosed(token: string): void;
  kindFilter(): DanmakuKindFilter;
}

interface BilibiliDanmakuInfoResponse {
  code: number;
  message?: string;
  data?: {
    token?: string;
    host_list?: Array<{
      host?: string;
      port?: number;
      wss_port?: number;
    }>;
  };
}

interface BilibiliNavigationResponse {
  code: number;
  data?: {
    wbi_img?: {
      img_url?: string;
      sub_url?: string;
    };
  };
}

interface BilibiliPacket {
  packetLength: number;
  headerLength: number;
  version: number;
  operation: number;
  body: Buffer;
}

export class DanmakuService {
  private server: Server | null = null;
  private webSocketServer: WebSocketServer | null = null;
  private serverPortPromise: Promise<number> | null = null;
  private readonly sessions = new Map<string, DanmakuSession>();
  private kindFilter: DanmakuKindFilter = { ...defaultDanmakuKindFilter };

  getKindFilter(): DanmakuKindFilter {
    return { ...this.kindFilter };
  }

  // Applies to running sessions as well, so a settings change takes effect during playback.
  setKindFilter(filter: unknown): DanmakuKindFilter {
    this.kindFilter = normalizeDanmakuKindFilter(filter);
    return this.getKindFilter();
  }

  async createSession(room: LiveRoom): Promise<DanmakuSessionHandle> {
    const port = await this.ensureServer();
    const token = randomBytes(24).toString("hex");
    const session = new DanmakuSession(token, room, {
      onClosed: (closedToken) => {
        if (this.sessions.get(closedToken) === session) {
          this.sessions.delete(closedToken);
        }
      },
      kindFilter: () => this.kindFilter,
    });
    this.sessions.set(token, session);

    return {
      url: `ws://${localHost}:${port}${danmakuPathPrefix}${token}`,
      dispose: () => this.disposeSession(token),
    };
  }

  dispose(): void {
    for (const session of this.sessions.values()) {
      session.dispose();
    }
    this.sessions.clear();
    this.webSocketServer?.close();
    this.webSocketServer = null;
    this.server?.close();
    this.server = null;
    this.serverPortPromise = null;
  }

  private disposeSession(token: string): void {
    const session = this.sessions.get(token);
    if (!session) {
      return;
    }
    session.dispose();
    this.sessions.delete(token);
  }

  private async ensureServer(): Promise<number> {
    if (this.serverPortPromise) {
      return this.serverPortPromise;
    }

    const server = createServer();
    const webSocketServer = new WebSocketServer({
      noServer: true,
      maxPayload: maxWebSocketPayload,
      clientTracking: false,
    });
    this.server = server;
    this.webSocketServer = webSocketServer;

    server.on("upgrade", (request, socket, head) => {
      this.handleUpgrade(request, socket, head);
    });

    this.serverPortPromise = new Promise<number>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off("listening", onListening);
        this.serverPortPromise = null;
        reject(error);
      };
      const onListening = (): void => {
        server.off("error", onError);
        const address = server.address() as AddressInfo | null;
        if (!address || typeof address === "string") {
          this.serverPortPromise = null;
          reject(new Error("弹幕本地服务没有返回端口。"));
          return;
        }
        resolve(address.port);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(0, localHost);
    });

    try {
      return await this.serverPortPromise;
    } catch (error) {
      server.close();
      this.server = null;
      this.webSocketServer = null;
      throw error;
    }
  }

  private handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void {
    const requestURL = new URL(request.url ?? "/", `http://${localHost}`);
    if (!requestURL.pathname.startsWith(danmakuPathPrefix)) {
      socket.destroy();
      return;
    }

    const token = requestURL.pathname.slice(danmakuPathPrefix.length).split("/")[0];
    const session = this.sessions.get(token);
    if (!session || !this.webSocketServer) {
      socket.destroy();
      return;
    }

    this.webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      session.attach(webSocket);
    });
  }
}

class DanmakuSession {
  private client: WebSocket | null = null;
  private connection: DanmakuConnection | null = null;
  private started = false;
  private disposed = false;

  constructor(
    private readonly token: string,
    private readonly room: LiveRoom,
    private readonly callbacks: DanmakuSessionCallbacks,
  ) {}

  attach(client: WebSocket): void {
    if (this.disposed) {
      client.close(1000, "session expired");
      return;
    }

    this.client?.close(1000, "replaced");
    this.client = client;
    client.on("close", () => {
      if (this.client === client) {
        this.dispose();
      }
    });
    client.on("error", () => {
      // The close event performs session cleanup. Avoid surfacing socket errors to the UI.
    });
    client.on("message", (message) => {
      if (message.toString() === "ping") {
        client.send("pong");
      }
    });

    const supported = this.room.platform === "douyin"
      || this.room.platform === "bilibili"
      || this.room.platform === "douyu"
      || this.room.platform === "huya";
    this.send({
      type: "hello",
      version: 1,
      platform: this.room.platform,
      roomId: roomIdentifier(this.room),
      supported,
      message: supported ? undefined : `${platformLabel(this.room.platform)}弹幕适配器还在接入中。`,
    });

    if (!this.started) {
      this.started = true;
      void this.startConnection();
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.connection?.close();
    this.connection = null;
    this.client?.close(1000, "session closed");
    this.client = null;
    this.callbacks.onClosed(this.token);
  }

  private async startConnection(): Promise<void> {
    try {
      const connection = await createDanmakuConnection(this.room, (event) => this.send(event));
      if (this.disposed) {
        connection.close();
        return;
      }
      this.connection = connection;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.send(createEvent(this.room, "system", `弹幕连接失败：${message.slice(0, 120)}`));
    }
  }

  private send(message: DanmakuEvent | DanmakuHello): void {
    if (!this.client || this.client.readyState !== WebSocket.OPEN) {
      return;
    }
    if (!("type" in message) && !allowsDanmakuEvent(message, this.callbacks.kindFilter())) {
      return;
    }
    this.client.send(JSON.stringify(message));
  }
}

async function createDanmakuConnection(
  room: LiveRoom,
  emit: DanmakuEmitter,
): Promise<DanmakuConnection> {
  switch (room.platform) {
    case "douyin":
      return createDouyinConnection(room, emit);
    case "bilibili":
      return createBilibiliConnection(room, emit);
    case "douyu":
      return createDouyuConnection(room, emit);
    case "huya":
      return createHuyaConnection(room, emit);
  }
}

async function createBilibiliConnection(
  room: LiveRoom,
  emit: DanmakuEmitter,
): Promise<DanmakuConnection> {
  const roomId = roomIdentifier(room);
  if (!/^\d+$/.test(roomId)) {
    throw new Error("哔哩哔哩房间号无效");
  }

  const params = new URLSearchParams({
    id: roomId,
    type: "0",
    web_location: "444.8",
  });
  const signature = await signBilibiliParameters(params);
  params.set("wts", String(signature.wts));
  params.set("w_rid", signature.wRid);
  const response = await fetchJson<BilibiliDanmakuInfoResponse>(
    `https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?${params.toString()}`,
    bilibiliHeaders,
  );
  const host = response.data?.host_list?.find((item) => item.host && (item.wss_port || item.port));
  const token = response.data?.token;
  if (response.code !== 0 || !host?.host || !token) {
    throw new Error(response.message || "哔哩哔哩弹幕服务参数获取失败");
  }

  const port = host.wss_port || host.port || 443;
  const url = `wss://${host.host}:${port}/sub`;
  const connection = new BilibiliConnection(url, room, roomId, token, emit);
  connection.start();
  return connection;
}

class BilibiliConnection implements DanmakuConnection {
  private socket: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private packetBuffer = Buffer.alloc(0);
  private reconnectAttempt = 0;
  private closed = false;

  constructor(
    private readonly url: string,
    private readonly room: LiveRoom,
    private readonly roomId: string,
    private readonly token: string,
    private readonly emit: DanmakuEmitter,
  ) {}

  start(): void {
    void this.connect();
  }

  close(): void {
    this.closed = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close(1000, "session closed");
    this.socket = null;
  }

  private async connect(): Promise<void> {
    if (this.closed) {
      return;
    }

    try {
      const socket = new WebSocket(this.url, {
        headers: bilibiliHeaders,
        handshakeTimeout: 10_000,
      });
      socket.binaryType = "nodebuffer";
      this.socket = socket;
      socket.once("open", () => {
        this.reconnectAttempt = 0;
        socket.send(encodeBilibiliPacket(7, Buffer.from(JSON.stringify({
          uid: 0,
          roomid: Number(this.roomId),
          protover: 3,
          buvid: "",
          platform: "web",
          type: 2,
          key: this.token,
        }), "utf8")));
        this.heartbeatTimer = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(encodeBilibiliPacket(2, Buffer.alloc(0)));
          }
        }, 30_000);
      });
      socket.on("message", (data) => this.handleMessage(data));
      socket.once("close", () => {
        if (this.heartbeatTimer) {
          clearInterval(this.heartbeatTimer);
          this.heartbeatTimer = null;
        }
        if (this.socket === socket) {
          this.socket = null;
        }
        this.scheduleReconnect();
      });
      socket.once("error", () => {
        // The close callback owns reconnect handling.
      });
    } catch {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) {
      return;
    }
    const delay = reconnectDelaysMs[Math.min(this.reconnectAttempt, reconnectDelaysMs.length - 1)];
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private handleMessage(data: RawData): void {
    this.packetBuffer = Buffer.concat([this.packetBuffer, rawDataToBuffer(data)]);
    if (this.packetBuffer.length > 4 * 1024 * 1024) {
      this.packetBuffer = Buffer.alloc(0);
      return;
    }

    while (this.packetBuffer.length >= 16) {
      const packetLength = this.packetBuffer.readUInt32BE(0);
      if (packetLength < 16 || packetLength > 4 * 1024 * 1024) {
        this.packetBuffer = Buffer.alloc(0);
        return;
      }
      if (this.packetBuffer.length < packetLength) {
        return;
      }

      const packet = this.packetBuffer.subarray(0, packetLength);
      this.packetBuffer = this.packetBuffer.subarray(packetLength);
      this.decodePacket({
        packetLength,
        headerLength: packet.readUInt16BE(4),
        version: packet.readUInt16BE(6),
        operation: packet.readUInt32BE(8),
        body: packet.subarray(packet.readUInt16BE(4)),
      });
    }
  }

  private decodePacket(packet: BilibiliPacket): void {
    if (packet.operation !== 5) {
      return;
    }

    if (packet.version === 2) {
      try {
        this.decodeCompressed(inflateSync(packet.body));
      } catch {
        return;
      }
      return;
    }

    if (packet.version === 3) {
      try {
        this.decodeCompressed(brotliDecompressSync(packet.body));
      } catch {
        return;
      }
      return;
    }

    this.decodeJSON(packet.body);
  }

  private decodeCompressed(body: Buffer): void {
    let offset = 0;
    while (offset + 16 <= body.length) {
      const packetLength = body.readUInt32BE(offset);
      if (packetLength < 16 || offset + packetLength > body.length) {
        return;
      }
      const headerLength = body.readUInt16BE(offset + 4);
      const packetBody = body.subarray(offset + headerLength, offset + packetLength);
      this.decodeJSON(packetBody);
      offset += packetLength;
    }
  }

  private decodeJSON(body: Buffer): void {
    for (const line of body.toString("utf8").split("\0")) {
      if (!line.trim()) {
        continue;
      }
      try {
        const message = JSON.parse(line) as unknown;
        this.emitBilibiliEvent(message);
      } catch {
        // Ignore malformed or non-JSON control payloads.
      }
    }
  }

  private emitBilibiliEvent(message: unknown): void {
    if (!isRecord(message) || typeof message.cmd !== "string") {
      return;
    }

    const command = message.cmd;
    if (command.startsWith("DANMU_MSG")) {
      const info = asArray(message.info);
      const text = asString(info[1]);
      const user = asArray(info[2]);
      const header = asArray(info[0]);
      if (text) {
        this.emit(createEvent(this.room, "text", text, {
          id: asString(user[0]) || undefined,
          name: asString(user[1]) || "未知用户",
        }, { command }, toHexColor(asNumber(header[3]))));
      }
      return;
    }

    if (command === "SEND_GIFT" || command === "COMBO_SEND") {
      const data = asRecord(message.data) ?? {};
      const senderName = asString(data.uname) || "未知用户";
      const giftName = asString(data.giftName) || "礼物";
      const count = asNumber(data.num) || asNumber(data.combo_num) || 1;
      this.emit(createEvent(this.room, "gift", `${senderName} 送出 ${giftName} ×${count}`, {
        id: asString(data.uid) || undefined,
        name: senderName,
      }, {
        command,
        giftName,
        count,
      }));
      return;
    }

    if (command === "LIKE_INFO_V3_CLICK") {
      const data = asRecord(message.data) ?? {};
      const senderName = asString(data.uname) || "有人";
      this.emit(createEvent(this.room, "like", `${senderName} 点了个赞`, {
        id: asString(data.uid) || undefined,
        name: senderName,
      }, { command }));
    }
  }
}

interface DouyinRoomContext {
  webRid: string;
  roomId: string;
  userUniqueId: string;
  ttwid: string;
}

interface DouyinRoomEnterResponse {
  data?: {
    enter_room_id?: string;
    data?: Array<{
      id_str?: string;
    }>;
  };
}

interface DouyinPushFrame {
  logId: bigint;
  payloadEncoding: string;
  payloadType: string;
  payload: Buffer;
}

interface DouyinResponse {
  messages: Buffer[];
  internalExt: string;
  needAck: boolean;
}

type DouyinProtoValue = bigint | Buffer;
type DouyinProtoFields = Map<number, DouyinProtoValue[]>;

async function createDouyinConnection(
  room: LiveRoom,
  emit: DanmakuEmitter,
): Promise<DanmakuConnection> {
  const context = await resolveDouyinRoomContext(room);
  const connection = new DouyinConnection(room, context, emit);
  connection.start();
  return connection;
}

async function resolveDouyinRoomContext(room: LiveRoom): Promise<DouyinRoomContext> {
  const webRid = douyinWebRoomId(room);
  if (!/^\d+$/.test(webRid)) {
    throw new Error("抖音房间号无效");
  }

  const home = await fetchTextWithResponse("https://live.douyin.com/", douyinHeaders);
  const ttwid = extractDouyinCookie(home.response.headers.get("set-cookie"), "ttwid");
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
  const response = await fetchJson<DouyinRoomEnterResponse>(
    `https://live.douyin.com/webcast/room/web/enter/?${params.toString()}`,
    {
      ...douyinHeaders,
      Referer: `https://live.douyin.com/${webRid}`,
      Cookie: `ttwid=${ttwid}`,
    },
  );
  const roomId = response.data?.enter_room_id || response.data?.data?.[0]?.id_str || "";
  if (!/^\d+$/.test(roomId)) {
    throw new Error("抖音直播间上下文获取失败");
  }

  return {
    webRid,
    roomId,
    userUniqueId: createDouyinUserUniqueId(),
    ttwid,
  };
}

function douyinWebRoomId(room: LiveRoom): string {
  const url = room.webUrl ?? room.url ?? "";
  const urlMatch = url.match(/live\.douyin\.com\/(?:room\/)?([0-9]+)/i);
  if (urlMatch) {
    return urlMatch[1];
  }
  return roomIdentifier(room);
}

function extractDouyinCookie(header: string | null, name: string): string {
  return header?.match(new RegExp(`${name}=([^;]+)`))?.[1] ?? "";
}

function createDouyinUserUniqueId(): string {
  return String(7_300_000_000_000_000_000n + BigInt(Math.floor(Math.random() * 100_000_000_000_000)));
}

class DouyinConnection implements DanmakuConnection {
  private socket: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private signatureCounter = 0;
  private closed = false;

  constructor(
    private readonly room: LiveRoom,
    private readonly context: DouyinRoomContext,
    private readonly emit: DanmakuEmitter,
  ) {}

  start(): void {
    void this.connect();
  }

  close(): void {
    this.closed = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close(1000, "session closed");
    this.socket = null;
  }

  private async connect(): Promise<void> {
    if (this.closed) {
      return;
    }

    try {
      this.signatureCounter = (this.signatureCounter + 1) & 0x3f;
      const socket = new WebSocket(
        buildDouyinWebSocketUrl(this.context, this.signatureCounter),
        {
          headers: {
            ...douyinWebSocketHeaders,
            Cookie: `ttwid=${this.context.ttwid}`,
          },
          handshakeTimeout: 10_000,
        },
      );
      socket.binaryType = "nodebuffer";
      this.socket = socket;
      socket.once("open", () => {
        this.reconnectAttempt = 0;
        this.sendHeartbeat(socket);
        this.heartbeatTimer = setInterval(() => this.sendHeartbeat(socket), 5_000);
      });
      socket.on("message", (data) => this.handleMessage(socket, data));
      socket.once("close", () => {
        if (this.heartbeatTimer) {
          clearInterval(this.heartbeatTimer);
          this.heartbeatTimer = null;
        }
        if (this.socket === socket) {
          this.socket = null;
        }
        this.scheduleReconnect();
      });
      socket.once("error", () => {
        // The close callback owns reconnect handling.
      });
    } catch {
      this.scheduleReconnect();
    }
  }

  private sendHeartbeat(socket: WebSocket): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(encodeDouyinHeartbeatFrame());
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) {
      return;
    }
    const delay = reconnectDelaysMs[Math.min(this.reconnectAttempt, reconnectDelaysMs.length - 1)];
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private handleMessage(socket: WebSocket, data: RawData): void {
    const decoded = decodeDouyinPushFrame(rawDataToBuffer(data));
    if (!decoded) {
      return;
    }

    if (decoded.response.needAck && socket.readyState === WebSocket.OPEN) {
      socket.send(encodeDouyinAckFrame(decoded.frame.logId, decoded.response.internalExt));
    }

    for (const message of decoded.response.messages) {
      emitDouyinMessage(this.room, message, this.emit);
    }
  }
}

function buildDouyinWebSocketUrl(context: DouyinRoomContext, counter: number): string {
  const now = Date.now();
  const wrds = `${now}${Math.floor(Math.random() * 1_000_000)}`;
  const params = new URLSearchParams({
    app_name: "douyin_web",
    version_code: "180800",
    webcast_sdk_version: douyinWebcastSdkVersion,
    update_version_code: douyinWebcastSdkVersion,
    compress: "gzip",
    device_platform: "web",
    cookie_enabled: "true",
    screen_width: "1920",
    screen_height: "1080",
    browser_language: "zh-CN",
    browser_platform: "Win32",
    browser_name: "Mozilla",
    browser_version: browserUserAgent,
    browser_online: "true",
    tz_name: "Asia/Shanghai",
    cursor: `d-1_u-1_fh-${context.userUniqueId}_t-${now}_r-1`,
    internal_ext: [
      "internal_src:dim",
      `wss_push_room_id:${context.roomId}`,
      `wss_push_did:${context.userUniqueId}`,
      `first_req_ms:${now}`,
      `fetch_time:${now}`,
      "seq:1",
      `wss_info:0-${now}-0-0`,
      `wrds_v:${wrds}`,
    ].join("|"),
    host: "https://live.douyin.com",
    aid: "6383",
    live_id: "1",
    did_rule: "3",
    endpoint: "live_pc",
    support_wrds: "1",
    user_unique_id: context.userUniqueId,
    im_path: "/webcast/im/fetch/",
    identity: "audience",
    need_persist_msg_count: "15",
    room_id: context.roomId,
    heartbeatDuration: "0",
  });
  const signatureParameter = douyinSignatureKeys
    .map((key) => `${key}=${params.get(key) ?? ""}`)
    .join(",");
  const xMSStub = createHash("md5").update(signatureParameter).digest("hex");
  params.set("signature", createDouyinSignature(xMSStub, counter));
  return `wss://${douyinWebcastHost}/webcast/im/push/v2/?${params.toString()}`;
}

function createDouyinSignature(xMSStub: string, counter: number): string {
  const stubBytes = Buffer.from(xMSStub, "hex");
  const stubDigest = createHash("md5").update(stubBytes).digest();
  const emptyBodyDigest = createHash("md5")
    .update(createHash("md5").update(Buffer.alloc(0)).digest())
    .digest();
  const payloadRandom = readDouyinRandomByte(true);
  const keyRandom = readDouyinRandomByte(true);
  const payload = Buffer.from([
    counter & 0x3f,
    0,
    1,
    14,
    emptyBodyDigest[14],
    emptyBodyDigest[15],
    stubDigest[14],
    stubDigest[15],
    payloadRandom,
    0,
  ]);
  for (let index = 0; index < 9; index += 1) {
    payload[9] ^= payload[index];
  }

  const encrypted = rc4(Buffer.from([keyRandom]), payload);
  const result = Buffer.concat([
    Buffer.from([0x40 | (readDouyinRandomByte(false) & 1 ? 0x10 : 0), keyRandom]),
    encrypted,
  ]);
  const standard = result.toString("base64").replace(/=+$/, "");
  return Array.from(standard, (character) => {
    const index = douyinStandardBase64Alphabet.indexOf(character);
    return index >= 0 ? douyinSignatureAlphabet[index] : character;
  }).join("");
}

function readDouyinRandomByte(excludeFF: boolean): number {
  let value = randomBytes(1)[0];
  while (excludeFF && value === 0xff) {
    value = randomBytes(1)[0];
  }
  return value;
}

function rc4(key: Buffer, data: Buffer): Buffer {
  const state = Array.from({ length: 256 }, (_, index) => index);
  let j = 0;
  for (let index = 0; index < state.length; index += 1) {
    j = (j + state[index] + key[index % key.length]) & 0xff;
    [state[index], state[j]] = [state[j], state[index]];
  }

  const output = Buffer.alloc(data.length);
  let i = 0;
  j = 0;
  for (let index = 0; index < data.length; index += 1) {
    i = (i + 1) & 0xff;
    j = (j + state[i]) & 0xff;
    [state[i], state[j]] = [state[j], state[i]];
    output[index] = data[index] ^ state[(state[i] + state[j]) & 0xff];
  }
  return output;
}

function decodeDouyinPushFrame(data: Buffer): { frame: DouyinPushFrame; response: DouyinResponse } | null {
  try {
    const fields = parseDouyinProtoFields(data);
    const payload = douyinBytesField(fields, 8);
    if (!payload || payload.length === 0) {
      return null;
    }
    const payloadEncoding = douyinStringField(fields, 6);
    const payloadType = douyinStringField(fields, 7);
    let responsePayload = payload;
    if (payloadType !== "hb" && payloadType !== "ack") {
      try {
        responsePayload = gunzipSync(payload);
      } catch {
        return null;
      }
    }

    const responseFields = parseDouyinProtoFields(responsePayload);
    return {
      frame: {
        logId: douyinVarintField(fields, 2) ?? 0n,
        payloadEncoding,
        payloadType,
        payload,
      },
      response: {
        messages: douyinBytesFields(responseFields, 1),
        internalExt: douyinStringField(responseFields, 5),
        needAck: (douyinVarintField(responseFields, 9) ?? 0n) !== 0n,
      },
    };
  } catch {
    return null;
  }
}

function emitDouyinMessage(room: LiveRoom, data: Buffer, emit: DanmakuEmitter): void {
  const fields = parseDouyinProtoFields(data);
  const method = douyinStringField(fields, 1);
  const payload = douyinBytesField(fields, 2);
  if (!method || !payload) {
    return;
  }

  const messageFields = parseDouyinProtoFields(payload);
  switch (method) {
    case "WebcastChatMessage": {
      const text = douyinStringField(messageFields, 3).trim();
      if (text) {
        emit(createEvent(room, "text", text, decodeDouyinUser(douyinBytesField(messageFields, 2)), { command: method }));
      }
      return;
    }
    case "WebcastGiftMessage": {
      const sender = decodeDouyinUser(douyinBytesField(messageFields, 7));
      const gift = douyinBytesField(messageFields, 15);
      const giftName = gift ? douyinStringField(parseDouyinProtoFields(gift), 16) : "礼物";
      const count = douyinNumberField(messageFields, 6)
        || douyinNumberField(messageFields, 5)
        || douyinNumberField(messageFields, 29)
        || 1;
      emit(createEvent(room, "gift", `${sender?.name ?? "未知用户"} 送出 ${giftName || "礼物"} ×${count}`, sender, {
        command: method,
        giftName: giftName || "礼物",
        count,
      }));
      return;
    }
    case "WebcastLikeMessage":
    case "WebcastChatLikeMessage": {
      const sender = decodeDouyinUser(douyinBytesField(messageFields, 5));
      const count = douyinNumberField(messageFields, 2) || 1;
      emit(createEvent(room, "like", `${sender?.name ?? "有人"} 点了 ${count} 个赞`, sender, {
        command: method,
        count,
      }));
      return;
    }
    case "WebcastMemberMessage": {
      const sender = decodeDouyinUser(douyinBytesField(messageFields, 2));
      const description = douyinStringField(messageFields, 11) || "进入直播间";
      emit(createEvent(room, "member", `${sender?.name ?? "有人"} ${description}`, sender, { command: method }));
      return;
    }
    case "WebcastSocialMessage": {
      const sender = decodeDouyinUser(douyinBytesField(messageFields, 2));
      emit(createEvent(room, "member", `${sender?.name ?? "有人"} 分享了直播间`, sender, { command: method }));
      return;
    }
    case "WebcastFansclubMessage": {
      const text = douyinStringField(messageFields, 3).trim();
      if (text) {
        // Fan club notices arrive on the chat channel but read as room announcements,
        // so they are classified with the other non-conversation room events.
        emit(createEvent(room, "member", text, decodeDouyinUser(douyinBytesField(messageFields, 4)), { command: method }));
      }
      return;
    }
    case "WebcastControlMessage": {
      if (douyinNumberField(messageFields, 2) === 3) {
        emit(createEvent(room, "system", douyinStringField(messageFields, 3) || "直播间已下播", undefined, { command: method }));
      }
      return;
    }
    default:
      return;
  }
}

function decodeDouyinUser(data: Buffer | undefined): DanmakuSender | undefined {
  if (!data) {
    return undefined;
  }
  const fields = parseDouyinProtoFields(data);
  const id = douyinStringField(fields, 1028) || douyinBigIntString(douyinVarintField(fields, 1));
  const name = douyinStringField(fields, 3) || "未知用户";
  const level = douyinNumberField(fields, 6);
  return {
    id: id || undefined,
    name,
    level: level > 0 ? level : undefined,
  };
}

function encodeDouyinHeartbeatFrame(): Buffer {
  return Buffer.from([0x3a, 0x02, 0x68, 0x62]);
}

function encodeDouyinAckFrame(logId: bigint, internalExt: string): Buffer {
  return Buffer.concat([
    encodeDouyinVarintField(2, logId),
    encodeDouyinStringField(7, "ack"),
    encodeDouyinBytesField(8, Buffer.from(internalExt, "utf8")),
  ]);
}

function parseDouyinProtoFields(data: Buffer): DouyinProtoFields {
  const fields: DouyinProtoFields = new Map();
  let offset = 0;
  while (offset < data.length) {
    const key = readDouyinVarint(data, offset);
    offset = key.offset;
    const fieldNumber = Number(key.value >> 3n);
    const wireType = Number(key.value & 0x07n);
    if (fieldNumber <= 0) {
      throw new Error("Invalid Douyin protobuf field");
    }

    let value: DouyinProtoValue;
    if (wireType === 0) {
      const result = readDouyinVarint(data, offset);
      value = result.value;
      offset = result.offset;
    } else if (wireType === 1) {
      if (offset + 8 > data.length) {
        throw new Error("Truncated Douyin protobuf fixed64 field");
      }
      offset += 8;
      continue;
    } else if (wireType === 2) {
      const length = readDouyinVarint(data, offset);
      offset = length.offset;
      const byteLength = Number(length.value);
      if (!Number.isSafeInteger(byteLength) || byteLength < 0 || offset + byteLength > data.length) {
        throw new Error("Truncated Douyin protobuf bytes field");
      }
      value = data.subarray(offset, offset + byteLength);
      offset += byteLength;
    } else if (wireType === 5) {
      if (offset + 4 > data.length) {
        throw new Error("Truncated Douyin protobuf fixed32 field");
      }
      offset += 4;
      continue;
    } else {
      throw new Error(`Unsupported Douyin protobuf wire type ${wireType}`);
    }

    const values = fields.get(fieldNumber) ?? [];
    values.push(value);
    fields.set(fieldNumber, values);
  }
  return fields;
}

function readDouyinVarint(data: Buffer, start: number): { value: bigint; offset: number } {
  let value = 0n;
  let offset = start;
  for (let shift = 0n; shift <= 63n; shift += 7n) {
    if (offset >= data.length) {
      throw new Error("Truncated Douyin protobuf varint");
    }
    const byte = data[offset];
    offset += 1;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value, offset };
    }
  }
  throw new Error("Douyin protobuf varint is too long");
}

function douyinValueField(fields: DouyinProtoFields, fieldNumber: number): DouyinProtoValue | undefined {
  return fields.get(fieldNumber)?.[0];
}

function douyinVarintField(fields: DouyinProtoFields, fieldNumber: number): bigint | undefined {
  const value = douyinValueField(fields, fieldNumber);
  return typeof value === "bigint" ? value : undefined;
}

function douyinBytesField(fields: DouyinProtoFields, fieldNumber: number): Buffer | undefined {
  const value = douyinValueField(fields, fieldNumber);
  return Buffer.isBuffer(value) ? value : undefined;
}

function douyinBytesFields(fields: DouyinProtoFields, fieldNumber: number): Buffer[] {
  return (fields.get(fieldNumber) ?? []).filter((value): value is Buffer => Buffer.isBuffer(value));
}

function douyinStringField(fields: DouyinProtoFields, fieldNumber: number): string {
  return douyinBytesField(fields, fieldNumber)?.toString("utf8") ?? "";
}

function douyinNumberField(fields: DouyinProtoFields, fieldNumber: number): number {
  const value = douyinVarintField(fields, fieldNumber);
  if (value === undefined || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    return 0;
  }
  return Number(value);
}

function douyinBigIntString(value: bigint | undefined): string {
  return value === undefined ? "" : value.toString();
}

function encodeDouyinVarintField(fieldNumber: number, value: bigint): Buffer {
  return Buffer.concat([encodeDouyinVarint(BigInt((fieldNumber << 3) | 0)), encodeDouyinVarint(value)]);
}

function encodeDouyinStringField(fieldNumber: number, value: string): Buffer {
  return encodeDouyinBytesField(fieldNumber, Buffer.from(value, "utf8"));
}

function encodeDouyinBytesField(fieldNumber: number, value: Buffer): Buffer {
  return Buffer.concat([
    encodeDouyinVarint(BigInt((fieldNumber << 3) | 2)),
    encodeDouyinVarint(BigInt(value.length)),
    value,
  ]);
}

function encodeDouyinVarint(value: bigint): Buffer {
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining !== 0n) {
      byte |= 0x80;
    }
    bytes.push(byte);
  } while (remaining !== 0n);
  return Buffer.from(bytes);
}

async function createHuyaConnection(
  room: LiveRoom,
  emit: DanmakuEmitter,
): Promise<DanmakuConnection> {
  const roomId = roomIdentifier(room);
  if (!/^\d+$/.test(roomId)) {
    throw new Error("虎牙房间号无效");
  }

  const page = await fetchText(`https://www.huya.com/${encodeURIComponent(roomId)}`, huyaPageHeaders);
  const stream = parseHuyaStreamIdentifiers(page);
  if (!stream) {
    throw new Error("虎牙直播页没有返回弹幕连接参数");
  }

  const connection = new HuyaConnection(room, stream, emit);
  connection.start();
  return connection;
}

interface HuyaStreamIdentifiers {
  uid: number;
  tid: number;
  sid: number;
}

function parseHuyaStreamIdentifiers(page: string): HuyaStreamIdentifiers | null {
  const match = page.match(
    /"lChannelId"\s*:\s*(\d+)\s*,\s*"lSubChannelId"\s*:\s*(\d+)\s*,\s*"lPresenterUid"\s*:\s*(\d+)/,
  );
  if (!match) {
    return null;
  }

  const [tid, sid, uid] = match.slice(1).map(Number);
  if (![uid, tid, sid].every((value) => Number.isSafeInteger(value) && value > 0)) {
    return null;
  }
  return { uid, tid, sid };
}

class HuyaConnection implements DanmakuConnection {
  private socket: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private closed = false;

  constructor(
    private readonly room: LiveRoom,
    private readonly stream: HuyaStreamIdentifiers,
    private readonly emit: DanmakuEmitter,
  ) {}

  start(): void {
    void this.connect();
  }

  close(): void {
    this.closed = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close(1000, "session closed");
    this.socket = null;
  }

  private async connect(): Promise<void> {
    if (this.closed) {
      return;
    }

    try {
      const socket = new WebSocket("wss://cdnws.api.huya.com/", {
        headers: huyaWebSocketHeaders,
        handshakeTimeout: 10_000,
      });
      socket.binaryType = "nodebuffer";
      this.socket = socket;
      socket.once("open", () => {
        this.reconnectAttempt = 0;
        socket.send(encodeHuyaCommand(1, encodeHuyaUserInfo(this.stream)));
        this.heartbeatTimer = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(huyaHeartbeatPacket);
          }
        }, 60_000);
      });
      socket.on("message", (data) => this.handleMessage(data));
      socket.once("close", () => {
        if (this.heartbeatTimer) {
          clearInterval(this.heartbeatTimer);
          this.heartbeatTimer = null;
        }
        if (this.socket === socket) {
          this.socket = null;
        }
        this.scheduleReconnect();
      });
      socket.once("error", () => {
        // The close callback owns reconnect handling.
      });
    } catch {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) {
      return;
    }
    const delay = reconnectDelaysMs[Math.min(this.reconnectAttempt, reconnectDelaysMs.length - 1)];
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private handleMessage(data: RawData): void {
    const command = decodeHuyaCommand(rawDataToBuffer(data));
    if (!command || command.commandType !== 7) {
      return;
    }

    const push = decodeHuyaPushMessage(command.payload);
    if (!push || push.uri !== 1400) {
      return;
    }

    const notice = decodeHuyaMessageNotice(push.message);
    if (!notice?.text) {
      return;
    }

    this.emit(createEvent(this.room, "text", notice.text, {
      id: notice.uid > 0 ? String(notice.uid) : undefined,
      name: notice.name || "未知用户",
    }, { command: "1400" }));
  }
}

const huyaTarsType = {
  int8: 0,
  int16: 1,
  int32: 2,
  int64: 3,
  string1: 6,
  string4: 7,
  list: 9,
  structBegin: 10,
  structEnd: 11,
  zero: 12,
  bytes: 13,
} as const;

const huyaHeartbeatPacket = Buffer.from(
  "00031d0000690000006910032c3c4c56086f6e6c696e657569660f4f6e557365724865617274426561747d00003c0800010604745265711d00002f0a0a0c1600260036076164725f77617046000b1203aef00f2203aef00f3c42006d5202605c60017c82000bb01f9cac0b8c980ca80c",
  "hex",
);

function huyaTarsHead(tag: number, type: number): Buffer {
  if (tag < 15) {
    return Buffer.from([(tag << 4) | type]);
  }
  return Buffer.from([0xf0 | type, tag]);
}

function encodeHuyaInt8(tag: number, value: number): Buffer {
  if (value === 0) {
    return huyaTarsHead(tag, huyaTarsType.zero);
  }
  return Buffer.concat([
    huyaTarsHead(tag, huyaTarsType.int8),
    Buffer.from([value & 0xff]),
  ]);
}

function encodeHuyaInt16(tag: number, value: number): Buffer {
  if (value >= -128 && value <= 127) {
    return encodeHuyaInt8(tag, value);
  }
  const buffer = Buffer.alloc(2);
  buffer.writeInt16BE(value);
  return Buffer.concat([huyaTarsHead(tag, huyaTarsType.int16), buffer]);
}

function encodeHuyaInt32(tag: number, value: number): Buffer {
  if (value >= -32_768 && value <= 32_767) {
    return encodeHuyaInt16(tag, value);
  }
  const buffer = Buffer.alloc(4);
  buffer.writeInt32BE(value);
  return Buffer.concat([huyaTarsHead(tag, huyaTarsType.int32), buffer]);
}

function encodeHuyaInt64(tag: number, value: number): Buffer {
  if (value >= -2_147_483_648 && value <= 2_147_483_647) {
    return encodeHuyaInt32(tag, value);
  }
  const buffer = Buffer.alloc(8);
  buffer.writeBigInt64BE(BigInt(value));
  return Buffer.concat([huyaTarsHead(tag, huyaTarsType.int64), buffer]);
}

function encodeHuyaString(tag: number, value: string): Buffer {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= 255) {
    return Buffer.concat([
      huyaTarsHead(tag, huyaTarsType.string1),
      Buffer.from([buffer.length]),
      buffer,
    ]);
  }
  const length = Buffer.alloc(4);
  length.writeInt32BE(buffer.length);
  return Buffer.concat([huyaTarsHead(tag, huyaTarsType.string4), length, buffer]);
}

function encodeHuyaBytes(tag: number, value: Buffer): Buffer {
  return Buffer.concat([
    huyaTarsHead(tag, huyaTarsType.bytes),
    huyaTarsHead(0, huyaTarsType.int8),
    encodeHuyaInt32(0, value.length),
    value,
  ]);
}

function encodeHuyaUserInfo(stream: HuyaStreamIdentifiers): Buffer {
  return Buffer.concat([
    encodeHuyaInt64(0, stream.uid),
    encodeHuyaInt8(1, 1),
    encodeHuyaString(2, ""),
    encodeHuyaString(3, ""),
    encodeHuyaInt64(4, stream.tid),
    encodeHuyaInt64(5, stream.sid),
    encodeHuyaInt64(6, 0),
    encodeHuyaInt64(7, 0),
  ]);
}

function encodeHuyaCommand(commandType: number, payload: Buffer): Buffer {
  return Buffer.concat([
    encodeHuyaInt32(0, commandType),
    encodeHuyaBytes(1, payload),
  ]);
}

interface HuyaCommand {
  commandType: number;
  payload: Buffer;
}

interface HuyaPushMessage {
  uri: number;
  message: Buffer;
}

interface HuyaMessageNotice {
  uid: number;
  name: string;
  text: string;
}

class HuyaTarsReader {
  private position = 0;

  constructor(private readonly buffer: Buffer) {}

  readInt(tag: number, required = false): number {
    if (!this.seekTag(tag)) {
      if (required) {
        throw new Error(`Huya TARS field ${tag} is missing`);
      }
      return 0;
    }
    return this.readNumberValue(this.readHead().type);
  }

  readBytes(tag: number, required = false): Buffer {
    if (!this.seekTag(tag)) {
      if (required) {
        throw new Error(`Huya TARS bytes field ${tag} is missing`);
      }
      return Buffer.alloc(0);
    }
    const header = this.readHead();
    if (header.type !== huyaTarsType.bytes) {
      throw new Error("Huya TARS bytes field has an unexpected type");
    }
    this.readHead();
    const length = this.readNumberValue(this.readHead().type);
    if (length < 0 || this.position + length > this.buffer.length) {
      throw new Error("Huya TARS bytes field is truncated");
    }
    const value = this.buffer.subarray(this.position, this.position + length);
    this.position += length;
    return value;
  }

  readString(tag: number, required = false): string {
    if (!this.seekTag(tag)) {
      if (required) {
        throw new Error(`Huya TARS string field ${tag} is missing`);
      }
      return "";
    }
    const header = this.readHead();
    let length: number;
    if (header.type === huyaTarsType.string1) {
      length = this.readUInt8();
    } else if (header.type === huyaTarsType.string4) {
      length = this.readInt32BE();
    } else {
      throw new Error("Huya TARS string field has an unexpected type");
    }
    if (length < 0 || this.position + length > this.buffer.length) {
      throw new Error("Huya TARS string field is truncated");
    }
    const value = this.buffer.subarray(this.position, this.position + length).toString("utf8");
    this.position += length;
    return value;
  }

  readStruct(tag: number, required = false): HuyaTarsReader {
    if (!this.seekTag(tag)) {
      if (required) {
        throw new Error(`Huya TARS struct field ${tag} is missing`);
      }
      return new HuyaTarsReader(Buffer.alloc(0));
    }
    const header = this.readHead();
    if (header.type !== huyaTarsType.structBegin) {
      throw new Error("Huya TARS struct field has an unexpected type");
    }

    const start = this.position;
    let depth = 1;
    while (this.position < this.buffer.length) {
      const fieldStart = this.position;
      const field = this.readHead();
      if (field.type === huyaTarsType.structBegin) {
        depth += 1;
      } else if (field.type === huyaTarsType.structEnd) {
        depth -= 1;
        if (depth === 0) {
          return new HuyaTarsReader(this.buffer.subarray(start, fieldStart));
        }
      } else {
        this.skipField(field.type);
      }
    }
    throw new Error("Huya TARS struct field is truncated");
  }

  private seekTag(tag: number): boolean {
    while (this.position < this.buffer.length) {
      const header = this.peekHead();
      if (header.type === huyaTarsType.structEnd) {
        return false;
      }
      if (header.tag >= tag) {
        return header.tag === tag;
      }
      this.skipField(this.readHead().type);
    }
    return false;
  }

  private readHead(): { tag: number; type: number } {
    const first = this.readUInt8();
    const tag = first >> 4;
    const type = first & 0x0f;
    if (tag === 15) {
      return { tag: this.readUInt8(), type };
    }
    return { tag, type };
  }

  private peekHead(): { tag: number; type: number } {
    const position = this.position;
    const header = this.readHead();
    this.position = position;
    return header;
  }

  private readNumberValue(type: number): number {
    switch (type) {
      case huyaTarsType.zero:
        return 0;
      case huyaTarsType.int8:
        return this.readInt8();
      case huyaTarsType.int16:
        return this.readInt16BE();
      case huyaTarsType.int32:
        return this.readInt32BE();
      case huyaTarsType.int64:
        return Number(this.readBigInt64BE());
      default:
        throw new Error(`Huya TARS number has unexpected type ${type}`);
    }
  }

  private skipField(type: number): void {
    switch (type) {
      case huyaTarsType.int8:
        this.position += 1;
        return;
      case huyaTarsType.int16:
        this.position += 2;
        return;
      case huyaTarsType.int32:
        this.position += 4;
        return;
      case huyaTarsType.int64:
        this.position += 8;
        return;
      case huyaTarsType.string1:
        this.position += 1 + this.buffer[this.position];
        return;
      case huyaTarsType.string4:
        this.position += this.readInt32BE();
        return;
      case huyaTarsType.bytes:
        this.readHead();
        this.position += this.readNumberValue(this.readHead().type);
        return;
      case huyaTarsType.list: {
        const size = this.readInt(0, true);
        for (let index = 0; index < size; index += 1) {
          this.skipField(this.readHead().type);
        }
        return;
      }
      case huyaTarsType.structBegin:
        while (this.position < this.buffer.length) {
          const field = this.readHead();
          if (field.type === huyaTarsType.structEnd) {
            return;
          }
          this.skipField(field.type);
        }
        return;
      case huyaTarsType.zero:
        return;
      default:
        throw new Error(`Huya TARS field has unexpected type ${type}`);
    }
  }

  private readUInt8(): number {
    if (this.position >= this.buffer.length) {
      throw new Error("Huya TARS buffer is truncated");
    }
    const value = this.buffer.readUInt8(this.position);
    this.position += 1;
    return value;
  }

  private readInt8(): number {
    if (this.position + 1 > this.buffer.length) {
      throw new Error("Huya TARS buffer is truncated");
    }
    const value = this.buffer.readInt8(this.position);
    this.position += 1;
    return value;
  }

  private readInt16BE(): number {
    if (this.position + 2 > this.buffer.length) {
      throw new Error("Huya TARS buffer is truncated");
    }
    const value = this.buffer.readInt16BE(this.position);
    this.position += 2;
    return value;
  }

  private readInt32BE(): number {
    if (this.position + 4 > this.buffer.length) {
      throw new Error("Huya TARS buffer is truncated");
    }
    const value = this.buffer.readInt32BE(this.position);
    this.position += 4;
    return value;
  }

  private readBigInt64BE(): bigint {
    if (this.position + 8 > this.buffer.length) {
      throw new Error("Huya TARS buffer is truncated");
    }
    const value = this.buffer.readBigInt64BE(this.position);
    this.position += 8;
    return value;
  }
}

function decodeHuyaCommand(data: Buffer): HuyaCommand | null {
  try {
    const reader = new HuyaTarsReader(data);
    return {
      commandType: reader.readInt(0, true),
      payload: reader.readBytes(1),
    };
  } catch {
    return null;
  }
}

function decodeHuyaPushMessage(data: Buffer): HuyaPushMessage | null {
  try {
    const reader = new HuyaTarsReader(data);
    return {
      uri: reader.readInt(1, true),
      message: reader.readBytes(2),
    };
  } catch {
    return null;
  }
}

function decodeHuyaMessageNotice(data: Buffer): HuyaMessageNotice | null {
  try {
    const reader = new HuyaTarsReader(data);
    const sender = reader.readStruct(0, true);
    return {
      uid: sender.readInt(0),
      name: sender.readString(2),
      text: reader.readString(3),
    };
  } catch {
    return null;
  }
}

async function createDouyuConnection(
  room: LiveRoom,
  emit: DanmakuEmitter,
): Promise<DanmakuConnection> {
  const roomId = roomIdentifier(room);
  if (!/^\d+$/.test(roomId)) {
    throw new Error("斗鱼房间号无效");
  }

  const connection = new DouyuConnection(room, roomId, emit);
  connection.start();
  return connection;
}

class DouyuConnection implements DanmakuConnection {
  private socket: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private packetBuffer = Buffer.alloc(0);
  private reconnectAttempt = 0;
  private closed = false;

  constructor(
    private readonly room: LiveRoom,
    private readonly roomId: string,
    private readonly emit: DanmakuEmitter,
  ) {}

  start(): void {
    void this.connect();
  }

  close(): void {
    this.closed = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close(1000, "session closed");
    this.socket = null;
  }

  private async connect(): Promise<void> {
    if (this.closed) {
      return;
    }

    try {
      const socket = new WebSocket("wss://danmuproxy.douyu.com:8506", {
        headers: {
          Origin: "https://www.douyu.com",
          Referer: "https://www.douyu.com/",
          "User-Agent": browserUserAgent,
        },
        handshakeTimeout: 10_000,
      });
      socket.binaryType = "nodebuffer";
      this.socket = socket;
      socket.once("open", () => {
        this.reconnectAttempt = 0;
        this.send(`type@=loginreq/roomid@=${this.roomId}/`);
        this.send(`type@=joingroup/rid@=${this.roomId}/gid@=-9999/`);
        this.heartbeatTimer = setInterval(() => this.send("type@=mrkl/"), 45_000);
      });
      socket.on("message", (data) => this.handleMessage(data));
      socket.once("close", () => {
        if (this.heartbeatTimer) {
          clearInterval(this.heartbeatTimer);
          this.heartbeatTimer = null;
        }
        if (this.socket === socket) {
          this.socket = null;
        }
        this.scheduleReconnect();
      });
      socket.once("error", () => {
        // The close callback owns reconnect handling.
      });
    } catch {
      this.scheduleReconnect();
    }
  }

  private send(message: string): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(encodeDouyuPacket(message));
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) {
      return;
    }
    const delay = reconnectDelaysMs[Math.min(this.reconnectAttempt, reconnectDelaysMs.length - 1)];
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private handleMessage(data: RawData): void {
    this.packetBuffer = Buffer.concat([this.packetBuffer, rawDataToBuffer(data)]);
    if (this.packetBuffer.length > 4 * 1024 * 1024) {
      this.packetBuffer = Buffer.alloc(0);
      return;
    }

    while (this.packetBuffer.length >= 12) {
      const packetLength = this.packetBuffer.readUInt32LE(0);
      const totalLength = packetLength + 4;
      if (packetLength < 8 || totalLength > 4 * 1024 * 1024) {
        this.packetBuffer = Buffer.alloc(0);
        return;
      }
      if (this.packetBuffer.length < totalLength) {
        return;
      }

      const body = this.packetBuffer.subarray(12, totalLength);
      this.packetBuffer = this.packetBuffer.subarray(totalLength);
      this.emitDouyuEvent(parseDouyuFields(body));
    }
  }

  private emitDouyuEvent(fields: Record<string, string>): void {
    const type = fields.type;
    const senderName = fields.nn || "未知用户";
    if (type === "chatmsg" && fields.txt) {
      this.emit(createEvent(this.room, "text", fields.txt, {
        id: fields.uid || undefined,
        name: senderName,
        level: parseOptionalNumber(fields.level),
      }, { command: type }));
      return;
    }

    if (type === "dgb" || type === "bc_buy_deserve") {
      const giftName = fields.gn || fields.giftname || "礼物";
      const count = parseOptionalNumber(fields.gfc) || parseOptionalNumber(fields.gc) || 1;
      this.emit(createEvent(this.room, "gift", `${senderName} 送出 ${giftName} ×${count}`, {
        id: fields.uid || undefined,
        name: senderName,
      }, { command: type, giftName, count }));
      return;
    }

    if (type === "uenter" || type === "onlinegift") {
      this.emit(createEvent(this.room, "member", `${senderName} 进入直播间`, {
        id: fields.uid || undefined,
        name: senderName,
      }, { command: type }));
    }
  }
}

function encodeBilibiliPacket(operation: number, body: Buffer): Buffer {
  const packet = Buffer.alloc(16 + body.length);
  packet.writeUInt32BE(packet.length, 0);
  packet.writeUInt16BE(16, 4);
  packet.writeUInt16BE(1, 6);
  packet.writeUInt32BE(operation, 8);
  packet.writeUInt32BE(1, 12);
  body.copy(packet, 16);
  return packet;
}

async function signBilibiliParameters(
  params: URLSearchParams,
): Promise<{ wts: number; wRid: string }> {
  const keys = await getBilibiliWbiKeys();
  const wts = Math.floor(Date.now() / 1000);
  const values = new Map<string, string>();
  for (const [key, value] of params.entries()) {
    values.set(key, value);
  }
  values.set("wts", String(wts));

  const query = Array.from(values.keys())
    .sort()
    .map((key) => `${key}=${encodeURIComponent(values.get(key) ?? "")}`)
    .join("&");
  const mixinKey = wbiMixinKeyTable
    .map((index) => `${keys.imgKey}${keys.subKey}`[index] ?? "")
    .join("")
    .slice(0, 32);
  const wRid = createHash("md5")
    .update(`${query}${mixinKey}`)
    .digest("hex");
  return { wts, wRid };
}

async function getBilibiliWbiKeys(): Promise<{ imgKey: string; subKey: string }> {
  if (wbiKeysCache && wbiKeysCache.expiresAt > Date.now()) {
    return wbiKeysCache;
  }

  const response = await fetchJson<BilibiliNavigationResponse>(
    "https://api.bilibili.com/x/web-interface/nav",
    {
      Referer: "https://www.bilibili.com/",
      "User-Agent": browserUserAgent,
    },
  );
  const imgKey = extractWbiKey(response.data?.wbi_img?.img_url);
  const subKey = extractWbiKey(response.data?.wbi_img?.sub_url);
  if (!imgKey || !subKey) {
    throw new Error("哔哩哔哩 WBI 密钥获取失败");
  }

  wbiKeysCache = {
    imgKey,
    subKey,
    expiresAt: Date.now() + wbiKeyCacheTTL,
  };
  return wbiKeysCache;
}

function extractWbiKey(url?: string): string {
  const filename = url?.match(/\/([^/]+)\.png(?:\?.*)?$/)?.[1];
  return filename ?? "";
}

function encodeDouyuPacket(message: string): Buffer {
  const body = Buffer.from(`${message}\0`, "utf8");
  const packetLength = body.length + 8;
  const packet = Buffer.alloc(packetLength + 4);
  packet.writeUInt32LE(packetLength, 0);
  packet.writeUInt32LE(packetLength, 4);
  packet.writeUInt16LE(689, 8);
  packet.writeUInt16LE(0, 10);
  body.copy(packet, 12);
  return packet;
}

function parseDouyuFields(body: Buffer): Record<string, string> {
  const fields: Record<string, string> = {};
  const text = body.toString("utf8").replace(/\0+$/, "");
  for (const field of text.split("/")) {
    const separator = field.indexOf("@=");
    if (separator < 0) {
      continue;
    }
    const key = decodeDouyuValue(field.slice(0, separator));
    const value = decodeDouyuValue(field.slice(separator + 2));
    if (key) {
      fields[key] = value;
    }
  }
  return fields;
}

function decodeDouyuValue(value: string): string {
  return value.replace(/@S/g, "/").replace(/@A/g, "@");
}

function createEvent(
  room: LiveRoom,
  kind: DanmakuKind,
  text: string,
  sender?: DanmakuSender,
  metadata?: Record<string, DanmakuMetadataValue>,
  color?: string,
): DanmakuEvent {
  const safeText = text.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 500);
  const safeSender = sender && sender.name.trim()
    ? {
        ...sender,
        name: sender.name.trim().slice(0, 80),
        ...(sender.level === undefined ? {} : { level: sender.level }),
      }
    : undefined;
  return {
    version: 1,
    id: randomUUID(),
    platform: room.platform,
    roomId: roomIdentifier(room),
    kind,
    text: safeText,
    sender: safeSender,
    color,
    timestamp: new Date().toISOString(),
    metadata,
  };
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data);
  }
  return Buffer.from(data as Uint8Array);
}

function roomIdentifier(room: LiveRoom): string {
  const idMatch = room.id.match(/(?:^|-)([0-9]+)$/);
  if (idMatch) {
    return idMatch[1];
  }
  const url = room.webUrl ?? room.url ?? "";
  const urlMatch = url.match(/(?:douyu\.com|bilibili\.com|live\.douyin\.com|huya\.com)\/(?:room\/)?([0-9]+)/i);
  return urlMatch?.[1] ?? room.id;
}

function platformLabel(platform: PlatformId): string {
  return {
    douyin: "抖音",
    douyu: "斗鱼",
    huya: "虎牙",
    bilibili: "哔哩哔哩",
  }[platform];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

function asNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseOptionalNumber(value: unknown): number | undefined {
  const parsed = asNumber(value);
  return parsed > 0 ? parsed : undefined;
}

function toHexColor(value: number): string | undefined {
  if (!Number.isInteger(value) || value <= 0 || value > 0xffffff) {
    return undefined;
  }
  return `#${value.toString(16).padStart(6, "0")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
