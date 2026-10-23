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
    const index = createEvidenceIndex(snapshot(text));
    assert.equal(index.items.map(item => item.text).join(''), text);
  }
  assert.equal(createEvidenceIndex(snapshot('Index: removed.txt\n===\n')).items[0].file, 'removed.txt');
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
  assert.equal(rawIndex.manifest[0].status, 'modify');
  assert.ok(rawIndex.items.every(item => item.file === 'api.js'));
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
  assert.match(index.items[0].text, /无文本差异/);
  assert.equal(index.items[1].provenance, 'current-workspace');
  assert.equal(index.items[2].revision, 'fixed');
  assert.equal(index.items[2].repository, 'app');
});

test('plans partition huge Unicode lines with no byte loss or duplicate evidence', () => {
  const huge = 'diff --git a/api.js b/api.js\n--- a/api.js\n+++ b/api.js\n@@ -1 +1 @@\n-' + '旧😀'.repeat(1600) + '\n+' + '新😀'.repeat(1600) + '\n';
  const source = snapshot(huge), plan = createAnalysisPlan(source, {inputBudget: 8000});
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
  const units = plan.batches.flatMap(batch => batch.snapshot.evidence);
  assert.equal(units.map(item => item.text).join(''), text);
  assert.ok(units.every(item => item.hunk.length <= 256));
  assert.ok(plan.batches.every(batch => batch.inputBytes <= 8000));
});

test('adversarial tiny hunks and source bounds reject without silently dropping data', () => {
  const tiny = '@@ -1 +1 @@\n-a\n+b\n'.repeat(8193);
  assert.throws(() => createEvidenceIndex(snapshot(tiny)), /8192/);
  assert.throws(() => createEvidenceIndex(snapshot('x'.repeat(8 * 1024 * 1024 + 1))), /8 MiB/);
  assert.throws(() => createAnalysisPlan(snapshot('@@ -1 +1 @@\n-a\n+b\n'.repeat(5000)), {inputBudget: 8000}), /32 片/);
});

test('estimated budget includes escaped JSON, system and limitations; no silent overflow', () => {
  const source = snapshot('@@ -1 +1 @@\n' + '\\\t\u0001😀'.repeat(300));
  const plan = createAnalysisPlan(source, {inputBudget: 8000});
  assert.ok(plan.batches.every(batch => batch.inputBytes <= plan.inputBudget));
  assert.throws(() => createAnalysisPlan(source, {inputBudget: 3999}), /4000/);
  assert.throws(() => createAnalysisPlan({...source, limitations: ['x'.repeat(10000)]}, {inputBudget: 4000}), /元数据/);
  assert.throws(() => createAnalysisPlan(snapshot('x'.repeat(400000)), {inputBudget: 8000}), /32 片/);
});
