import { app, BrowserWindow, ipcMain, nativeImage, shell } from "electron";
import path from "node:path";
import { PlayerService } from "./player-service";
import { PlatformService } from "./platform-service";
import type { LiveRoom, PlatformId, RoomsLoadMode } from "../shared/types";

const service = new PlatformService();
const playerService = new PlayerService();
const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL);
const iconPath = path.resolve(__dirname, "../assets/livehub-icon.png");
let mainWindow: BrowserWindow | null = null;

function registerIpcHandlers(): void {
  ipcMain.handle(
    "rooms:list",
    (_event, platform: PlatformId | "all" = "all", mode: RoomsLoadMode = "featured") =>
      service.listRooms(platform, mode),
  );

  service.subscribe((update) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("rooms:update", update);
    }
  });

  ipcMain.handle("app:info", () => ({
    ...service.getAppInfo(app.getVersion()),
  }));

  ipcMain.handle("players:state", () => playerService.getState());
  ipcMain.handle("players:refresh", () => playerService.refreshPlayers());
  ipcMain.handle("players:default:set", (_event, playerId: string) =>
    playerService.setDefaultPlayer(playerId),
  );
  ipcMain.handle("player:open", (_event, room: LiveRoom, playerId?: string) =>
    playerService.requestPlay(room, playerId),
  );
  ipcMain.handle("room:open-web", async (_event, room: LiveRoom) => {
    const target = room.webUrl ?? room.url;
    if (!target) {
      return { ok: false, message: "这个直播间没有可打开的网页地址。" };
    }

    try {
      const url = new URL(target);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return { ok: false, message: "直播间网页地址无效。" };
      }

      await shell.openExternal(url.toString());
      return { ok: true, message: "已使用系统浏览器打开直播间。" };
    } catch {
      return { ok: false, message: "直播间网页打开失败。" };
    }
  });
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 680,
    title: "LiveHub",
    icon: iconPath,
    backgroundColor: "#090b10",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow = window;

  if (isDevelopment && process.env.VITE_DEV_SERVER_URL) {
    void window.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    void window.loadFile(path.join(__dirname, "../../dist/index.html"));
  }
}

app.whenReady().then(() => {
  app.setAppUserModelId("com.willsuo.livehub");
  if (process.platform === "darwin") {
    const icon = nativeImage.createFromPath(iconPath);
    if (!icon.isEmpty()) {
      app.dock?.setIcon(icon);
    }
  }
  registerIpcHandlers();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("will-quit", () => {
  service.dispose();
});
