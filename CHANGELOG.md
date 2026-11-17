# 更新日志

## v0.1.0 — 2026-11-17

第一个公开版本。

### 它是什么

一个本地思维导图工具：**一张图就是一个 JSON 文件**。网页、CLI、MCP 三个入口改的是同一份数据，
人在网页里拖节点，AI 通过 MCP 工具改节点，谁改了什么都有记录。

### 功能

- **网页编辑**：行内编辑、拖拽改父节点、`Tab` / `Enter` 快速加节点、撤销重做、折叠、三种布局（向右 / 向左 / 两边）
- **节点样式**：模块底色、字体色、连线色三种颜色；字号、字体（系统字体）、框宽高；支持「本节点 / 含子节点」整枝套用
- **标签**：给导图分类，侧栏按标签筛选，搜索同时匹配标题 / 文件名 / 标签
- **大纲侧栏**：缩进的树，点行跳转、就地折叠、搜索自动展开
- **链接**：节点可挂工作区文件、网址、代码行号（`file.ts#L120-L180`），在网页里直接预览
- **模板**：十个内置模板（论文提纲、研究计划、文献综述、项目路线图、会议纪要、周计划等）
- **导出**：PNG / JPG / PDF / SVG / Markdown / JSON / HTML
- **接入 AI**：MCP 标准 stdio，18 个工具，DSH / Codex CLI / Claude Code / Claude Desktop 都能接
- **零依赖**：只用 Node 标准库（Node ≥ 20），网页是原生 JS 没有构建步骤

### 安装

```bash
# npm
npm i -g mindleaf && mm serve --open

# 完整仓库
git clone https://github.com/SKeng-Cheng/mindleaf.git
cd mindleaf && node bin/mindleaf.mjs serve --open

# 最小版（去掉测试、截图、开发文档）
git clone -b lite --depth 1 https://github.com/SKeng-Cheng/mindleaf.git
cd mindleaf && node bin/mindleaf.mjs serve --open
```

### 已知限制

- 只在 macOS 上实际跑过；Linux / Windows 没有验证
- 矢量 PDF 需要本机有 Chrome 或 Edge，否则中文 PDF 会退化成图片（能看不能选）
- 一千个节点以上的大图首次渲染会有点卡
- 协作范围是"同一台机器、同一个目录"，多人请用 git
- 浏览器只测过 Chrome 和 Edge
