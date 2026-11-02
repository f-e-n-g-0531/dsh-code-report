import {createHash} from 'node:crypto';

export const EVIDENCE_FORMAT_VERSION = 2;
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

/** Partition exact Unicode text, keeping CRLF and every original code point. */
function* textParts(text, maxBytes) {
  let yielded = false, start = 0, offset = 0, size = 0;
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

function includedPaths(repository) {
  const paths = new Set();
  for (const path of repository.files ?? []) {
    if (typeof path !== 'string') throw new Error('变更路径必须是文本');
    paths.add(path);
  }
  for (const change of repository.changes ?? []) {
    if (!change || typeof change.path !== 'string') throw new Error('可信变更路径无效');
    paths.add(change.path);
  }
  if (paths.size > MAX_EVIDENCE_ITEMS) throw evidenceLimit('文件清单超过 8192 项');
  return paths;
}

function unquoteGit(value) {
  if (!value.startsWith('"')) return value;
  try { const result = JSON.parse(value); return typeof result === 'string' ? result : null; } catch { return null; }
}

/** Paths are accepted only by equality with the collector's included-path list. */
function matchPath(repository, candidates, included) {
  const matches = new Set();
  for (let name of candidates) {
    if (name === null || name === '/dev/null') continue;
    if (repository.type === 'svn') {
      if ((name === '.' || name === '') && included.has('')) matches.add('');
      if (included.has(name)) matches.add(name);
      for (const root of [repository.identity?.urlA, repository.identity?.urlB]) {
        if (typeof root !== 'string' || (name !== root && !name.startsWith(root + '/'))) continue;
        try {
          const relative = decodeURIComponent(name.slice(root.length).replace(/^\//, ''));
          if (included.has(relative)) matches.add(relative);
        } catch { /* Malformed URL labels remain unassigned. */ }
      }
    } else {
      name = unquoteGit(name);
      if (name === null) continue;
      const relative = /^[ab]\//.test(name) ? name.slice(2) : name;
      if (included.has(relative)) matches.add(relative);
    }
  }
  return matches.size === 1 ? [...matches][0] : null;
}

function blockHeader(block) {
  // SVN values have ## hunks, not @@. The property label is metadata, its values are not.
  const end = block.search(/^(?:@@|##|Property changes on:)/m);
  return end < 0 ? block : block.slice(0, end);
}

function blockPath(repository, block, included) {
  const header = blockHeader(block);
  const index = header.match(/^Index: (.*)\r?$/m);
  const property = block.match(/^Property changes on: (.*)\r?$/m);
  if (property) return matchPath(repository, [property[1].replace(/\r$/, '')], included);
  if (index) return matchPath(repository, [index[1].replace(/\r$/, '')], included);
  const candidates = [];
  for (const match of header.matchAll(/^(?:---|\+\+\+) (.*)\r?$/gm)) {
    candidates.push(match[1].replace(/\r$/, '').split('\t')[0]);
  }
  if (!candidates.length && repository.type === 'git') {
    const git = header.match(/^diff --git (.*)\r?$/m);
    if (git) {
      // A delimiter inside a quoted/path-with-spaces label is ambiguous: never guess by order.
      for (const path of included) {
        if ([['a/' + path, 'b/' + path], [JSON.stringify('a/' + path), JSON.stringify('b/' + path)]].some(([a, b]) => git[1].replace(/\r$/, '') === a + ' ' + b)) candidates.push('a/' + path);
      }
    }
  }
  return matchPath(repository, candidates, included);
}

/** One parser supplies both raw evidence attribution and the public manifest. */
function sourceRanges(repository, included) {
  const parts = repository.diffParts;
  if (parts === undefined) return [{start: 0, end: repository.diff.length, path: null, assigned: false}];
  if (!Array.isArray(parts) || parts.length > MAX_EVIDENCE_ITEMS) throw new Error('差异来源范围无效');
  let offset = 0;
  for (const part of parts) {
    if (!part || typeof part.path !== 'string' || !included.has(part.path) || !Number.isInteger(part.start) || !Number.isInteger(part.end) || part.start !== offset || part.end <= part.start || part.end > repository.diff.length) throw new Error('差异来源范围必须连续覆盖原文且路径属于 included');
    offset = part.end;
  }
  if (offset !== repository.diff.length) throw new Error('差异来源范围未覆盖完整原文');
  return parts.map(part => ({...part, assigned: true}));
}

function parseRepository(repository) {
  const diff = repository.diff, included = includedPaths(repository);
  const pattern = repository.type === 'svn' ? /^(?:Index: |Property changes on: )/gm : /^diff --git /gm;
  const blocks = [];
  for (const range of sourceRanges(repository, included)) {
    const part = diff.slice(range.start, range.end);
    const starts = boundedMatches(part, pattern).map(match => range.start + match.index);
    if (!starts.length || starts[0] !== range.start) starts.unshift(range.start);
    for (let index = 0; index < starts.length; index++) {
    const start = starts[index], end = starts[index + 1] ?? range.end;
    const text = diff.slice(start, end);
    if (!text) continue;
    const header = blockHeader(text);
    const file = range.assigned ? range.path : blockPath(repository, text, included);
    const property = text.startsWith('Property changes on: ');
    const metadataEnd = header.search(/^(?:--- |\+\+\+ )/m);
    const gitMetadata = metadataEnd < 0 ? header : header.slice(0, metadataEnd);
    const submodule = repository.type === 'git' && header.startsWith('diff --git ') && /^(?:(?:old mode|new mode|new file mode|deleted file mode) 160000|index [0-9a-f]+\.\.[0-9a-f]+ 160000)\r?$/m.test(gitMetadata);
    const binary = /^(?:Binary files |Cannot display: file marked as a binary type|GIT binary patch)/m.test(header);
    let status = 'unknown';
    if (/^(?:new file mode |--- \/dev\/null)|^--- [^\r\n]*\(nonexistent\)/m.test(header)) status = 'add';
    else if (/^(?:deleted file mode |\+\+\+ \/dev\/null)|^\+\+\+ [^\r\n]*\(nonexistent\)/m.test(header)) status = 'delete';
    else if (/^diff --git |^Index: /m.test(header) || property || text.startsWith('@@')) status = 'modify';
    if (blocks.length >= MAX_EVIDENCE_ITEMS) throw evidenceLimit('证据结构超过 8192 项');
    blocks.push({start, end, text, file, header, property, binary, submodule, status});
    }
  }
  const byPath = new Map();
  for (const block of blocks) {
    if (block.file === null) continue;
    if (!byPath.has(block.file)) byPath.set(block.file, []);
    byPath.get(block.file).push(block);
  }
  const changes = new Map((repository.changes ?? []).map(change => [change.path, change]));
  const manifest = [];
  for (const path of included) {
    const assigned = byPath.get(path) ?? [];
    const change = changes.get(path);
    const inferred = new Set(assigned.map(block => block.status).filter(status => status !== 'unknown'));
    const status = change ? ({added: 'add', deleted: 'delete', modified: 'modify', none: change.props === 'modified' ? 'modify' : 'unknown'}[change.item] ?? 'unknown') : inferred.size === 1 ? [...inferred][0] : 'unknown';
    const binary = assigned.some(block => block.binary), submodule = assigned.some(block => block.submodule);
    manifest.push({repository: repository.path, path, status, binary, submodule,
      kind: change?.kind ?? 'unknown', item: change?.item ?? 'unknown', props: change?.props ?? 'unknown',
      content: assigned.length ? binary ? 'binary' : submodule ? 'submodule-pointer' : 'text-or-properties' : 'not-in-text-diff',
      renamePolicy: repository.type === 'git' ? 'no-renames' : 'not-inferred', a: repository.a, b: repository.b});
  }
  return {blocks, manifest, assignedPaths: new Set(byPath.keys())};
}

function* sections(block) {
  const hunks = boundedMatches(block.text, block.property ? /^##[^\r\n]*/gm : /^@@[^\r\n]*/gm);
  const cuts = [0, ...hunks.map(match => match.index).filter(offset => offset > 0)];
  for (let index = 0; index < cuts.length; index++) {
    const from = cuts[index], to = cuts[index + 1] ?? block.text.length;
    const text = block.text.slice(from, to);
    const hunk = /^(?:@@|##)/.test(text);
    yield {text, start: block.start + from, file: block.file, kind: hunk ? block.property ? 'property-hunk' : 'hunk' : block.property ? 'property' : 'file', hunk: hunk ? text.split(/\r?\n/, 1)[0].slice(0, 256) : null};
  }
}

export function snapshotHash(snapshot) { return evidenceHash(JSON.stringify(snapshot)); }

/** Raw sources and synthetic summaries have independent coordinate systems and budgets. */
export function createEvidenceIndex(snapshot, {maxTextBytes = 12000} = {}) {
  if (!snapshot || !Array.isArray(snapshot.repositories) || !Array.isArray(snapshot.context)) throw new Error('无效证据快照');
  if (!Number.isInteger(maxTextBytes) || maxTextBytes < 64) throw new Error('证据分片预算无效');
  const fingerprint = snapshotHash(snapshot), items = [], excluded = [], manifest = [];
  let sourceBytes = 0;
  const account = text => {
    if (typeof text !== 'string') throw new Error('证据正文必须是文本');
    sourceBytes += bytes(text);
    if (sourceBytes > MAX_SOURCE_BYTES) throw evidenceLimit('证据正文和合成范围超过 8 MiB');
  };
  const append = (metadata, text, sourceStart = 0) => {
    for (const part of textParts(text, maxTextBytes)) {
      if (items.length >= MAX_EVIDENCE_ITEMS) throw evidenceLimit('证据单元超过 8192 项');
      const item = {...metadata, start: sourceStart + part.start, end: sourceStart + part.end, text: part.text};
      item.id = 'e-' + evidenceHash(JSON.stringify([EVIDENCE_FORMAT_VERSION, fingerprint, item])).slice(0, 32);
      items.push(item);
    }
  };
  const synthetic = (metadata, value) => { const text = JSON.stringify(value); account(text); append(metadata, text); };
  snapshot.repositories.forEach((repository, index) => {
    account(repository.diff);
    const {blocks, manifest: files, assignedPaths} = parseRepository(repository);
    manifest.push(...files.map(file => ({...file, repositoryIndex: index})));
    if (manifest.length > MAX_EVIDENCE_ITEMS) throw evidenceLimit('文件清单超过 8192 项');
    for (const path of repository.excludedPaths ?? []) excluded.push({repository: repository.path, path, reason: 'internal-path'});
    const metadata = {repository: repository.path, repositoryType: repository.type, identity: repository.identity ?? null, a: repository.a, b: repository.b};
    for (const block of blocks) for (const section of sections(block)) append({...metadata, source: 'repository:' + index, provenance: 'version-diff', kind: section.kind, file: section.file, hunk: section.hunk}, section.text, section.start);
    for (const file of files.filter(file => !assignedPaths.has(file.path))) {
      synthetic({...metadata, source: 'scope:' + index + ':' + evidenceHash(file.path).slice(0, 16), provenance: 'version-summary', kind: 'scope', file: file.path, hunk: null}, {path: file.path, kind: file.kind, item: file.item, props: file.props, status: file.status, note: '固定版本比较列出此路径，但未提供可归属的文本差异；不可据此推断内容或接口无变化。'});
    }
    if (!repository.diff && !files.length) synthetic({...metadata, source: 'scope:' + index + ':empty', provenance: 'version-summary', kind: 'scope', file: null, hunk: null}, {files: [], note: '固定端点无文本差异且没有 included 变更路径；未提供内容和调用图仍待确认。'});
  });
  snapshot.context.forEach((context, index) => {
    account(context.text);
    const repository = snapshot.repositories.find(item => item.path === context.repository);
    append({source: 'context:' + index, repository: context.repository ?? null, identity: repository?.identity ?? null, file: context.path, revision: context.revision ?? null, provenance: context.provenance ?? 'current-workspace', hash: context.hash, kind: 'context', hunk: null}, context.text);
  });
  if (!items.length) synthetic({source: 'scope:empty', repository: null, file: null, provenance: 'version-summary', kind: 'scope', hunk: null}, {note: '未提供项目差异或源码，不能形成代码结论。'});
  return {formatVersion: EVIDENCE_FORMAT_VERSION, snapshotHash: fingerprint, items, excluded, manifest, sourceBytes};
}
