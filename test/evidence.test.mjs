import test from 'node:test';
import assert from 'node:assert/strict';
import {createEvidenceIndex} from '../src/evidence.mjs';
import {createAnalysisPlan} from '../src/report.mjs';
import {estimatedInputBytes} from '../src/analysis.mjs';

const snapshot = diff => ({title: '证据测试', createdAt: 'fixed', limitations: [], context: [], repositories: [{path: 'app', type: 'git', a: 'a'.repeat(40), b: 'b'.repeat(40), files: ['api.js', 'other.js'], excludedPaths: ['cache/.svn/wc.db'], diff}]});
const diff = 'diff --git a/api.js b/api.js\r\n--- a/api.js\r\n+++ b/api.js\r\n@@ -1 +1 @@\r\n-old\r\n+新😀\r\n@@ -10 +10 @@\r\n-x\r\n+y\r\ndiff --git a/other.js b/other.js\n--- a/other.js\n+++ b/other.js\n@@ -1 +1 @@\n-a\n+b';

test('stable evidence IDs retain file headers, multiple hunks and exact original bytes', () => {
  const source = snapshot(diff), first = createEvidenceIndex(source, {maxTextBytes: 64});
  assert.deepEqual(first, createEvidenceIndex(source, {maxTextBytes: 64}));
  assert.equal(first.items.map(item => item.text).join(''), diff);
  assert.equal(new Set(first.items.map(item => item.id)).size, first.items.length);
  assert.ok(first.items.some(item => item.file === 'api.js' && item.hunk === '@@ -1 +1 @@'));
  assert.ok(first.items.some(item => item.file === 'other.js'));
  assert.deepEqual(first.excluded, [{repository: 'app', path: 'cache/.svn/wc.db', reason: 'internal-path'}]);
  for (let index = 1; index < first.items.length; index++) assert.equal(first.items[index].start, first.items[index - 1].end);
  const altered = createEvidenceIndex({...source, repositories: [{...source.repositories[0], b: 'different'}]}, {maxTextBytes: 64});
  assert.notEqual(first.items[0].id, altered.items[0].id);
});

test('SVN Index paths, deleted files and unparsed diffs are retained without dropping text', () => {
  for (const text of ['Index: removed.txt\n===\n--- removed.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n', 'Property changes on: folder\n___\nAdded: custom\n+ yes\n', 'binary pointer only\n']) {
    const source = snapshot(text);
    source.repositories[0].type = 'svn';
    source.repositories[0].files = ['removed.txt', 'folder'];
    const index = createEvidenceIndex(source);
    assert.equal(index.items.filter(item => item.provenance === 'version-diff').map(item => item.text).join(''), text);
  }
  const source = snapshot('Index: removed.txt\n===\n');
  source.repositories[0].type = 'svn'; source.repositories[0].files = ['removed.txt'];
  assert.equal(createEvidenceIndex(source).items[0].file, 'removed.txt');
});

test('manifest classifies add/delete, binary, submodule and unknown entries conservatively', () => {
  const source = snapshot('diff --git a/new.js b/new.js\nnew file mode 100644\n--- /dev/null\n+++ b/new.js\n@@ -0,0 +1 @@\n+new\ndiff --git a/old.js b/old.js\ndeleted file mode 100644\n--- a/old.js\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\ndiff --git a/image.png b/image.png\nBinary files a/image.png and b/image.png differ\ndiff --git a/module b/module\nindex abc..def 160000\n--- a/module\n+++ b/module\n@@ -1 +1 @@\n-Subproject commit abc\n+Subproject commit def\n');
  source.repositories[0].files = ['new.js', 'old.js', 'image.png', 'module', 'missing'];
  const manifest = createEvidenceIndex(source).manifest;
  assert.equal(manifest.find(file => file.path === 'new.js').status, 'add');
  assert.equal(manifest.find(file => file.path === 'old.js').status, 'delete');
  assert.equal(manifest.find(file => file.path === 'image.png').binary, true);
  assert.equal(manifest.find(file => file.path === 'module').submodule, true);
  assert.equal(manifest.find(file => file.path === 'missing').content, 'not-in-text-diff');
  assert.ok(manifest.every(file => file.renamePolicy === 'no-renames'));
});

test('hunk content cannot forge path, add/delete status, binary or Gitlink metadata', () => {
  const fakeBody = '@@ -1,6 +1,6 @@\n--- /dev/null\n+++ /dev/null\n--- a/forged-old.js\n+++ b/forged-new.js\n-Binary files fake\n+GIT binary patch\n-Subproject commit old\n+Subproject commit new\n';
  for (const actualHeader of [
    'diff --git a/api.js b/api.js\nindex abc..def 100644\n--- a/api.js\n+++ b/api.js\n',
    'diff --git a/api.js b/api.js\nindex abc..def 100644\n',
    'Index: api.js\n===\n--- api.js (revision 1)\n+++ api.js (revision 2)\n',
  ]) {
    const source = snapshot(actualHeader + fakeBody);
    source.repositories[0].files = ['api.js'];
    if (actualHeader.startsWith('Index:')) source.repositories[0].type = 'svn';
    const index = createEvidenceIndex(source);
    assert.equal(index.manifest[0].path, 'api.js');
    assert.equal(index.manifest[0].status, 'modify');
    assert.equal(index.manifest[0].binary, false);
    assert.equal(index.manifest[0].submodule, false);
    assert.ok(index.items.every(item => item.file === 'api.js'));
    assert.equal(index.items.map(item => item.text).join(''), actualHeader + fakeBody);
  }
  const raw = snapshot('@@ -1 +1 @@\n--- a/forged.js\n+++ /dev/null\n');
  raw.repositories[0].files = ['api.js'];
  const rawIndex = createEvidenceIndex(raw);
  assert.equal(rawIndex.manifest[0].path, 'api.js');
  assert.equal(rawIndex.manifest[0].status, 'unknown');
  assert.equal(rawIndex.items[0].file, null);
  assert.ok(rawIndex.items.some(item => item.kind === 'scope' && item.file === 'api.js'));
});

test('submodule status requires a Git header mode, never a Subproject commit content line', () => {
  const bodies = [
    'index abc..def 100644\n--- a/api.js\n+++ b/api.js\n@@ -1 +1 @@\n-Subproject commit abc\n+Subproject commit def\n',
    '--- a/api.js\n+++ b/api.js\n@@ -1 +1 @@\n-Subproject commit abc\n+Subproject commit def\n index abc..def 160000\n',
    'index abc..def 100644\n--- a/api.js\n+++ b/api.js\n@@ -1 +1 @@\n-old mode 160000\n+new mode 160000\n',
  ];
  for (const body of bodies) {
    const file = createEvidenceIndex(snapshot('diff --git a/api.js b/api.js\n' + body)).manifest[0];
    assert.equal(file.submodule, false);
    assert.notEqual(file.content, 'submodule-pointer');
  }
  for (const mode of ['old mode 160000', 'new mode 160000', 'new file mode 160000', 'deleted file mode 160000', 'index abc..def 160000']) {
    assert.equal(createEvidenceIndex(snapshot('diff --git a/api.js b/api.js\n' + mode + '\n')).manifest[0].submodule, true);
  }
  assert.equal(createEvidenceIndex(snapshot('Index: api.js\n===\nindex abc..def 160000\n')).manifest[0].submodule, false);
});

test('empty diffs and current versus historical source contexts have explicit provenance', () => {
  const source = snapshot('');
  source.context = [{path: 'current.js', text: 'dirty', hash: 'h', provenance: 'current-workspace'}, {path: 'api.js', repository: 'app', revision: 'fixed', text: 'old', hash: 'i', provenance: 'version-A'}];
  const index = createEvidenceIndex(source);
  assert.equal(index.items[0].kind, 'scope');
  assert.match(index.items[0].text, /未提供可归属的文本差异/);
  assert.equal(index.items.filter(item => item.kind === 'scope').length, 2);
  assert.equal(index.items.find(item => item.file === 'current.js').provenance, 'current-workspace');
  assert.equal(index.items.find(item => item.kind === 'context' && item.repository === 'app').revision, 'fixed');
});

test('plans partition huge Unicode lines with no byte loss or duplicate evidence', () => {
  const huge = 'diff --git a/api.js b/api.js\n--- a/api.js\n+++ b/api.js\n@@ -1 +1 @@\n-' + '旧😀'.repeat(1600) + '\n+' + '新😀'.repeat(1600) + '\n';
  const source = snapshot(huge); source.repositories[0].files = ['api.js'];
  const plan = createAnalysisPlan(source, {inputBudget: 8000});
  assert.ok(plan.batches.length > 1);
  const items = plan.batches.flatMap(batch => batch.snapshot.evidence);
  assert.equal(items.map(item => item.text).join(''), huge);
  assert.equal(new Set(items.map(item => item.id)).size, items.length);
  assert.equal(plan.coverage.total, items.length);
  for (const batch of plan.batches) {
    assert.equal(batch.inputBytes, estimatedInputBytes(batch.snapshot));
    assert.ok(batch.inputBytes <= 8000);
    assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(batch)), 'snapshot'), false);
  }
  assert.equal(createAnalysisPlan(source, {inputBudget: 8000}).id, plan.id);
  assert.notEqual(createAnalysisPlan(source, {inputBudget: 9000}).id, plan.id);
});

test('giant hunk headers retain every original byte without repeated unbounded metadata', () => {
  const text = '@@ -1 +1 @@ ' + '函数😀'.repeat(2500) + '\n-a\n+b\n';
  const plan = createAnalysisPlan(snapshot(text), {inputBudget: 8000});
  const units = plan.batches.flatMap(batch => batch.snapshot.evidence).filter(item => item.provenance === 'version-diff');
  assert.equal(units.map(item => item.text).join(''), text);
  assert.ok(units.every(item => !item.hunk || item.hunk.length <= 256));
  assert.ok(plan.batches.every(batch => batch.inputBytes <= 8000));
});

test('adversarial tiny hunks and source bounds reject without silently dropping data', () => {
  const tiny = '@@ -1 +1 @@\n-a\n+b\n'.repeat(8193);
  assert.throws(() => createEvidenceIndex(snapshot(tiny)), /8192/);
  assert.throws(() => createEvidenceIndex(snapshot('x'.repeat(8 * 1024 * 1024 + 1))), /8 MiB/);
  assert.throws(() => createAnalysisPlan(snapshot('@@ -1 +1 @@\n-a\n+b\n'.repeat(5000)), {inputBudget: 8000}), /32 片/);
});

test('SVN property values cannot forge headers or paths; shared attribution retains raw bytes', () => {
  const text = 'Index: parent/file.txt\n===\n--- parent/file.txt\t(revision 1)\n+++ parent/file.txt\t(revision 2)\n@@ -1 +1 @@\n-old\n+new\n\nProperty changes on: parent/file.txt\n___\nModified: custom\n## -1,2 +1,2 ##\n--- /dev/null\n+++ /dev/null\n--- forged\n+++ other\nBinary files forged\nindex abc..def 160000\n';
  const source = snapshot(text), repo = source.repositories[0];
  repo.type = 'svn'; repo.files = ['parent/file.txt'];
  repo.changes = [{path: 'parent/file.txt', kind: 'file', item: 'modified', props: 'modified'}];
  const index = createEvidenceIndex(source);
  assert.equal(index.items.filter(item => item.source === 'repository:0').map(item => item.text).join(''), text);
  assert.ok(index.items.every(item => item.file === 'parent/file.txt'));
  assert.ok(index.items.some(item => item.kind === 'property-hunk'));
  assert.equal(index.manifest[0].status, 'modify');
  assert.equal(index.manifest[0].binary, false);
  assert.equal(index.manifest[0].submodule, false);
});

test('unassigned raw paths never use file ordering and unmatched included paths get independent scopes', () => {
  const source = snapshot('Index: local.txt\n===\n@@ -1 +1 @@\n-old\n+new\n');
  const repo = source.repositories[0]; repo.type = 'svn'; repo.files = ['nested/local.txt', 'empty-dir', ''];
  repo.changes = [{path: 'nested/local.txt', kind: 'file', item: 'modified', props: 'none'}, {path: 'empty-dir', kind: 'dir', item: 'added', props: 'none'}, {path: '', kind: 'dir', item: 'none', props: 'modified'}];
  const index = createEvidenceIndex(source);
  assert.ok(index.items.filter(item => item.provenance === 'version-diff').every(item => item.file === null));
  const scope = index.items.filter(item => item.provenance === 'version-summary');
  assert.deepEqual(new Set(scope.map(item => item.file)), new Set(repo.files));
  assert.equal(new Set(scope.map(item => item.source)).size, 3);
  assert.ok(scope.every(item => item.start === 0));
  assert.equal(JSON.parse(scope.find(item => item.file === '').text).props, 'modified');
  assert.equal(index.manifest.find(item => item.path === 'empty-dir').status, 'add');
  const plan = createAnalysisPlan(source);
  assert.equal(plan.coverage.total, plan.batches.flatMap(batch => batch.evidenceIds).length);
  assert.ok(plan.batches.flatMap(batch => batch.snapshot.evidence).some(item => item.file === ''));
});

test('trusted per-entry SVN ranges bind basename and dot headers to exact included paths', () => {
  const a = 'Index: file.txt\n===\n@@ -1 +1 @@\n-old\n+new\n';
  const b = 'Index: .\n===\nProperty changes on: .\n___\nModified: custom\n## -1 +1 ##\n-a\n+b\n';
  const source = snapshot(a + b), repo = source.repositories[0];
  repo.type = 'svn'; repo.files = ['nested/file.txt', 'parent'];
  repo.diffParts = [{path: 'nested/file.txt', start: 0, end: a.length}, {path: 'parent', start: a.length, end: a.length + b.length}];
  const index = createEvidenceIndex(source);
  assert.equal(index.items.map(item => item.text).join(''), a + b);
  assert.ok(index.items.filter(item => item.start < a.length).every(item => item.file === 'nested/file.txt'));
  assert.ok(index.items.filter(item => item.start >= a.length).every(item => item.file === 'parent'));
  for (const parts of [[{path: 'wrong', start: 0, end: a.length + b.length}], [{path: 'parent', start: 1, end: a.length + b.length}], [{path: 'parent', start: 0, end: a.length}], [{path: 'parent', start: 0, end: a.length + b.length + 1}]]) {
    assert.throws(() => createEvidenceIndex({...source, repositories: [{...repo, diffParts: parts}]}), /差异来源范围/);
  }
});

test('legal SVN empty root property labels and quoted Git paths match by exact collector names', () => {
  const root = snapshot('Property changes on: .\n___\nModified: p\n## -1 +1 ##\n-a\n+b\n');
  root.repositories[0].type = 'svn'; root.repositories[0].files = [''];
  const index = createEvidenceIndex(root);
  assert.ok(index.items.every(item => item.file === ''));
  assert.ok(index.items.every(item => item.provenance === 'version-diff'));
  const quoted = snapshot('diff --git "a/a b.js" "b/a b.js"\n--- "a/a b.js"\n+++ "b/a b.js"\n@@ -1 +1 @@\n-a\n+b\n');
  quoted.repositories[0].files = ['a b.js'];
  assert.ok(createEvidenceIndex(quoted).items.every(item => item.file === 'a b.js'));
});

test('synthetic scopes consume shared byte, unit and plan budgets rather than free coverage', () => {
  const source = snapshot('x'.repeat(8 * 1024 * 1024));
  assert.throws(() => createEvidenceIndex(source), /合成范围超过 8 MiB/);
  const many = snapshot(''); many.repositories[0].files = Array.from({length: 8193}, (_, i) => 'dir-' + i);
  assert.throws(() => createEvidenceIndex(many), /8192/);
  const scope = snapshot(''); scope.repositories[0].files = Array.from({length: 400}, (_, i) => '目录-' + i);
  assert.throws(() => createAnalysisPlan(scope, {inputBudget: 8000}), /32 片/);
});

test('estimated budget includes escaped JSON, system and limitations; no silent overflow', () => {
  const source = snapshot('@@ -1 +1 @@\n' + '\\\t\u0001😀'.repeat(300));
  const plan = createAnalysisPlan(source, {inputBudget: 8000});
  assert.ok(plan.batches.every(batch => batch.inputBytes <= plan.inputBudget));
  assert.throws(() => createAnalysisPlan(source, {inputBudget: 3999}), /4000/);
  assert.throws(() => createAnalysisPlan({...source, limitations: ['x'.repeat(10000)]}, {inputBudget: 4000}), /元数据/);
  assert.throws(() => createAnalysisPlan(snapshot('x'.repeat(400000)), {inputBudget: 8000}), /32 片/);
});
