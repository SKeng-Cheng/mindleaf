#!/bin/bash
# macOS 双击即可启动 Mindleaf（会打开默认浏览器）。
# 想固定端口：在终端里跑 `node bin/mindleaf.mjs serve --port 7788 --open`。
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  # 双击启动时 PATH 里通常没有 nvm 的 node，尝试常见位置
  for candidate in "$HOME/.nvm/versions/node"/*/bin /usr/local/bin /opt/homebrew/bin; do
    if [ -x "$candidate/node" ]; then
      export PATH="$candidate:$PATH"
      break
    fi
  done
fi

if ! command -v node >/dev/null 2>&1; then
  echo "没有找到 node。请先安装 Node.js 20+（https://nodejs.org），或在终端里执行："
  echo "  brew install node"
  read -r -p "按回车键退出…" _
  exit 1
fi

node bin/mindleaf.mjs serve --open
status=$?
if [ $status -ne 0 ]; then
  echo
  echo "启动失败（退出码 $status）。按回车键关闭窗口。"
  read -r -p "" _
fi
