# 图片压缩工作台

一个在 macOS 本机运行的 TinyPNG 批量压缩工具。当前流程围绕“本次待压缩列表”设计，不要求用户先配置原图根目录。

面向使用者的完整说明（含 API Key 申请和界面截图）：[使用指南](./docs/user-guide.md)

## 当前流程

1. 把图片直接拖入主页面，或点击“扫描文件夹”选择目录。
2. 扫描中的文件持续加入待压缩列表；可随时停止扫描。
3. 从列表移除不需要处理的图片，选择本批要压缩的图片。
4. 直接开始压缩，或先在主页面修改结果保存位置。
5. 查看批次进度。失败项不会自动重试，可在结果列表中逐项点击“重新压缩”。

若未修改保存位置，桌面版在本次应用打开期间第一次压缩时，在系统“下载”目录创建一个共用文件夹：

```text
图片压缩_YYYY-MM-DD_HH-mm-ss/
```

本次应用打开期间的后续任务复用该目录；重新打开应用后创建新目录。用户指定自定义目录时结果直接写入该目录。重名文件会自动添加后缀，结果页可以打开输出目录。

待压缩列表只属于当前应用会话。关闭并重新打开应用后列表为空；不保存压缩历史，也不恢复未完成任务。

## 功能范围

- 拖入图片、扫描指定文件夹，以及停止正在进行的扫描。
- 待压缩列表的搜索、筛选、排序、多选、移除和清空。
- 多个 TinyPNG API Key 的加密保存、连接验证、独立额度显示和手动切换。
- 默认下载目录、自定义保存目录及按应用会话创建时间文件夹。
- 可选的“导入后自动压缩”，扫描过程中逐张创建任务。
- 批量进度、取消尚未开始的项目、失败项手动重新压缩。
- 原图与压缩结果预览、滑块对比和 Finder 打开结果。
- Apple Silicon macOS 独立应用离线打包。

不包含后台目录监听、失败自动重试、历史批次、任务恢复或待压缩列表缓存。

## 开发环境

- Node.js 22 或更高版本
- pnpm 10
- TinyPNG API Key：[申请入口](https://tinypng.com/developers)

安装依赖后运行浏览器开发模式：

```bash
pnpm install
pnpm dev
```

构建并启动本机服务：

```bash
pnpm build
pnpm start
```

开发页面默认是 [http://127.0.0.1:5173](http://127.0.0.1:5173)，本机服务默认是 [http://127.0.0.1:43127](http://127.0.0.1:43127)。

## 固定测试区

自动化和桌面测试统一使用仓库中的 `.ica-test/`，避免每次在系统临时目录重复创建运行时、样例和原生模块。该目录已加入 `.gitignore`：

```text
.ica-test/
├── electron/       # 从现有本机 ZIP 解压的 Electron
├── native/         # Node/Electron 两套 better-sqlite3 ABI
├── npm-cache/      # 离线原生模块构建缓存
├── node-gyp/       # node-gyp 工作目录
├── fixtures/       # 生成后的固定测试图片
├── runs/           # 各类测试的独立应用数据
├── artifacts/      # 测试报告与产物
├── pids/           # 测试进程记录
└── manifest.json   # 版本和 SHA-256 记录
```

首次准备及日常验证：

```bash
pnpm test:prepare   # 只读取现有 Electron ZIP，校验后准备测试区
pnpm test:doctor    # 检查 ZIP、ABI、清单和遗留测试进程
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm test:e2e
```

测试脚本默认设置 pnpm 离线模式，并绕过会尝试联网的原生预编译包安装器。`test:prepare` 找不到与项目版本完全匹配的 Electron ZIP 或 Electron ABI 缓存时会立即停止，不会下载。命令结束后会把 `better-sqlite3` 恢复为 Node ABI，避免测试或打包污染日常开发环境。

需要人工查看桌面窗口时运行：

```bash
pnpm test:desktop
```

清理本次运行数据但保留 Electron 和 ABI 缓存：

```bash
pnpm test:clean
```

删除整个专用测试区：

```bash
pnpm test:clean -- --all
```

## macOS 打包

Apple Silicon Mac：

```bash
pnpm package:mac:arm64
```

也可以双击仓库根目录的 `打包Mac应用.command`。打包流程只接受本机 Electron 缓存中与当前版本匹配的 arm64 ZIP，缓存缺失即失败，不进行网络下载。产物位于 `release/`。

应用使用 Ad Hoc 签名，没有 Developer ID 签名或 Apple 公证。其他 Mac 首次打开时，应使用 Finder 右键“打开”或“系统设置 -> 隐私与安全性 -> 仍要打开”，不要关闭 Gatekeeper。

## 数据与安全

桌面版应用数据默认位于：

```text
~/Library/Application Support/Image Compression Automation/
```

每个 API Key 使用 Electron `safeStorage` 独立加密保存。任务创建时绑定当前 Key，后续切换只影响新任务；系统不会自动轮换或自动重试。页面不会取回完整 Key，数据库和日志也不得记录 Key。原图只读，压缩结果先写临时文件并校验，再原子移动到批次目录。

图片会上传到 TinyPNG 服务。请确保所选图片允许交给第三方处理。自动化测试使用本地模拟服务，不消耗真实额度。

详细范围见 [需求文档](./docs/requirements.md)，实现边界见 [技术架构](./docs/technical-architecture.md)。
