# Mindleaf

> **这是 lite 分支**：实现功能的最小包，45 个文件、解压后 481 KB（zip 159 KB），
> 只保留跑起来需要的代码和模板，没有测试、截图和开发文档。
> 完整版在 `main` 分支：70 个文件、解压后 3.8 MB。
> 本分支由 `scripts/build-lite.mjs` 从 main@f92783e 自动生成，**不要直接改它**。

**简体中文** · [English](README.en.md)

> 你还在一个节点一个节点手搓思维导图吗？
> 你还在让 AI 吐一段 mermaid 代码，然后自己复制出来、调缩进、发现中文错位又重来一遍吗？
> 现在有 AI 了哈哈哈哈。

画个思维导图就可以和Agent一起写论文、做项目、拆任务。

所以用 DSH 写了这个。核心想法一句话：

> **一张图就是一个 JSON 文件。你在网页里拖，AI 用 MCP 工具改，改的都是同一份。**

你动过的节点它下次读的时候知道（谁、什么时候、改了什么都有记录）；它改完你的网页会提示
"外部修改"，不会把你正在打的字冲掉。再也不用"AI 出新版本、我复制粘贴"。

# 跑起来

需要 **Node.js 20 或更新**，不用装依赖。

```bash
# 完整版（想读代码 / 想改的时候）
git clone https://github.com/SKeng-Cheng/mindleaf.git
cd mindleaf && node bin/mindleaf.mjs serve --open

# 或是最小包（只是拿来用，400 多 KB）
git clone -b lite --depth 1 https://github.com/SKeng-Cheng/mindleaf.git
cd mindleaf && node bin/mindleaf.mjs serve --open
```

启动后会打印两个网址（网页顶栏导图名称右边也有个「分享」按钮，点开就能复制）：
**本人打开** 和 **发给对方**（同一个局域网里的人用浏览器就能打开同一份图，
不用装任何东西）。网页全部关掉后服务会自己退出。

macOS 上双击仓库里的「启动 Mindleaf.command」也行。

# 能干什么

|              |                                                          |
| ------------ | -------------------------------------------------------- |
| **网页编辑**     | 行内编辑、拖拽改父节点、`Tab` / `Enter` 快速加节点、撤销重做、折叠、三种布局           |
| **和 AI 一起改** | MCP 标准协议，21 个工具；DSH、Codex、Claude Code、Claude Desktop 都能接 |
| **批注**       | 在节点上写"这里要怎么改"，AI 读图时先看到并按批注改，改完蓝点自动消失                    |
| **悬停看备注**    | 鼠标在节点上停一会儿，备注就浮在旁边（停留时长可设置）                              |
| **标签 + 大纲**  | 给图分类、按标签筛选；侧栏可切成缩进大纲，点击跳转、就地折叠                           |
| **样式**       | 模块色 / 字色 / 连线色，字号、字体、框宽高，支持"本节点 / 含子节点"整枝改               |
| **关联线**      | 跨分支拉虚线：点线即可选中，能改说明/颜色/备注/批注                              |
| **链接**       | 节点可挂工作区文件、网址、代码行号，网页里直接预览                                |
| **模板与导出**    | 十个内置模板；导出 PNG / JPG / PDF / SVG / Markdown / JSON / HTML |

# 文档

- **[MANUAL.md](MANUAL.md)** —— 完整说明书：每个功能、全部命令、接入 AI 的配置、数据格式、常见问题
- [AGENTS.md](AGENTS.md) —— 给 AI agent 看的（Codex 会自动读）
- [CHANGELOG.md](CHANGELOG.md) —— 版本记录

```bash
node bin/mindleaf.mjs help      # 命令一览
```

---

写得比较糙，如果想要什么功能，可以给自己的 agent 许愿，或者向作者许愿。

# License

[MIT](LICENSE) © 2026 SKeng-Cheng

