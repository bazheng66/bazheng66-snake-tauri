# 🐍 Snake 2.0 - Tauri Edition

把开源的 [patorjk/JavaScript-Snake](https://github.com/patorjk/JavaScript-Snake)（浏览器版贪吃蛇）改造成 **Tauri 2** 桌面应用：前端用 TypeScript + Canvas 重写，最高分和统计数据由 **Rust 后端**持久化到系统应用数据目录。

## 实测数据（Windows 11，2026-10-26）

同一套前端构建产物（`dist/`）分别装进 Tauri 和 Electron，在同一台机器上测量：

| 指标 | Tauri 2.12 | Electron 45.0 | 结论 |
|------|-----------:|--------------:|------|
| 安装包 | **1.09 MB**（NSIS） | 未打包 | — |
| 主程序 / 运行时体积 | **3.35 MB**（`snake-tauri.exe`） | 357 MB（`electron.exe` + Chromium 运行时，未打包） | Tauri 小约 **100 倍** |
| 冷启动到窗口出现（5 次中位数） | **114 ms**（96, 97, 114, 126, 468） | **360 ms**（326, 359, 360, 363, 1681） | Tauri 快约 **3 倍** |
| 内存（工作集，含渲染进程） | **451.7 MB**（7 个进程） | **372.2 MB**（4 个进程） | ⚠️ **Electron 更低** |
| 内存（私有字节） | **260.0 MB** | **219.7 MB** | ⚠️ **Electron 更低** |

### 怎么理解这些数字

- **体积是 Tauri 最确定的优势。** Tauri 不打包浏览器，复用系统自带的 WebView2（Windows 11 已预装），所以可执行文件只有几 MB；Electron 必须随应用分发完整的 Chromium。
- **启动更快**：程序本身小，WebView2 运行时又是系统共享组件。
- **内存不一定更省。** 在这台机器上，WebView2 起了 6 个辅助进程，总内存反而比 Electron 略高。常见说法“Tauri 内存省 80%”在 Windows 上并不成立，WebView2 本身就是一个 Chromium。macOS（WKWebView）和 Linux（WebKitGTK）上的结果可能不同，这里没有测。
- Electron 一栏是**未打包**的运行时；用 electron-builder 打包后的安装包通常会压缩到 80–100 MB 左右，这一点没有实测。

### 复现方法

```bash
npm run tauri build -- --bundles nsis
```

体积看 `src-tauri/target/release/`。启动时间和内存用仓库里的 [bench/measure.ps1](bench/measure.ps1)（PowerShell）：

```bash
powershell -ExecutionPolicy Bypass -File bench/measure.ps1 -Exe src-tauri/target/release/snake-tauri.exe
```

Electron 对照程序在 [bench/electron/](bench/electron/)，它用 `BrowserWindow.loadFile()` 加载同一份 `dist/index.html`：

```bash
cd bench/electron && npm install && cd ../..
```

```bash
powershell -ExecutionPolicy Bypass -File bench/measure.ps1 -Exe bench/electron/node_modules/electron/dist/electron.exe -AppArgs bench/electron
```

- 启动时间：从 `Start-Process` 到出现带标题的可见窗口，每边 5 次取中位数，第一次（冷缓存）也计入。
- 内存：最后一次启动 8 秒后，统计主进程及其全部子进程的工作集和私有字节。脚本设置了独立的 `WEBVIEW2_USER_DATA_FOLDER`，避免 Tauri 和其他已运行的实例共用 WebView2 进程。

测试环境：Windows 11 Home (10.0.26200)，WebView2 155.0.4283.62，rustc 1.98.1，Node 26.0.0。

## 功能

- 经典玩法：方向键 / WASD 移动，吃到食物变长，撞墙或撞到自己结束
- 空格暂停/继续，回车开始/重开；窗口最小化时自动暂停
- 五档难度（Easy / Medium / Hard / Impossible / Rush），设置由 Rust 后端持久化
- 五套 Canvas 主题（Main / Dark / Matrix / Neon / Golden）
- 可选 AI Autoplay（BFS 寻路，会话内开关）
- 转向输入队列：快速连按两个方向（如右行时 ↑←）会按顺序执行，不会因为 180° 掉头撞到自己
- 棋盘大小随窗口缩放，保持正方形
- 最高分、游戏局数、累计分数与设置由 Rust 后端保存

## 架构

```
前端 (src/main.ts)                         后端 (src-tauri/src/lib.rs)
├─ Canvas 渲染 + requestAnimationFrame      ├─ GameState (serde 序列化)
│  固定时间步长的游戏循环                    ├─ Mutex<GameState> 托管状态
├─ 键盘输入、转向队列                        └─ 7 个 #[tauri::command]
└─ invoke('update_high_score', ...) ────────►   读写 app_data_dir()/game_state.json
```

游戏逻辑放在前端，避免每一帧都跨 IPC 往返；只有需要持久化的数据走 Rust。

存档位置：
- Windows：`%APPDATA%\com.snake2.game\game_state.json`
- macOS：`~/Library/Application Support/com.snake2.game/game_state.json`
- Linux：`~/.local/share/com.snake2.game/game_state.json`

## 运行

前置条件：Node.js 18+、Rust（[rustup.rs](https://rustup.rs/)），以及 [Tauri 系统依赖](https://tauri.app/start/prerequisites/)（Windows 需要 WebView2，Win11 自带）。

```bash
npm install
npm run tauri dev
```

开发服务器使用 **8080** 端口（`vite.config.ts` 和 `src-tauri/tauri.conf.json` 两处需要保持一致）。

## 构建

```bash
npm run tauri build
```

产物在 `src-tauri/target/release/bundle/`。只要 Windows 安装包可以加 `-- --bundles nsis`。

`src-tauri/Cargo.toml` 中的 release 配置专门为减小体积做了调整：`opt-level = "s"`、thin LTO、`codegen-units = 1`、`panic = "abort"`、`strip = true`。（fat LTO 在本机会让 rustc 崩溃，所以用了 thin。）

## 项目结构

```
snake-tauri/
├── index.html              # 页面 + 样式
├── src/main.ts             # 游戏引擎、渲染、输入、Tauri 调用
├── src/ai.ts               # AI Autoplay（BFS）
├── src-tauri/
│   ├── src/lib.rs          # Rust 后端：状态、持久化、commands
│   ├── src/main.rs         # 入口，调用 lib::run()
│   ├── capabilities/       # Tauri 2 权限配置
│   ├── Cargo.toml
│   └── tauri.conf.json
├── bench/
│   ├── measure.ps1         # 启动时间 + 内存测量脚本
│   └── electron/           # 同一前端的 Electron 对照程序
├── vite.config.ts
└── package.json
```

## 后续计划

- 音效（后端已有 `sound_enabled`，前端尚未接）
- 道具与更多游戏模式
- 在 macOS / Linux 上做同样的体积和内存测量

## 许可证

MIT，见 [LICENSE](LICENSE)。玩法参考自 Patrick Gillespie 的 [JavaScript-Snake](https://github.com/patorjk/JavaScript-Snake)（MIT）。前端是重写的，没有复制原项目的代码。
