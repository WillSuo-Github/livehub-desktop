import { app, BrowserWindow, session } from "electron";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

// The public directory API relies on the website's own request middleware.
// Keep that remote content sandboxed, without access to LiveHub's preload or IPC.
export async function startDouyinBrowser(): Promise<{ url: string; close(): void }> {
  const partition = `douyin-directory-${randomUUID()}`;
  const isolatedSession = session.fromPartition(partition);
  isolatedSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolatedSession.on("will-download", (event) => event.preventDefault());
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      partition, sandbox: true, contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  window.webContents.setAudioMuted(true);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== "https://live.douyin.com") event.preventDefault();
  });
  const prefix = `/${randomUUID()}/rooms`;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const category = url.searchParams.get("category") ?? "";
    const offset = url.searchParams.get("offset") ?? "";
    if (request.method !== "GET" || url.pathname !== prefix
      || !/^(?:\d+_\d+_)*\d+_\d+$/.test(category) || !/^\d{1,8}$/.test(offset)) {
      response.writeHead(400).end();
      return;
    }
    const parts = category.split("_");
    const params = new URLSearchParams({
      aid: "6383", app_name: "douyin_web", live_id: "1", device_platform: "web", language: "zh-CN",
      count: "15", offset, partition: parts.at(-1)!, partition_type: parts.at(-2)!, req_from: "2",
    });
    const apiPath = `/webcast/web/partition/detail/room/v2?${params}`;
    try {
      const body: string = await window.webContents.executeJavaScript(`(async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        try {
          const url = new URL(${JSON.stringify(apiPath)}, location.origin);
          for (const [key, value] of Object.entries({
            cookie_enabled: navigator.cookieEnabled, screen_width: screen.width, screen_height: screen.height,
            browser_language: navigator.language, browser_platform: navigator.platform,
            browser_name: 'Chrome', browser_version: navigator.userAgent.split('Chrome/')[1]?.split(' ')[0] ?? '',
          })) url.searchParams.set(key, String(value));
          const response = await fetch(url, { signal: controller.signal });
          if (!response.ok) throw new Error('Directory HTTP ' + response.status);
          const text = await response.text();
          if (!text.trim()) throw new Error('Directory request blocked or empty');
          return text;
        } finally { clearTimeout(timer); }
      })()`);
      response.writeHead(200, { "Content-Type": "application/json" }).end(body);
    } catch {
      response.writeHead(502).end("Douyin directory pagination unavailable");
    }
  });
  const close = (): void => {
    app.removeListener("before-quit", close);
    server.closeAllConnections();
    server.close();
    if (!window.isDestroyed()) window.destroy();
    void isolatedSession.closeAllConnections();
  };
  app.once("before-quit", close);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      window.loadURL("https://live.douyin.com/categorynew/4_101"),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Douyin directory initialization timed out")), 30_000);
      }),
    ]);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Douyin directory bridge unavailable");
    return { url: `http://127.0.0.1:${address.port}${prefix}`, close };
  } catch (error) {
    close();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
