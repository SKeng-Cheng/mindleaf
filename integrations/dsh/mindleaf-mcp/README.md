# Mindleaf MCP（DSH bundle）

配置型 bundle：不含运行时代码，只把本机的 Mindleaf MCP 服务注册进 DSH。

## 生成真实路径

占位符（`__NODE__` / `__TOOL__` / `__PROJECT__`）不能直接安装，先生成一份填好路径的副本：

```bash
node integrations/install.mjs --target dsh
```

它会输出渲染后的目录路径，例如 `integrations/.rendered/dsh/mindleaf-mcp`。

## 安装

在 DSH 的 **Plugins → Add plugin** 里选择上面那个目录，安装后新开一个会话，
用 `mindleaf__list_maps` 验证连接。

## 卸载

**Plugins** 里禁用或移除 `Mindleaf 思维导图` 即可；不会动你的导图文件。

## 说明

- `serverName: mindleaf` 决定了工具名前缀为 `mindleaf__`。
- `cwd` 指向项目目录；Mindleaf 自身也会用 `--project` 参数确认项目，不依赖宿主的工作目录。
- 服务器只读导图文件，不联网；导出 PDF/PNG 时会调用本机浏览器或 `sips`。
