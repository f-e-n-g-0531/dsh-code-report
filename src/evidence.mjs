import {createHash} from 'node:crypto';

export const evidenceHash = value => createHash('sha256').update(value).digest('hex');
const bytes = value => Buffer.byteLength(value, 'utf8');
const MAX_EVIDENCE_ITEMS = 8192;
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;

function evidenceLimit(message) {
  return Object.assign(new Error(message + '；未截断证据，请缩小范围'), {code: 'code-report/analysis-plan'});
}

function boundedMatches(text, pattern) {
  const matches = [];
  for (const match of text.matchAll(pattern)) {
    if (matches.length >= MAX_EVIDENCE_ITEMS) throw evidenceLimit('证据结构超过 8192 项');
    matches.push(match);
  }
  return matches;
}

/** Split on Unicode code points, retaining every byte, including CRLF and trailing lines. */
function* textParts(text, maxBytes) {
  let yielded = false;
  let start = 0, offset = 0, size = 0;
  for (const character of text) {
    const length = bytes(character);
    if (size && size + length > maxBytes) {
      yield {start, end: offset, text: text.slice(start, offset)};
      yielded = true;
      start = offset;
      size = 0;
    }
    offset += character.length;
    size += length;
  }
  if (offset > start || !yielded) yield {start, end: offset, text: text.slice(start, offset)};
}

function diffHeader(block) {
  const bodyStart = block.search(/^@@/m);
  return bodyStart < 0 ? block : block.slice(0, bodyStart);
}

function fileName(block, fallback) {
  // Hunk lines can spell ---/+++ after their change prefix; they are never paths.
  block = diffHeader(block);
  const index = block.match(/^Index: (.*)\r?$/m);
  if (index) return index[1].replace(/\r$/, '');
  let header;
  for (const match of block.matchAll(/^(?:\+\+\+|---) (.*)\r?$/gm)) {
    if (!match[1].startsWith('/dev/null')) { header = match; break; }
  }
  if (header) {
    let name = header[1].replace(/\r$/, '').split('\t')[0];
    if (name !== '/dev/null') {
      if (name.startsWith('"')) {
        try { name = JSON.parse(name); } catch { return fallback; }
      }
      return /^[ab]\//.test(name) ? name.slice(2) : name;
    }
  }
  return fallback;
}

/** Partition a diff without parsing/reformatting its contents. Headers are evidence too. */
function* diffSections(diff, files) {
  const starts = boundedMatches(diff, /^(?:diff --git |Index: )/gm).map(match => match.index);
  if (!starts.length || starts[0] !== 0) starts.unshift(0);
  for (let index = 0; index < starts.length; index++) {
    const start = starts[index], end = starts[index + 1] ?? diff.length;
    const block = diff.slice(start, end);
    const file = fileName(block, files[index] ?? '(unparsed diff path)');
    const hunks = boundedMatches(block, /^@@[^\r\n]*/gm);
    const cuts = [0, ...hunks.map(match => match.index).filter(offset => offset > 0)];
    for (let part = 0; part < cuts.length; part++) {
      const from = cuts[part], to = cuts[part + 1] ?? block.length;
      const text = block.slice(from, to);
      yield {file, start: start + from, end: start + to, text,
        kind: text.startsWith('@@') ? 'hunk' : 'file',
        // This is a display label only. The complete original header remains in text.
        hunk: text.startsWith('@@') ? text.split(/\r?\n/, 1)[0].slice(0, 256) : null};
    }
  }
}

/** A conservative file manifest; unsupported formats remain unknown rather than inferred. */
function manifestFor(repository, repositoryIndex) {
  const diff = repository.diff;
  const starts = boundedMatches(diff, /^(?:diff --git |Index: )/gm).map(match => match.index);
  if (!starts.length || starts[0] !== 0) starts.unshift(0);
  const files = repository.files ?? [];
  const result = [];
  const seen = new Set();
  for (let index = 0; index < starts.length; index++) {
    const block = diff.slice(starts[index], starts[index + 1] ?? diff.length);
    if (!block) continue;
    const header = diffHeader(block);
    const file = fileName(header, files[index] ?? null);
    const binary = /^(?:Binary files |Cannot display: file marked as a binary type|GIT binary patch)/m.test(header);
    // Gitlink identity is a header mode, never inferred from user-controlled hunk text.
    const metadataEnd = header.search(/^(?:--- |\+\+\+ )/m);
    const gitMetadata = metadataEnd < 0 ? header : header.slice(0, metadataEnd);
    const submodule = header.startsWith('diff --git ') &&
      /^(?:(?:old mode|new mode|new file mode|deleted file mode) 160000|index [0-9a-f]+\.\.[0-9a-f]+ 160000)\r?$/m.test(gitMetadata);
    let status = 'unknown';
    if (/^(?:new file mode |--- \/dev\/null)|^--- [^\r\n]*\(nonexistent\)/m.test(header)) status = 'add';
    else if (/^(?:deleted file mode |\+\+\+ \/dev\/null)|^\+\+\+ [^\r\n]*\(nonexistent\)/m.test(header)) status = 'delete';
    else if (block.startsWith('@@') || /^Property changes on:|^diff --git |^Index: /m.test(header)) status = 'modify';
    result.push({repository: repository.path, repositoryIndex, path: file, status, binary, submodule,
      content: binary ? 'binary' : submodule ? 'submodule-pointer' : status === 'unknown' ? 'unknown' : 'text-or-properties',
      renamePolicy: 'no-renames', a: repository.a, b: repository.b});
    if (file) seen.add(file);
  }
  for (const file of files) {
    if (result.length >= MAX_EVIDENCE_ITEMS) throw evidenceLimit('文件清单超过 8192 项');
    if (!seen.has(file)) result.push({repository: repository.path, repositoryIndex, path: file, status: 'unknown', binary: false, submodule: false, content: 'not-in-text-diff', renamePolicy: 'no-renames', a: repository.a, b: repository.b});
  }
  return result;
}

export function snapshotHash(snapshot) {
  return evidenceHash(JSON.stringify(snapshot));
}

/** IDs bind the fixed snapshot, source, exact offset and bytes; never model-generated. */
export function createEvidenceIndex(snapshot, {maxTextBytes = 12000} = {}) {
  if (!snapshot || !Array.isArray(snapshot.repositories) || !Array.isArray(snapshot.context)) {
    throw new Error('无效证据快照');
  }
  if (!Number.isInteger(maxTextBytes) || maxTextBytes < 64) throw new Error('证据分片预算无效');
  let sourceBytes = 0;
  for (const source of [...snapshot.repositories.map(item => item.diff), ...snapshot.context.map(item => item.text)]) {
    if (typeof source !== 'string') throw new Error('证据正文必须是文本');
    sourceBytes += bytes(source);
    if (sourceBytes > MAX_SOURCE_BYTES) throw evidenceLimit('证据正文超过 8 MiB');
  }
  const fingerprint = snapshotHash(snapshot);
  const items = [], excluded = [];
  const append = (metadata, text, sourceStart = 0) => {
    for (const part of textParts(text, maxTextBytes)) {
      if (items.length >= MAX_EVIDENCE_ITEMS) throw evidenceLimit('证据单元超过 8192 项');
      const item = {...metadata, start: sourceStart + part.start, end: sourceStart + part.end, text: part.text};
      item.id = 'e-' + evidenceHash(JSON.stringify([fingerprint, item])).slice(0, 32);
      items.push(item);
    }
  };
  snapshot.repositories.forEach((repository, index) => {
    const source = 'repository:' + index;
    for (const path of repository.excludedPaths ?? []) excluded.push({repository: repository.path, path, reason: 'internal-path'});
    const metadata = {source, repository: repository.path, repositoryType: repository.type, identity: repository.identity ?? null, a: repository.a, b: repository.b, provenance: 'version-diff'};
    if (typeof repository.diff !== 'string') throw new Error('版本差异必须是文本');
    if (!repository.diff) {
      append({...metadata, kind: 'scope', file: null, hunk: null}, JSON.stringify({files: repository.files, diff: '', note: '当前提供的固定端点无文本差异；不代表二进制或未提供内容已分析'}));
      return;
    }
    for (const section of diffSections(repository.diff, repository.files ?? [])) {
      append({...metadata, kind: section.kind, file: section.file, hunk: section.hunk}, section.text, section.start);
    }
  });
  snapshot.context.forEach((context, index) => {
    if (typeof context.text !== 'string') throw new Error('源码上下文必须是文本');
    const repository = snapshot.repositories.find(item => item.path === context.repository);
    append({source: 'context:' + index, repository: context.repository ?? null, identity: repository?.identity ?? null, file: context.path,
      revision: context.revision ?? null, provenance: context.provenance ?? 'current-workspace',
      hash: context.hash, kind: 'context', hunk: null}, context.text);
  });
  if (!items.length) append({source: 'snapshot', repository: null, file: null, kind: 'scope', hunk: null}, '未提供项目差异或源码，不能形成代码结论。');
  const manifest = snapshot.repositories.flatMap(manifestFor);
  return {snapshotHash: fingerprint, items, excluded, manifest};
}
