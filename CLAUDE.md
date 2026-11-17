# CLAUDE.md

Claude Code 会优先读这个文件，而本项目的 agent 说明统一维护在 **AGENTS.md**（避免两份文档漂移）。

👉 **请先读 [AGENTS.md](AGENTS.md)**，那里有完整的：文件格式、op 语义、MCP 工具表、目录结构、开发约定、踩过的坑。

三条最关键的，这里再说一遍：

1. 改导图优先用 MCP 工具（`mindleaf__*`）或 CLI，**不要手改 `maps/*.mindmap.json`**。
2. 先 `read_map` 拿节点 id，再用 id 改；多处改动用 `apply_ops`（原子）。
3. 人类可能同时在网页里编辑，动手前可以 `recent_changes` 看看对方刚改了什么。
