import { app, BrowserWindow, ipcMain, shell } from "electron";
import path from "node:path";
import { PlatformService } from "./platform-service";
import type { LiveRoom, PlatformId } from "../shared/types";

const service = new PlatformService();
const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL);

function registerIpcHandlers(): void {
  ipcMain.handle(
    "rooms:list",
    (_event, platform: PlatformId | "all" = "all") =>
      service.listRooms(platform),
  );

  ipcMain.handle("app:info", () => ({
    ...service.getAppInfo(app.getVersion()),
  }));

  ipcMain.handle("player:open", async (_event, room: LiveRoom) => {
    const result = await service.requestPlay(room);

    if (result.ok && result.url) {
      await shell.openExternal(result.url);
    }

    return result;
  });
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 680,
    title: "LiveHub",
    backgroundColor: "#090b10",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (isDevelopment && process.env.VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../../dist/index.html"));
  }
}

app.whenReady().then(() => {
  app.setAppUserModelId("com.willsuo.livehub");
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
