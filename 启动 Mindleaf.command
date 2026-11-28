#!/bin/bash
# macOS 双击即可启动 Mindleaf（会打开默认浏览器）。
# 启动后是后台服务：关掉这个终端窗口不影响使用，网页全部关掉后服务自己退出。
# 启动时会打印两个入口：「本人打开」和「发给对方」（同一局域网即可）。
# 想固定端口：`node bin/mindleaf.mjs serve --detach --port 7788 --open`
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

node bin/mindleaf.mjs serve --detach --open
status=$?
if [ $status -ne 0 ]; then
  echo
  echo "启动失败（退出码 $status）。按回车键关闭窗口。"
  read -r -p "" _
  exit $status
fi
echo
echo "已转到后台。关掉本窗口即可，浏览器里关掉 Mindleaf 页面后服务会自己退出。"
echo "想手动关闭：cd \"$(pwd)\" && node bin/mindleaf.mjs stop"
echo
sleep 4
