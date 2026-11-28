/**
 * 内置模板：鼓励"用 Markdown 写模板"，这样模板本身就是可读、可改、可版本管理的文本，
 * 任何 agent 都能直接往 templates/ 里加一份新的 *.md 并登记到 index.json。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromMarkdown, guessTitle } from '../core/markdown.mjs';
import { docStats } from '../core/doc.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TEMPLATES_DIR = path.resolve(HERE, '../../templates');

let cache = null;

/** 读取模板清单（index.json 可选，缺失时扫描目录）。 */
export function listTemplates({ force = false } = {}) {
  if (cache && !force) return cache;
  const manifestPath = path.join(TEMPLATES_DIR, 'index.json');
  let manifest = { version: 1, templates: [] };
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    manifest = { version: 1, templates: [] };
  }
  const templates = [];
  for (const entry of manifest.templates ?? []) {
    const file = path.join(TEMPLATES_DIR, entry.file ?? `${entry.id}.md`);
    if (!fs.existsSync(file)) continue;
    const markdown = fs.readFileSync(file, 'utf8');
    const doc = fromMarkdown(markdown, { title: entry.title });
    const stats = docStats(doc);
    templates.push({
      id: entry.id,
      title: entry.title ?? guessTitle(markdown) ?? entry.id,
      emoji: entry.emoji ?? '🗂️',
      description: entry.description ?? '',
      tags: entry.tags ?? [],
      file: path.relative(TEMPLATES_DIR, file),
      nodes: stats.nodes,
      maxDepth: stats.maxDepth,
      markdown,
    });
  }
  // 目录里有、但 index.json 没登记的模板也纳入（方便用户自己丢文件进来）
  const registered = new Set(templates.map((item) => path.basename(item.file)));
  try {
    for (const name of fs.readdirSync(TEMPLATES_DIR)) {
      if (!name.endsWith('.md') || registered.has(name)) continue;
      const markdown = fs.readFileSync(path.join(TEMPLATES_DIR, name), 'utf8');
      const doc = fromMarkdown(markdown, {});
      const stats = docStats(doc);
      templates.push({
        id: name.replace(/\.md$/, ''),
        title: guessTitle(markdown) ?? name.replace(/\.md$/, ''),
        emoji: '🗂️',
        description: '自定义模板',
        tags: ['自定义'],
        file: name,
        nodes: stats.nodes,
        maxDepth: stats.maxDepth,
        markdown,
      });
    }
  } catch {
    /* 目录不存在时忽略 */
  }
  cache = templates;
  return templates;
}

/** 按 id 取模板（支持 id / 标题 / 文件名）。 */
export function getTemplate(idOrTitle) {
  const value = String(idOrTitle ?? '').trim().toLowerCase();
  if (!value) return null;
  const templates = listTemplates();
  return (
    templates.find((item) => item.id.toLowerCase() === value) ??
    templates.find((item) => item.title.toLowerCase() === value) ??
    templates.find((item) => item.id.toLowerCase().includes(value)) ??
    templates.find((item) => item.title.toLowerCase().includes(value)) ??
    null
  );
}

/**
 * 用模板造一份文档。
 * @param {string} idOrTitle
 * @param {{title?:string, rootText?:string}} options title 会覆盖模板里的根节点文字
 */
export function docFromTemplate(idOrTitle, options = {}) {
  const template = getTemplate(idOrTitle);
  if (!template) return null;
  const markdown = options.title ? template.markdown.replace(/^#\s+.*$/m, `# ${options.title}`) : template.markdown;
  const doc = fromMarkdown(markdown, { title: options.title ?? template.title });
  if (options.title) doc.title = options.title;
  if (options.rootText) {
    const root = doc.nodes.find((node) => node.parent == null);
    if (root) root.text = options.rootText;
  }
  return { doc, template };
}
