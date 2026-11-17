# Mindleaf

**简体中文** · [English](README.en.md)

> 你还在一个节点一个节点手搓思维导图吗？
> 你还在让 AI 吐一段 mermaid 代码，然后自己复制出来、调缩进、发现中文错位又重来一遍吗？
> 现在有 AI 了哈哈哈哈。

写论文、做项目、拆任务，事情一复杂脑子里就是一团乱麻。我习惯先画棵树把点摊开，
再往里填细节 —— 结果发现想找个能跟 AI 配合的思维导图工具，居然没有。
要么手搓到忘了前面写了什么，要么让 AI 生成一坨代码、改一次就得重来。

所以用 DSH 写了这个。核心想法一句话：

> **一张图就是一个 JSON 文件。你在网页里拖，AI 用 MCP 工具改，改的都是同一份。**

你动过的节点它下次读的时候知道（谁、什么时候、改了什么都有记录）；它改完你的网页会提示
"外部修改"，不会把你正在打的字冲掉。再也不用"AI 出新版本、我复制粘贴"。

![网页界面：左边导图列表，中间画布，右边选中节点的属性](https://raw.githubusercontent.com/SKeng-Cheng/mindleaf/main/docs/images/ui-light.png)

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

macOS 上双击仓库里的「启动 Mindleaf.command」也行。网页全部关掉后服务会自己退出。

# 能干什么

| | |
| --- | --- |
| **网页编辑** | 行内编辑、拖拽改父节点、`Tab` / `Enter` 快速加节点、撤销重做、折叠、三种布局 |
| **和 AI 一起改** | MCP 标准协议，19 个工具；DSH、Codex、Claude Code、Claude Desktop 都能接 |
| **批注** | 在节点上写"这里要怎么改"，AI 读图时先看到并按批注改，改完蓝点自动消失 |
| **悬停看备注** | 鼠标在节点上停一会儿，备注就浮在旁边（停留时长可设置） |
| **标签 + 大纲** | 给图分类、按标签筛选；侧栏可切成缩进大纲，点击跳转、就地折叠 |
| **样式** | 模块色 / 字色 / 连线色，字号、字体、框宽高，支持"本节点 / 含子节点"整枝改 |
| **链接** | 节点可挂工作区文件、网址、代码行号，网页里直接预览 |
| **模板与导出** | 十个内置模板；导出 PNG / JPG / PDF / SVG / Markdown / JSON / HTML |

![大纲侧栏：缩进的树，点哪行跳到哪个节点](https://raw.githubusercontent.com/SKeng-Cheng/mindleaf/main/docs/images/outline.png)

# 文档

- **[MANUAL.md](MANUAL.md)** —— 完整说明书：每个功能、全部命令、接入 AI 的配置、数据格式、常见问题
- [AGENTS.md](AGENTS.md) —— 给 AI agent 看的（Codex 会自动读）
- [CHANGELOG.md](CHANGELOG.md) —— 版本记录

```bash
node bin/mindleaf.mjs help      # 命令一览
```

# License

[MIT](LICENSE) © 2026 SKeng-Cheng

---

写得比较糙，但自己每天都在用。如果你也老是要画这种树，希望能省一点时间。
如果想要什么功能，可以给自己的 agent 许愿，或者向作者许愿。
