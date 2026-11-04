import {createHash} from 'node:crypto';
import {snapshotJsonChunks} from './snapshot-json.mjs';

export const EVIDENCE_FORMAT_VERSION = 2;
export const evidenceHash = value => createHash('sha256').update(value).digest('hex');
const bytes = value => Buffer.byteLength(value, 'utf8');

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

function blockPath(repository, block, included, gitLabels) {
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
      // Labels are matched against exact collector names, never guessed by order.
      const path = gitLabels.get(git[1].replace(/\r$/, ''));
      if (typeof path === 'string') return path;
      return null;
    }
  }
  return matchPath(repository, candidates, included);
}

/** One parser supplies both raw evidence attribution and the public manifest. */
function sourceRanges(repository, included) {
  const parts = repository.diffParts;
  if (parts === undefined) return [{start: 0, end: repository.diff.length, path: null, assigned: false}];
  if (!Array.isArray(parts)) throw new Error('差异来源范围无效');
  let offset = 0;
  for (const part of parts) {
    if (!part || typeof part.path !== 'string' || !included.has(part.path) || !Number.isInteger(part.start) || !Number.isInteger(part.end) || part.start !== offset || part.end <= part.start || part.end > repository.diff.length) throw new Error('差异来源范围必须连续覆盖原文且路径属于 included');
    offset = part.end;
  }
  if (offset !== repository.diff.length) throw new Error('差异来源范围未覆盖完整原文');
  return parts.map(part => ({...part, assigned: true}));
}

export function parseRepository(repository) {
  const diff = repository.diff, included = includedPaths(repository);
  // Header-only mode/binary changes lack ---/+++ labels. Index their exact Git
  // spellings once rather than scanning every included path for every block.
  const gitLabels = new Map();
  if (repository.type === 'git') for (const path of included) {
    for (const label of ['a/' + path + ' b/' + path, JSON.stringify('a/' + path) + ' ' + JSON.stringify('b/' + path)]) {
      if (!gitLabels.has(label)) gitLabels.set(label, path);
      else if (gitLabels.get(label) !== path) gitLabels.set(label, null);
    }
  }
  const pattern = repository.type === 'svn' ? /^(?:Index: |Property changes on: )/gm : /^diff --git /gm;
  const blocks = [];
  for (const range of sourceRanges(repository, included)) {
    const part = diff.slice(range.start, range.end);
    const starts = Array.from(part.matchAll(pattern), match => range.start + match.index);
    if (!starts.length || starts[0] !== range.start) starts.unshift(range.start);
    for (let index = 0; index < starts.length; index++) {
    const start = starts[index], end = starts[index + 1] ?? range.end;
    const text = diff.slice(start, end);
    if (!text) continue;
    const header = blockHeader(text);
    const file = range.assigned ? range.path : blockPath(repository, text, included, gitLabels);
    const property = text.startsWith('Property changes on: ');
    const metadataEnd = header.search(/^(?:--- |\+\+\+ )/m);
    const gitMetadata = metadataEnd < 0 ? header : header.slice(0, metadataEnd);
    const submodule = repository.type === 'git' && header.startsWith('diff --git ') && /^(?:(?:old mode|new mode|new file mode|deleted file mode) 160000|index [0-9a-f]+\.\.[0-9a-f]+ 160000)\r?$/m.test(gitMetadata);
    const binary = /^(?:Binary files |Cannot display: file marked as a binary type|GIT binary patch)/m.test(header);
    let status = 'unknown';
    if (/^(?:new file mode |--- \/dev\/null)|^--- [^\r\n]*\(nonexistent\)/m.test(header)) status = 'add';
    else if (/^(?:deleted file mode |\+\+\+ \/dev\/null)|^\+\+\+ [^\r\n]*\(nonexistent\)/m.test(header)) status = 'delete';
    else if (/^diff --git |^Index: /m.test(header) || property || text.startsWith('@@')) status = 'modify';
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
  const cuts = [0];
  for (const match of block.text.matchAll(block.property ? /^##[^\r\n]*/gm : /^@@[^\r\n]*/gm)) if (match.index > 0) cuts.push(match.index);
  for (let index = 0; index < cuts.length; index++) {
    const from = cuts[index], to = cuts[index + 1] ?? block.text.length;
    const text = block.text.slice(from, to);
    const hunk = /^(?:@@|##)/.test(text);
    yield {text, start: block.start + from, file: block.file, kind: hunk ? block.property ? 'property-hunk' : 'hunk' : block.property ? 'property' : 'file', hunk: hunk ? text.split(/\r?\n/, 1)[0].slice(0, 256) : null};
  }
}

export function snapshotHash(snapshot) { const hash = createHash('sha256'); for (const chunk of snapshotJsonChunks(snapshot)) hash.update(chunk); return hash.digest('hex'); }

/** Raw sources and synthetic summaries have independent coordinates; every byte is counted. */
export function createEvidenceIndex(snapshot, {maxTextBytes = 12000} = {}) {
  if (!snapshot || !Array.isArray(snapshot.repositories) || !Array.isArray(snapshot.context)) throw new Error('无效证据快照');
  if (!Number.isInteger(maxTextBytes) || maxTextBytes < 64) throw new Error('证据分片预算无效');
  const fingerprint = snapshotHash(snapshot), items = [], excluded = [], manifest = [];
  let sourceBytes = 0;
  const account = text => {
    if (typeof text !== 'string') throw new Error('证据正文必须是文本');
    sourceBytes += bytes(text);
  };
  const append = (metadata, text, sourceStart = 0) => {
    for (const part of textParts(text, maxTextBytes)) {
      const item = {...metadata, start: sourceStart + part.start, end: sourceStart + part.end, text: part.text};
      item.id = 'e-' + evidenceHash(JSON.stringify([EVIDENCE_FORMAT_VERSION, fingerprint, item])).slice(0, 32);
      items.push(item);
    }
  };
  const synthetic = (metadata, value) => { const text = JSON.stringify(value); account(text); append(metadata, text); };
  snapshot.repositories.forEach((repository, index) => {
    account(repository.diff);
    const {blocks, manifest: files, assignedPaths} = parseRepository(repository);
    for (const file of files) manifest.push({...file, repositoryIndex: index});
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
