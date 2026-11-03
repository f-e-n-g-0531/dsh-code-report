import path from 'node:path';
import {lstat, realpath, opendir} from 'node:fs/promises';
import {relative, secretPath} from './paths.mjs';

const SKIP_DIRECTORY = /^(?:node_modules|dist|build|Library|Temp|obj|bin|coverage|cache|vendor|target|out|bower_components|__pycache__)$/i;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const display = value => value.split(path.sep).join('/') || '.';
async function checked(budget, action) {
 budget.check();
 try { return await action(); } finally { budget.check(); }
}

// Inspect the lexical chain BEFORE realpath: resolving first would hide junctions,
// symlink roots, and aliases of sensitive directories. This also checks cwd ancestors.
async function inspect(cwd, name, budget) {
 relative(name);
 if (secretPath(name)) throw new Error('禁止采集凭据或仓库内部路径：' + name);
 const base = path.resolve(cwd), target = path.resolve(base, name);
 const baseParts = base.slice(path.parse(base).root.length).split(path.sep).filter(Boolean);
 let current = path.parse(base).root, stat = await checked(budget, () => lstat(current));
 if (stat.isSymbolicLink()) return {excluded:'符号链接 / junction'};
 for (const part of baseParts) {
  current = path.join(current, part);
  stat = await checked(budget, () => lstat(current));
  if (stat.isSymbolicLink()) return {excluded:'符号链接 / junction'};
 }
 const parts = path.relative(base, target).split(path.sep).filter(Boolean);
 for (let i = 0; i < parts.length; i++) {
  current = path.join(current, parts[i]);
  stat = await checked(budget, () => lstat(current));
  if (stat.isSymbolicLink()) return {excluded:'符号链接 / junction'};
  if (parts[i].startsWith('.')) return {excluded:'点前缀隐藏路径'};
  if ((i < parts.length - 1 || stat.isDirectory()) && SKIP_DIRECTORY.test(parts[i])) return {excluded:'依赖 / 构建产物目录'};
  if (i < parts.length - 1 && !stat.isDirectory()) return {excluded:'非普通文件 / 目录'};
 }
 if (!stat.isDirectory() && !stat.isFile()) return {excluded:'非普通文件 / 目录'};
 const canonical = await checked(budget, () => realpath(target));
 const canonicalBase = await checked(budget, () => realpath(base));
 const rel = path.relative(canonicalBase, canonical);
 if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('路径或链接指向工作区外：' + name);
 if (secretPath(rel)) throw new Error('禁止采集凭据或仓库内部路径：' + name);
 return {canonical, name:display(rel), directory:stat.isDirectory()};
}

/** Revalidate every ancestor immediately before opening a selected ordinary file. */
export async function resolveContextFile(cwd, name, budget) {
 const entry = await checked(budget, () => inspect(cwd, name, budget));
 if (entry.excluded || entry.directory) throw new Error('源码上下文不再是可读取的普通文件：' + name);
 return entry.canonical;
}


/** Metadata-only streaming expansion. No size/depth cap; failures never return a partial list. */
export async function expandContextPaths(cwd, names, budget, {onProgress = () => {}} = {}) {
 const files = new Map(), seen = new Set(), exclusions = new Map(), limitations = [];
 const exclude = reason => exclusions.set(reason, (exclusions.get(reason) || 0) + 1);
 // Each directory is enumerated once, with one open handle, without recursive calls or name arrays.
 const directories = [];
 let entries = 0, emptyDirectories = 0;
 const emptyExamples = [];
 async function visit(name, explicit, parent) {
  budget.check();
  if (++entries % 256 === 0) {
   onProgress({phase:'collecting', completed:0, total:0, label:'已检查源码目录 ' + entries + ' 项，发现 ' + files.size + ' 个文件'});
   budget.check();
  }
  if (explicit) { relative(name); if (secretPath(name)) throw new Error('禁止采集凭据或仓库内部路径：' + name); }
  if (!explicit && secretPath(name)) { exclude('敏感路径（secretPath，未读取正文）'); return; }
  const entry = await checked(budget, () => inspect(cwd, name, budget));
  if (entry.excluded) { exclude(entry.excluded); return; }
  if (seen.has(entry.canonical)) return;
  seen.add(entry.canonical);
  if (!entry.directory) {
   files.set(entry.canonical, entry.name);
   if (parent) parent.hasFiles = true;
  } else directories.push({name, entry, parent, hasFiles:false});
 }
 for (const name of names) {
  const start = directories.length;
  await visit(name, true);
  for (let i = start; i < directories.length; i++) {
   const item = directories[i];
   budget.check();
   // Queueing creates a delay before open: revalidate aliases/ancestors again at the boundary.
   const current = await checked(budget, () => inspect(cwd, item.name, budget));
   if (current.excluded) { exclude(current.excluded); continue; }
   if (!current.directory || current.canonical !== item.entry.canonical) throw new Error('源码目录在展开期间发生变化：' + item.name);
   const dir = await opendir(current.canonical, {bufferSize:32});
   try {
    budget.check();
    while (true) {
     const child = await checked(budget, () => dir.read());
     if (!child) break;
     await visit(path.join(item.name, child.name), false, item);
    }
   } finally {
    // Always close even when cancellation interrupts metadata reads.
    try { await dir.close(); } finally { budget.check(); }
   }
  }
  // Children occur after parents; propagate subtree presence iteratively, not on the JS stack.
  for (let i = directories.length - 1; i >= start; i--) {
   const item = directories[i];
   if (item.hasFiles && item.parent) item.parent.hasFiles = true;
   if (!item.hasFiles) {
    emptyDirectories++;
    if (emptyExamples.length < 3) emptyExamples.push(item.entry.name);
   }
  }
 }
 budget.check();
 if (emptyDirectories) limitations.push('源码目录展开中 ' + emptyDirectories + ' 个目录为 0 个新增普通文件（空目录、全部排除或已去重）；示例：' + emptyExamples.join('、') + '。示例不是完整目录清单，未读取目录正文。');
 if (exclusions.size) limitations.push('源码目录展开已排除 ' + [...exclusions.values()].reduce((a,b) => a+b, 0) + ' 个文件 / 目录条目：' + [...exclusions].sort(([a],[b]) => compare(a,b)).map(([reason, count]) => reason + ' ' + count + ' 项').join('；') + '。排除目录不递归，未读取其正文，不属于报告覆盖。');
 return {paths:[...files.values()].sort(compare), limitations};
}
