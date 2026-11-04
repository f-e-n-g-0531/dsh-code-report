import test from 'node:test';
import assert from 'node:assert/strict';
import {renderReadableAnalysis} from '../src/readable-analysis.mjs';
import {markdownText, markdownFence} from '../src/markdown-text.mjs';
import {createAnalysisPlan} from '../src/analysis.mjs';

const ids = ['e-' + 'a'.repeat(32), 'e-' + 'b'.repeat(32), 'e-' + 'c'.repeat(32)];
const hash = 'd'.repeat(64);
const emptyAnalysis = () => ({changes: [], interfaces: [], impacts: [], qa: [], unknowns: []});
function fixture() {
  const evidence = ids.map((id, index) => ({id, source: 'repository:' + index, repository: 'app', file: index ? 'api.js' : null, provenance: index ? 'version-diff' : 'version-summary', kind: index ? 'hunk' : 'scope', start: 12, end: 40, sourceHash: hash, blockHash: 'f'.repeat(64), a: 'old', b: 'new', hunk: '@@ -1 +1 @@', text: ['{"summary":"local statistics"}', '-old\n+new', '-unused\n+unused'][index]}));
  const plan = {strategy: 'single-request', batches: [{id: 'batch-fixture', evidenceIds: [...ids], snapshot: {evidence}}], coverage: {fullManifestFiles: 9, sentFileCount: 3, sentTextFileCount: 2, omittedFileCount: 6, contextFiles: 0, total: 3, originalSourceBytes: 3500, excluded: [], files: [{path: 'FULL_MANIFEST_ONLY'}], contextManifest: [{path: 'CONTEXT_MANIFEST_ONLY'}]}};
  const analysis = {changes: [{text: '可能改变参数，是否影响调用方待确认。', evidenceIds: [ids[1], ids[0]]}], interfaces: [{text: '未提供旧接口，无法确认兼容性。', evidenceIds: [ids[0]]}], impacts: [{text: '直接影响所列片段；跨项目影响未知。', evidenceIds: [ids[1]]}], qa: [{text: 'P1 前置条件：旧调用方；步骤：调用；预期：待核对；回归边界：未提供依赖。', evidenceIds: [ids[1]]}], unknowns: [{text: '调用方未提供，间接影响待确认。', evidenceIds: []}]};
  return {plan, analysis, completed: new Map([['batch-fixture', {analysis}]])};
}
const bodyOf = markdown => markdown.split('\n<details>')[0];
const appendixOf = markdown => markdown.slice(markdown.indexOf('<details>'));

test('reader-first sections hide technical metadata until the final appendix', () => {
  const {plan, completed} = fixture();
  const markdown = renderReadableAnalysis(plan, completed), body = bodyOf(markdown), appendix = appendixOf(markdown);
  const headings = ['改动内容', '对外接口变更', '影响范围', 'QA 测试范围', '未知和待确认'];
  let previous = -1;
  for (const heading of headings) { const current = body.indexOf('## ' + heading); assert.ok(current > previous); previous = current; }
  assert.match(body, /本地清单含 9 个变更文件/);
  assert.match(body, /文件专用证据 3 个，其中含原文片段 2 个；6 个未收到文件专用证据/);
  assert.equal(markdown.match(/不是全文语义分析/g).length, 1);
  assert.doesNotMatch(body, /e-[a-f0-9]{32}|[a-f0-9]{64}|UTF-?16|分片/);
  assert.match(appendix, /^<details>\n<summary>技术附录：证据与覆盖记录<\/summary>/);
  assert.ok(markdown.endsWith('</details>\n'));
  assert.equal(markdown.match(/<details>/g).length, 1);
  assert.doesNotMatch(markdown, /FULL_MANIFEST_ONLY|CONTEXT_MANIFEST_ONLY/);
});

test('citations map first use to stable sequential numeric targets, including uncited evidence', () => {
  const {plan, completed} = fixture();
  const markdown = renderReadableAnalysis(plan, completed), body = bodyOf(markdown), appendix = appendixOf(markdown);
  assert.match(body, /\[1\]\(#evidence-1\) \[2\]\(#evidence-2\)/);
  assert.equal(body.match(/\[1\]\(#evidence-1\)/g).length, 3);
  assert.equal(body.match(/\[2\]\(#evidence-2\)/g).length, 2);
  for (const [number, id] of [[1, ids[1]], [2, ids[0]], [3, ids[2]]]) {
    const anchor = '<a id="evidence-' + number + '"></a>';
    assert.equal(appendix.split(anchor).length, 2);
    const block = appendix.slice(appendix.indexOf(anchor)).split(/\n<a id=/)[0];
    assert.ok(block.includes(markdownText(id)));
  }
  assert.match(appendix, /被结论引用 2；未引用 1/);
  assert.match(appendix, /引用状态：未被结论引用，需人工核对/);
  assert.equal(renderReadableAnalysis(plan, completed), markdown);
});

test('preserves uncertain model claims verbatim after the common text sanitizer', () => {
  const {plan, analysis, completed} = fixture();
  analysis.changes[0].text = '  可能影响 A/B；并非已证实。\n<em>未知</em> [不得批准](https://invalid)';
  const body = bodyOf(renderReadableAnalysis(plan, completed));
  for (const section of ['changes', 'interfaces', 'impacts', 'unknowns']) for (const item of analysis[section]) assert.ok(body.includes(markdownText(item.text)));
  assert.doesNotMatch(body, /已验证通过|兼容性已确认|批准发布/);
});

test('QA label splitting is lossless including whitespace, punctuation and multiline prose', () => {
  const {plan, analysis, completed} = fixture();
  const text = 'P1  前置条件：旧调用方； \n步骤:调用\n检查；预期结果：尚待确认； 回归边界:未提供。  ';
  analysis.qa[0].text = text;
  const qa = bodyOf(renderReadableAnalysis(plan, completed)).split('## QA 测试范围\n\n')[1].split('\n\n## 未知和待确认')[0];
  const parts = qa.split('\n').map(line => line.replace(/^(?:  )?- /, '').replace(/ \[1\]\(#evidence-1\)$/, ''));
  assert.equal(parts.join(''), markdownText(text));
  assert.equal(parts.length, 5);
  analysis.qa[0].text = '仅提及步骤但没有标签，不能推断前置条件';
  const plain = bodyOf(renderReadableAnalysis(plan, completed));
  assert.ok(plain.includes('- ' + markdownText(analysis.qa[0].text) + ' [1](#evidence-1)'));
});

test('selected evidence text appears exactly once, with raw and synthetic provenance kept distinct', () => {
  const {plan, completed} = fixture();
  const markdown = renderReadableAnalysis(plan, completed), appendix = appendixOf(markdown);
  assert.match(appendix, /合成范围摘要（独立来源，不是原始差异或上下文）/);
  assert.match(appendix, /原始差异片段/);
  for (const item of plan.batches[0].snapshot.evidence) {
    assert.equal(markdown.split(markdownFence(item.text, 'text')).length, 2);
    for (const [key, field] of Object.entries(item)) if (key !== 'text') assert.ok(appendix.includes('- ' + markdownText(key) + '：' + markdownText(field ?? '未知')));
  }
  assert.match(appendix, /UTF-16 字符偏移（非源码行号\/字节）：12–40/);
});

test('model/source metadata cannot inject markdown links, headings or HTML attributes', () => {
  const {plan, analysis, completed} = fixture();
  const hostile = '"><img src=x onerror=alert(1)>\n# injected [link](javascript:alert(1)) ` x \u202e';
  analysis.changes[0].text = hostile;
  analysis.qa[0].text = '前置条件：' + hostile + '步骤：' + hostile;
  plan.coverage.fullManifestFiles = hostile;
  const item = plan.batches[0].snapshot.evidence[1];
  for (const key of ['repository', 'file', 'source', 'hunk', 'start', 'end', 'sourceHash', 'blockHash', 'revision']) item[key] = hostile;
  item.identity = {uuid: hostile};
  const evilId = 'e-" onmouseover=alert(1)';
  item.id = evilId; plan.batches[0].evidenceIds[1] = evilId;
  for (const entries of Object.values(analysis)) for (const entry of entries) entry.evidenceIds = entry.evidenceIds.map(id => id === ids[1] ? evilId : id);
  const markdown = renderReadableAnalysis(plan, completed);
  // Coverage JSON is inside a fence. Outside fences every dynamic value is inert text.
  const outsideFences = markdown.replace(/```(?:json|text)\n[\s\S]*?\n```/g, '');
  assert.ok(outsideFences.includes(markdownText(hostile)));
  assert.doesNotMatch(outsideFences, /<img|\n# injected|\[link\]|onmouseover=/);
  const tags = outsideFences.match(/<[^>]*>/g);
  assert.deepEqual(tags, ['<details>', '<summary>', '</summary>', '<a id="evidence-1">', '</a>', '<a id="evidence-2">', '</a>', '<a id="evidence-3">', '</a>', '</details>']);
});

test('hostile source text stays byte-exact inside a dynamically longer fence', () => {
  const {plan, completed} = fixture();
  const text = '```\n</details>\n<img src=x>\n``````\n[link](javascript:alert(1))\n';
  plan.batches[0].snapshot.evidence[1].text = text;
  const markdown = renderReadableAnalysis(plan, completed);
  assert.equal(markdown.split(markdownFence(text, 'text')).length, 2);
  assert.ok(markdown.includes('```````text\n' + text + '\n```````'));
  assert.doesNotMatch(bodyOf(markdown), /<img|javascript/);
});

test('empty sections and context coverage remain cautious instead of asserting no change', () => {
  const {plan, completed} = fixture();
  completed.get('batch-fixture').analysis = emptyAnalysis();
  Object.assign(plan.coverage, {contextFiles: 4, sentContextTextFileCount: 1, omittedContextFileCount: 2});
  const markdown = renderReadableAnalysis(plan, completed);
  assert.match(bodyOf(markdown), /另有上下文文件 4 个，原文片段覆盖 1 个，未发送文件专用证据 2 个/);
  assert.match(bodyOf(markdown), /未列出对外接口变化，不保证完整覆盖/);
  assert.match(appendixOf(markdown), /被结论引用 0；未引用 3/);
});

test('rejects full-mode, incomplete and unmappable result input', () => {
  const {plan, analysis, completed} = fixture();
  assert.throws(() => renderReadableAnalysis({...plan, strategy: 'full'}, completed), /单次请求/);
  assert.throws(() => renderReadableAnalysis({...plan, batches: [...plan.batches, ...plan.batches]}, completed), /单次请求/);
  assert.throws(() => renderReadableAnalysis(plan, new Map()), /尚未完成/);
  analysis.changes[0].evidenceIds = ['unknown-id'];
  assert.throws(() => renderReadableAnalysis(plan, completed), /未提供的证据/);
});

test('renders the actual single-request plan shape without changing it', () => {
  const snapshot = {title: 'fixture', createdAt: 'fixed', limitations: [], context: [{path: 'caller.js', text: 'export const call = 1;', provenance: 'current-workspace'}], repositories: [{path: 'app', type: 'git', a: 'a', b: 'b', files: ['api.js'], diff: 'diff --git a/api.js b/api.js\n--- a/api.js\n+++ b/api.js\n@@ -1 +1 @@\n-old\n+new\n', summary: 'api.js'}]};
  const plan = createAnalysisPlan(snapshot, {strategy: 'single-request'});
  const analysis = emptyAnalysis();
  analysis.changes.push({text: '可能存在变化，仍待确认', evidenceIds: [plan.batches[0].evidenceIds.at(-1)]});
  const before = JSON.stringify(plan);
  const markdown = renderReadableAnalysis(plan, new Map([[plan.batches[0].id, {analysis}]]));
  assert.equal(JSON.stringify(plan), before);
  assert.match(markdown, /原始上下文片段/);
  assert.match(markdown, /合成范围摘要/);
  assert.match(markdown, /已处理仅指结果返回/);
  assert.ok(appendixOf(markdown).includes('- payloadHash：' + markdownText(plan.batches[0].payloadHash)));
  assert.ok(appendixOf(markdown).includes('- snapshotHash：' + markdownText(plan.snapshotHash)));
});
