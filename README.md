# LiveHub Desktop

**简体中文** | [English](README.en.md)

LiveHub 是基于 Electron 的跨平台直播桌面客户端，将抖音、斗鱼、虎牙和哔哩哔哩的直播间集中到一个列表中，并通过本机安装的媒体播放器播放直连直播流。

**使用播放器**会尝试调用选中的媒体播放器，不会在失败时自动打开网页。访问平台直播间需要单独点击**使用网页打开直播间**。

## 当前发布

- 版本号：在 `package.json` 中手动维护，发布工作流不会自动修改。
- 已发布安装包：macOS Apple Silicon（`arm64`）和 Windows x64。
- 下载地址：[GitHub Releases](https://github.com/WillSuo-Github/livehub-desktop/releases/latest)。

源码支持跨平台。每次推送 `vX.Y.Z` 标签后，GitHub Actions 会构建 macOS arm64 和 Windows x64 安装包。Linux 暂未纳入自动发布流程，可以在 Linux 环境中使用现有 Electron Builder 配置打包。

## 功能

- 集中浏览抖音、斗鱼、虎牙和哔哩哔哩直播间。
- 平台单选切换：点击平台直接切换，点击**全部平台**恢复全部。
- 分类单选筛选，支持组合使用平台与分类条件。
- 按房间标题、主播名称、分类和标签搜索。
- 收藏保存在本地；已同步的收藏房间中有正在直播的房间时，侧栏显示小绿点。
- 默认按**综合热度**排序，先归一化各平台内部排名，再合并展示。
- 当前筛选结果全部提供可比较的在线人数时，支持按**在线人数**排序，例如仅筛选抖音。
- 优先展示热门房间，完整列表在后台继续同步。
- 热门房间在每轮刷新完成后间隔 5 分钟再次刷新。
- 默认在启动后同步完整列表，随后在每轮全量同步完成后间隔 1 小时再次同步。
- 可在设置中暂停后台全量同步，热门刷新和手动同步仍然可用。
- 正式列表不混入演示数据。
- 播放时尝试解析最新的 HLS、FLV 直连直播流。
- 提供独立的网页打开入口。
- 自动检测本机播放器，并保存默认播放器选择。
- 正式安装版支持检查 GitHub Release 更新、后台下载，以及重启安装。

## 下载与安装

从 [GitHub Releases](https://github.com/WillSuo-Github/livehub-desktop/releases/latest) 下载最新安装包。

### macOS

已发布的安装包面向 Apple Silicon（`arm64`）。下载 `.dmg` 后，将 LiveHub 拖入 Applications 文件夹，再从该文件夹启动。自动发布流程会在发布前验证 Developer ID 签名与 Apple 公证。

也可以下载 `.zip`，解压后使用应用包。

### Windows

下载 `.exe` 安装程序，也可以使用 `.zip` 便携版。

Windows 安装包未进行代码签名，首次下载或启动时可能出现 SmartScreen 提示。

### Linux

项目配置支持 Linux 打包，但自动发布流程暂不提供 Linux 安装包。可以在 Linux 环境中执行 `npm run package` 自行构建。

## 使用 LiveHub

1. 启动 LiveHub，等待热门直播间加载。
2. 点击平台名称切换到该平台，或点击**全部平台**查看所有平台。
3. 选择一个分类，或切回**全部分类**。
4. 使用搜索框和排序按钮筛选直播间。
5. 点击直播间卡片，打开详情面板。
6. 选择已检测到的播放器，点击**使用播放器**，尝试解析最新直连流并启动播放器。
7. 需要访问平台网页时，点击**使用网页打开直播间**，在系统默认浏览器中打开。

### 自动更新

正式安装版启动后会检查 GitHub Releases。发现兼容的新版本后，LiveHub 会在后台下载，不会中断当前播放。设置页显示下载进度，下载完成后可以点击**重启更新**安装。

下载完成后，退出应用也会自动安装更新。macOS 上仅关闭主窗口不会退出应用。

### 播放器检测

LiveHub 会检测以下播放器的常见安装位置或命令：

- Vunio
- IINA
- mpv
- VLC
- Celluloid
- PotPlayer
- ffplay

界面只显示当前机器实际检测到的播放器，不同系统的可用播放器可能不同。在详情面板或设置中选择播放器后，该选择会保存为默认播放器。Vunio 通过 `vunio://play` URL 协议打开；其他播放器接收解析后的直连流地址。

LiveHub 当前仅在 macOS 检测 Vunio，并在播放器选择器旁和设置页提供专用入口。点击入口后会重新扫描：已安装 Vunio 时将其设为默认播放器，未检测到时打开 [Vunio 官网](https://vunio.willsuo.com) 供下载。Windows 和 Linux 不显示该专用入口。

## 数据来源与限制

LiveHub 使用各平台公开的直播目录接口，以及本仓库维护的适配器。无需登录平台账号，直播流解析也不依赖浏览器窗口。

“全部房间”指刷新时可通过公开分类和分页接口取得的房间，不保证覆盖平台官方客户端中能看到的每个直播间。平台风控、地区限制、房间失效、请求限流、接口变动和分类缺失都可能影响覆盖范围。

各平台的观看指标并不统一：

- 抖音提供的数值按在线人数处理。
- 哔哩哔哩列表的 `online`、斗鱼的 `ol`、虎牙公开接口的 `totalCount` 按平台人气处理，不能直接视为可比较的观看人数。
- 默认的**综合热度**先在各平台内部排序并归一化，再合并结果，不直接比较不同口径的原始数值。
- 只有当前筛选结果全部提供可比较的在线人数时，才能使用**在线人数**排序；否则使用综合热度。

直连直播流地址通常具有时效性。房间切换清晰度、下播或平台拒绝请求时，地址可能失效。播放时会尝试解析最新地址；如果解析失败且房间数据中已有可用播放地址，会尝试使用已有地址。解析或启动失败时会在应用中提示，不会自动跳转到网页。

正式安装包包含目标系统对应的原生抖音辅助程序。开发模式下，首次使用时可以自动编译缺失的辅助程序，需要 Go 1.22 或更新版本。

## 开发环境

- Node.js 20.19 及以上的 20.x，或 22.12 及以上版本。
- npm 10 或更新版本。
- Go 1.22 或更新版本，用于开发和打包抖音辅助程序。
- 本机安装的媒体播放器，用于验证播放功能。

安装依赖并启动开发版：

```bash
npm ci
npm run dev
```

开发版使用 Vite 渲染进程和 Electron 主进程。首次请求抖音数据时，如果原生辅助程序不存在，会编译生成 `native/douyin-helper/bin/douyin-helper`；Windows 对应文件名为 `douyin-helper.exe`。

## 检查与构建

运行类型检查和构建：

```bash
npm run typecheck
npm run build
```

构建原生辅助程序，并为当前系统打包：

```bash
npm run package
```

构建 macOS DMG 和 ZIP：

```bash
npm run package:mac
```

构建产物输出到 `release/`。打包流程会先编译原生抖音辅助程序，将其放在应用归档外部，并包含 LiveHub 应用图标。

### GitHub 自动发布

推送 `vX.Y.Z` 标签，或针对该标签手动触发时，`.github/workflows/release.yml` 会运行。工作流读取标签对应提交中的 `package.json` 版本，构建 macOS arm64 和 Windows x64 安装包，并将安装包和更新元数据发布到同一个 GitHub Release。工作流不会创建标签，也不会修改或提交版本文件。

发布流程分为三步：使用 `npm version X.Y.Z --no-git-tag-version` 更新版本，手动提交并推送版本变更，再创建并推送匹配的标签。该命令不会自动提交或创建 Git 标签。

```bash
git tag -a vX.Y.Z -m "LiveHub X.Y.Z"
git push origin vX.Y.Z
```

标签名必须等于该提交中 `package.json` 版本前加 `v`。如果不匹配，发布工作流会停止。仅推送 `main` 而不推送新标签，不会触发发布构建。

macOS 发布需要有效的 Developer ID 签名和 Apple 公证。Windows 安装包未签名，不需要 Windows 证书密钥，新安装包可能出现 SmartScreen 提示。

在 GitHub Actions Secrets 中配置：

- `MACOS_CERTIFICATE_BASE64`：个人账号 Developer ID Application `.p12` 证书的 Base64 内容。
- `MACOS_CERTIFICATE_PASSWORD`：上述证书的密码。
- `APPLE_API_KEY`：个人开发者团队的 App Store Connect API 私钥内容。
- `APPLE_API_KEY_ID`：API 密钥 ID。
- `APPLE_API_ISSUER`：开发者团队的 Issuer UUID。

仓库还需要允许发布工作流写入仓库内容，以创建 GitHub Release 并上传产物。

## 项目结构

```text
electron/                 Electron main process and platform services
native/douyin-helper/     Go helper for Douyin category and room discovery
shared/                   Types shared by Electron and the renderer
src/                      React renderer, filters, room cards, settings
assets/                   Packaged application resources
scripts/                  Build-time helper scripts
```

## 第三方说明

LiveHub 不会将 DYLIVE 或 Streamlink 作为运行时依赖。部分解析器和直连流解析思路参考了它们的公开实现，并在本项目中独立适配。来源链接与许可证声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 许可证

LiveHub 使用 GNU General Public License v3.0 only（`GPL-3.0-only`）许可证，详见 [LICENSE](LICENSE)。

## 开发计划

1. 在公开接口足够稳定时，为抖音补充基于游标的房间覆盖。
2. 增加平台诊断与直播流清晰度选择。
3. 在 GitHub 自动发布流程中加入 Linux 安装包。
4. 增加播放器进程管理与更详细的播放错误说明。
5. 在许可证与维护成本可接受的前提下，评估内置播放组件。
