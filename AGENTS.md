# AGENTS.md

给在这里工作的 AI agent（DSH / Codex / Claude Code / 其它）的说明书。
人类请读 [README.md](README.md)（简介）和 [MANUAL.md](MANUAL.md)（完整说明书）。

## 这个项目是什么

**Mindleaf**：一个本地思维导图工具。三个入口共用同一份数据：

| 入口 | 命令 | 谁用 |
| --- | --- | --- |
| 网页 | `node bin/mindleaf.mjs serve` | 人类，可视化编辑 |
| MCP | `node bin/mindleaf.mjs mcp` | agent（DSH / Codex / Claude） |
| CLI | `node bin/mindleaf.mjs <cmd>` | 人类与 agent 的脚本 |

**数据就是普通 JSON 文件**：`maps/<slug>.mindmap.json`。没有数据库，没有隐藏状态。
人类在网页里改、你在 MCP/CLI 里改，改的是同一个文件，用同一套 op 语义。

## 你（agent）怎么用

优先用 MCP 工具（DSH 里是 `mindleaf__*` 前缀）。工具清单：

| 工具 | 用途 |
| --- | --- |
| `list_maps` | 先看有哪些图；可带 `tag` 只看某类 |
| `list_templates` | 内置模板（论文提纲、研究计划、文献综述…） |
| `create_map` | 新建（可指定 `template`） |
| `read_map` | 读：默认 outline（带节点 id），也可 `json` / `markdown` |
| `apply_ops` | **改多个点就用它**，一批 op 原子生效 |
| `add_node` / `update_node` / `remove_node` / `move_node` / `add_edge` | 单点修改；`update_node` 支持 `color` / `textColor` / `lineColor` / `fontSize` / `font` / `boxWidth` / `boxHeight` / `annotation` |
| `update_map` | 改标题 / 布局 / 主题 / 标签（`tags`） |
| `list_tags` | 看所有标签及各自数量 |
| `list_annotations` | **看人类给这个节点留的批注（修改要求）**，不给 map 就扫全部 |
| `list_fonts` | 看可用字体键名（系统字体，配色用） |
| `export_map` | 导出 png / jpg / pdf / svg / md / json / html |
| `import_markdown` | 用 Markdown 大纲建图或覆盖 |
| `recent_changes` | 看"人类刚改了什么"（journal + 节点级 diff） |
| `open_in_browser` | 起网页给人类看 |
| `doctor` | 环境与导出能力自检 |

没有 MCP 时用 CLI，命令与工具一一对应：

```bash
MM="node bin/mindleaf.mjs"        # 在项目根执行
$MM list
$MM show 项目规划                  # 带节点 id 的大纲
$MM add 项目规划 "下一步：灰度发布" --parent root
$MM tag 项目规划 --add 项目,进行中  # 打标签
$MM list --tag 项目                 # 按标签筛
$MM export 项目规划 -f png         # 默认写到 exports/
$MM serve --detach --open          # 后台起网页（关掉终端也不停，网页全关后自动退出）
$MM stop                           # 关掉后台服务
$MM annotations                    # 看有没有人类留的批注要处理
```

## 改图的三条规矩

1. **先读再改**。`read_map` 拿到 `〔node_id〕`，之后一律用 id 操作，不要靠文字猜（文字重名会报 `ambiguous`）。
2. **一批改动用 `apply_ops`**。它是原子的：要么全成功，要么整批不生效，不会留下半成品结构。
3. **批注是人类的指令，必须照做**。节点上的 `annotation` 是"这里要怎么改"，
   `read_map` 会用 `⚑ 批注:` 标出来，`list_annotations` 能一次列全。
   改完之后把这个节点的 `annotation` 置空（`update_node` 传 `""`），并在 `note` 里留一句改了什么。
4. **标签是图级别的**（`doc.tags`），不是节点级别。给图分类用 `update_map` 的 `tags`，
   找图用 `list_maps` 的 `tag`；不要为了分类去建一层"标签节点"。
5. **改完看 rev**。每次写入 `rev + 1`，并往 `journal` 追加一条（谁、什么时候、改了什么摘要）。
   人类在网页里的修改同样会 +1 —— 所以下次接手前先 `recent_changes`，能知道人类动过哪里。

## 文件格式（别手写整份文件，除非你确定）

```jsonc
{
  "format": "mindmap",
  "schemaVersion": 1,
  "id": "mm_xxx",
  "title": "项目规划",
  "rev": 2,                       // 每次写入 +1
  "tags": ["项目", "进行中"],      // 图级别标签，用来分类和筛选
  "settings": { "layout": "right", "theme": "light" },
  "nodes": [
    { "id": "root", "parent": null, "text": "根", "note": "", "order": 0, "collapsed": false, "links": [] },
    { "id": "n_1", "parent": "root", "text": "第一步：梳理现状", "order": 0,
      "color": "#fecdd3", "textColor": "#b91c1c", "lineColor": "#0ea5e9",
      "fontSize": 18, "font": "kai", "boxWidth": 220,
      "annotation": "把这一节拆成两个节点", "links": [
      { "kind": "file", "target": "docs/architecture.md", "label": "架构说明" },
      { "kind": "url",  "target": "https://arxiv.org" },
      { "kind": "code", "target": "src/core/doc.mjs#L10-L20" }
    ] }
  ],
  "edges": [ { "id": "e_1", "from": "n_1", "to": "n_2", "label": "验证" } ],
  "journal": [ { "rev": 1, "at": "2026-01-01T00:00:00.000Z", "by": "agent", "action": "ops", "summary": "新增 3 个节点" } ]
}
```

要点：

- `nodes` 是扁平数组 + `parent` 指针，**只有一个根**（`parent: null`）。
- `order` 决定同级顺序；插入后不用手排，op 会重排。
- 新增节点时若没显式给 `color`，会自动沿用"空间上前一个节点"的颜色（插到末尾看前一个兄弟，
  插到最前看父节点）。想保持无色就显式传 `color: ""`。
- `links[].kind`：`file`（工作区文件，相对路径以项目根的 `workspaceDir` 为准）、`url`、`code`（可带 `#L10-L20` 行号）。
- `annotation` 是人类写给 agent 的修改要求（画布上蓝色小点、大纲里 ⚑），处理完要清空，
  清空后标记自动消失。`note` 是人给自己看的备注，画布上不显示标记。

- `edges` 是跨分支的关联线（虚线箭头），不参与树结构。
- 读到不合法的文件也不要慌：`normalizeDoc` 会自动修复孤儿、环、重复 id、多根。

## 项目结构

```
bin/mindleaf.mjs        入口（serve / mcp / 各种命令）
src/core/               纯逻辑，浏览器与 Node 共用
  doc.mjs               文档模型：normalize / rev / journal / 遍历
  ops.mjs               所有写操作（op），纯函数 + 原子批处理
  markdown.mjs          Markdown <-> 导图
  layout.mjs            布局算法（坐标、折行、主题色）
  svg.mjs               SVG 渲染（网页与导出共用）
src/export/             导出
  exporters.mjs         编排：json/md/svg/html/png/jpg/pdf
  image.mjs             自带 PNG 解码 + JPEG 编码（无第三方依赖）
  pdf.mjs               自带 PDF 写出（矢量文字 / 图片）
  raster.mjs            借用系统浏览器/sips/rsvg 把 SVG 变像素
src/server/             HTTP 服务（零依赖 node:http）
  store.mjs             项目、文件、加锁、历史、diff
  http.mjs              路由 + SSE + 静态资源
  templates.mjs         内置模板加载
src/mcp/server.mjs      MCP stdio 服务器
src/cli.mjs             命令行
web/                    网页 UI（原生 JS，无构建；侧栏可切"导图列表 / 大纲"）
templates/              内置模板（Markdown，可自己加）
tests/                  node:test 测试（只在开发时跑，不随包发布；README 里不谈测试）
docs/                   截图与验证记录（开发用）
integrations/           各家 agent 的接入配置与一键脚本
examples/               示例导图
```

## 开发约定

- 网页里左右两栏的宽度存在 `--sidebar-w` / `--inspector-w`，收起用的是
  `--sidebar-show` / `--inspector-show`（乘 0）。改布局时别再让内联栏宽覆盖掉"收起"。
- 侧栏字号用 `.sidebar` / `.inspector` 上的 `zoom: var(--panel-zoom)`，别去挨个改字号。
- **零依赖**是硬约束：不引入 npm 包（`package.json` 里没有 `dependencies` 是刻意的）。
- 改核心逻辑后跑 `npm test`（`node --test`），全部用例必须通过。
- 新增 op：`src/core/ops.mjs` 加函数 + 注册到 `applyOps` 的 switch + 更新 `OP_NAMES`，
  再补 `tests/ops.test.mjs`，MCP 的 `apply_ops` 会自动支持。
- 新增导出格式：在 `src/export/exporters.mjs` 的 `EXPORT_FORMATS` 与分支里加，三端自动可用。
- 新增模板：往 `templates/` 丢一个 `# 一级标题` 开头的 `.md`，再登记到 `templates/index.json`。
- 注释与用户可见文案用中文；变量名、函数名用英文。
- 不要手改 `maps/*.mindmap.json` 来"修 bug"——那是数据，不是代码。

## 踩过的坑（别重复踩）

1. **stdout 只能输出 JSON-RPC**。MCP 服务器里任何 `console.log` 都会让宿主断开连接，日志一律 `process.stderr.write`。
2. **不要依赖宿主给的 cwd**。Claude Desktop / GUI 启动的 agent 工作目录往往是 `/`，
   PATH 里也没有 nvm 的 node。所以：配置里写 node 绝对路径，并用 `--project` 显式传项目目录。
3. **多进程会同时写同一个文件**（网页服务 + 多个 agent）。Store 用 `O_EXCL` 伴生锁 + 原子 rename，
   加上 rev 校验；不要绕过 Store 直接 `fs.writeFileSync` 导图文件。
4. **PDF 中文**：内置 PDF 只有 Helvetica（ASCII）。有 Chrome/Edge 时走矢量 PDF（中文可选中），
   没有则退化为整页 JPEG（显示正确、文字不可选），并在结果里 `warnings` 说明。
5. **连线色是"连到该节点那条线"的颜色**（`lineColor`），子孙会继承最近祖先的设置；
   想整枝换颜色 / 字号 / 字体用 `update_node` 的 `subtree: true`，不要一个节点一个节点发 op。
   `boxWidth` / `boxHeight` 只对单节点生效。
6. **`sips` 转换 SVG 时不要依赖尺寸参数**：它忽略 `-z`，尺寸由 SVG 自身决定，所以导出前把
   `scale` 直接算进布局。
