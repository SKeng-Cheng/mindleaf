#!/usr/bin/env node
/**
 * Mindleaf 可执行入口。
 *
 * 用法:
 *   mindleaf serve        启动网页
 *   mindleaf mcp          以 MCP stdio 服务器运行（给 DSH / Codex / Claude 用）
 *   mindleaf --help       查看全部命令
 */
import { main } from '../src/cli.mjs';

const argv = process.argv.slice(2);
main(argv)
  .then((code) => {
    process.exitCode = code ?? 0;
  })
  .catch((error) => {
    const message = error?.message ?? String(error);
    process.stderr.write(`\u001b[31m错误\u001b[0m: ${message}\n`);
    if (process.env.MINDLEAF_DEBUG) process.stderr.write(`${error?.stack ?? ''}\n`);
    process.exitCode = 1;
  });
