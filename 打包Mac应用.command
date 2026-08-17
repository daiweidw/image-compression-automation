#!/bin/zsh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

finish() {
  local status="$1"
  echo
  if [ "$status" -eq 0 ]; then
    echo "Mac 应用打包完成。"
  else
    echo "Mac 应用打包失败，请根据上方信息处理后重试。"
  fi
  echo "按回车键关闭窗口。"
  read -r
  exit "$status"
}

echo "========================================"
echo "       图片压缩工作台 Mac 打包"
echo "========================================"
echo

if [ "$(uname -s)" != "Darwin" ]; then
  echo "只能在 macOS 上生成 Mac 应用。"
  finish 1
fi

if [ "$(uname -m)" != "arm64" ]; then
  echo "当前只支持在 Apple Silicon（M 系列）Mac 上生成 arm64 版本。"
  finish 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js，请先安装 Node.js 22 或更高版本。"
  finish 1
fi

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null)"
if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt 22 ] 2>/dev/null; then
  echo "当前 Node.js 版本为 $(node --version 2>/dev/null)，请升级到 22 或更高版本。"
  finish 1
fi

if command -v pnpm >/dev/null 2>&1; then
  PACKAGE_RUNNER=(pnpm)
elif command -v corepack >/dev/null 2>&1 && corepack pnpm --version >/dev/null 2>&1; then
  PACKAGE_RUNNER=(corepack pnpm)
else
  echo "未找到 pnpm 10。请先安装 pnpm，然后重新双击打包。"
  finish 1
fi

if [ ! -x "$SCRIPT_DIR/node_modules/.bin/electron-builder" ]; then
  echo "项目依赖尚未安装。请先在工程目录执行：pnpm install"
  finish 1
fi

cd "$SCRIPT_DIR" || finish 1

CURRENT_VERSION="$(node "$SCRIPT_DIR/scripts/update-package-versions.mjs" --current)"
if [ "$?" -ne 0 ] || [ -z "$CURRENT_VERSION" ]; then
  echo "无法读取当前版本号。"
  finish 1
fi

VERSION_INPUT="$CURRENT_VERSION"
while true; do
  NEW_VERSION="$(osascript "$SCRIPT_DIR/scripts/prompt-package-version.applescript" "$VERSION_INPUT" 2>/dev/null)"
  if [ "$?" -ne 0 ]; then
    echo "已取消打包，未修改版本号。"
    exit 0
  fi

  if node "$SCRIPT_DIR/scripts/update-package-versions.mjs" --validate "$NEW_VERSION"; then
    break
  fi

  osascript -e 'display alert "版本号格式不正确" message "请输入 x.y.z 格式的版本号，例如 0.2.5。" as warning buttons {"重新输入"} default button "重新输入"' >/dev/null
  VERSION_INPUT="$NEW_VERSION"
done

if ! node "$SCRIPT_DIR/scripts/update-package-versions.mjs" "$NEW_VERSION"; then
  finish 1
fi

echo "版本号已同步更新为 $NEW_VERSION。"
echo "正在生成 Apple Silicon 版本，请稍候..."
echo
"${PACKAGE_RUNNER[@]}" package:mac:arm64
STATUS=$?

if [ "$STATUS" -ne 0 ]; then
  finish "$STATUS"
fi

echo
echo "打包产物位于：$SCRIPT_DIR/release"
if ! open "$SCRIPT_DIR/release"; then
  echo "无法自动打开 release 目录，请手动查看。"
fi

finish 0
