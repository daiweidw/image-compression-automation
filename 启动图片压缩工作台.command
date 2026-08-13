#!/bin/zsh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js，请先安装 Node.js 22 或更高版本。"
  echo "按回车键关闭窗口。"
  read -r
  exit 1
fi

cd "$SCRIPT_DIR"
node "$SCRIPT_DIR/scripts/launcher.mjs"
STATUS=$?

if [ "$STATUS" -ne 0 ]; then
  echo "按回车键关闭窗口。"
  read -r
fi

exit "$STATUS"
