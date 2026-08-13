# 图片压缩工作台

一个在本机运行的 TinyPNG 图片压缩管理工具。第二版可打包为独立 macOS 应用，不要求使用者安装 Node.js 或 pnpm。

## 第二版功能

- 自动监听原图目录并增量刷新；自动压缩为独立开关，默认关闭。
- 原图与压缩结果支持滑块、并排、缩放和 100% 检查。
- 桌面版使用 macOS `safeStorage` 加密 API Key，其加密能力由系统 Keychain 保护。
- 系统目录选择器、打开结果目录以及在 Finder 中显示图片。
- 任务暂停、继续、重启后确认恢复和可筛选的任务历史。
- 覆盖、跳过和自动添加后缀三种输出冲突策略。
- 虚拟列表和按原图指纹缓存的磁盘缩略图。
- 单实例 Electron 桌面窗口和安全退出。

## 环境要求

- Node.js 22 或更高版本
- pnpm 10
- TinyPNG API Key：[申请入口](https://tinypng.com/developers)

## 启动

开发者可以使用原有浏览器模式：

首次使用先安装依赖并构建：

```bash
pnpm install
pnpm build
pnpm start
```

服务默认运行在 [http://127.0.0.1:43127](http://127.0.0.1:43127)。如果端口已被占用，终端会显示实际地址。

macOS 也可以直接双击仓库根目录的 `启动图片压缩工作台.command`。启动器会自动完成以下工作：

- 如果应用尚未构建，先执行构建。
- 如果应用已经运行，直接打开现有工作台，不重复启动服务。
- 如果默认端口被占用，选择可用端口并打开正确地址。
- 在后台启动本地服务，然后使用默认浏览器打开页面。

双击启动仍要求本机已经安装 Node.js 22 或更高版本和 pnpm 10。首次构建前还需要执行一次 `pnpm install` 安装依赖。

开发环境运行独立桌面窗口：

```bash
pnpm desktop
```

## 生成分享包

Apple Silicon Mac：

```bash
pnpm package:mac:arm64
```

第二版只提供 Apple Silicon（M 系列芯片）版本，不提供 Intel Mac 安装包。

该命令采用离线打包模式：根据项目当前安装的 Electron 精确版本，从 `~/Library/Caches/electron/` 查找对应的 arm64 ZIP 并直接使用，不下载 Electron，也不请求在线校验文件。缓存缺失时命令会直接报错；只需联网准备一次对应版本的缓存，后续即可重复离线打包。升级 Electron 版本后，需要为新版本重新准备一次缓存。

生成的 ZIP 位于 `release/`。应用会在打包结束时进行 Ad Hoc 临时签名，确保应用包及其内置组件的完整性。分享给其他人后，对方解压即可获得“图片压缩工作台.app”，无需安装 Node.js、pnpm 或工程依赖。

Ad Hoc 签名不代表 Apple 信任该应用。由于当前没有付费 Apple Developer 账号，应用未进行 Developer ID 签名和 Apple 公证。首次打开时：

1. 在 Finder 中右键“图片压缩工作台.app”。
2. 选择“打开”。
3. 如果系统仍然拦截，打开“系统设置 → 隐私与安全性”，确认应用名称无误后选择“仍要打开”。

不同 macOS 版本和单位安全策略的提示可能不同。不要关闭 Gatekeeper，也不需要执行绕过系统安全机制的命令。若目标 Mac 不允许用户批准未公证应用，则只能使用 Developer ID 签名并完成 Apple 公证后分发。

开发模式：

```bash
pnpm dev
```

开发页面运行在 [http://127.0.0.1:5173](http://127.0.0.1:5173)。

## 使用方法

1. 在首次设置页填写原图目录和压缩结果目录。两个目录不能相同或互相包含。
2. 填写 TinyPNG API Key，并使用“测试连接”确认有效。
3. 保存设置后等待目录扫描完成。
4. 搜索或筛选图片，选择单张、当前页或全部筛选结果。
5. 点击“压缩所选图片”。结果会保持原文件名与相对子目录结构。
6. 点击图片可进入滑块或并排效果对比。
7. 使用右上角电源按钮退出应用。退出成功后，本地服务会停止。

如果退出时仍有任务，页面会显示正在压缩和排队的图片数量，并要求再次确认。确认后，排队任务会被取消，进行中的 TinyPNG 请求会中断；已成功完成的结果和历史记录不会删除。由于图片可能已经上传，进行中的任务仍可能计入 TinyPNG 使用次数。

桌面版 API Key 使用 macOS `safeStorage` 加密后保存在本机，保护加密密钥的能力由 Keychain 提供。浏览器兼容模式仍使用权限受限文件。完整 Key 不会返回页面、写入 SQLite 或输出到日志。

图片会上传至 TinyPNG 服务处理。请确认所选图片允许传给第三方服务。

## 数据位置

macOS 默认应用数据目录：

```text
~/Library/Application Support/Image Compression Automation/
```

其中包含设置、SQLite 状态数据库、API Key 文件和本地日志。原图目录始终只读。

## 验证命令

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm test:e2e
```

普通自动化测试使用本地模拟 TinyPNG 服务，不消耗真实 API 额度。

## 当前限制

- 当前正式分发优先支持 macOS。
- 应用仅使用 Ad Hoc 临时签名，首次打开可能显示开发者验证提示。
- 没有 Apple Developer ID 签名、公证、Mac App Store 和自动更新。
- 不提供格式转换、缩放、裁剪或元数据保留。
- 服务重启后排队任务进入“等待恢复”，必须由用户确认继续。
- 真实 TinyPNG 压缩需要本机能够访问 `api.tinify.com`。

详细规格见 [需求文档](./docs/requirements.md) 和 [技术架构](./docs/technical-architecture.md)。
