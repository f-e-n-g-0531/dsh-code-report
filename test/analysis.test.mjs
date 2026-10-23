import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createAnalysisPlan, analyzeReport, analyze, markdown} from '../src/report.mjs';
import {validateAnalysis, consumeStructuredAnalysis} from '../src/analysis.mjs';

const route = {provider: 'fixture', model: 'structured'};
const snapshot = (text = '-old\n+new\n') => ({title: 'fixture', createdAt: 'fixed', limitations: [], context: [], repositories: [{path: 'app', type: 'git', a: 'a', b: 'b', requestedA: 'a', requestedB: 'b', files: ['api.js'], diff: 'diff --git a/api.js b/api.js\n--- a/api.js\n+++ b/api.js\n@@ -1 +1 @@\n' + text, summary: 'api.js', diffHash: 'hash'}]});
const document = id => ({changes: [{text: '参数发生变化', evidenceIds: [id]}], interfaces: [], impacts: [], qa: [{text: 'P1 前置：旧调用方；步骤：调用新接口；预期：核对返回值', evidenceIds: [id]}], unknowns: [{text: '调用方未提供，间接影响待确认', evidenceIds: []}]});
async function* stream(value, reason = 'stop') { yield {type: 'text-delta', text: typeof value === 'string' ? value : JSON.stringify(value)}; yield {type: 'finish', reason: {kind: reason}}; }
const model = callback => ({stream(input) { assert.deepEqual(input.tools, []); const payload = JSON.parse(input.messages[0].content[0].text); return callback(payload, input); }});

test('strict schema rejects arbitrary objects, extras, invalid references and unsupported unknown claims', () => {
  const valid = document('e1');
  assert.deepEqual(validateAnalysis(valid, ['e1']), valid);
  const invalid = [null, [], {}, {...valid, extra: []}, {...valid, changes: {}}, {...valid, changes: [{text: 'x', evidenceIds: ['wrong']}]}, {...valid, changes: [{text: 'x', evidenceIds: []}]}, {...valid, changes: [{text: 'x', evidenceIds: ['e1', 'e1']}]}, {...valid, changes: [{text: 'x', evidenceIds: ['e1'], url: 'evil'}]}, {...valid, changes: [{text: '', evidenceIds: ['e1']}]}, {...valid, unknowns: [{text: '确定安全', evidenceIds: []}]}];
  for (const value of invalid) assert.throws(() => validateAnalysis(value, ['e1']));
  assert.throws(() => validateAnalysis({...valid, changes: Array(201).fill(valid.changes[0])}, ['e1']));
});

test('structured report produces deterministic escaped Markdown and evidence index', async () => {
  const source = snapshot(), plan = createAnalysisPlan(source);
  const result = await analyzeReport(model(payload => stream({...document(payload.evidence[0].id), impacts: [{text: '<img src=x> [click](https://evil)\n# false heading', evidenceIds: [payload.evidence[0].id]}]})), route, source, {plan});
  assert.match(result.markdown, /## 对外接口变更/);
  assert.match(result.markdown, /## 分片覆盖与证据索引/);
  assert.match(result.markdown, /不证明结论正确/);
  assert.ok(!result.markdown.includes('<img'));
  assert.ok(!result.markdown.includes('[click]'));
  assert.ok(!result.markdown.includes('\n# false'));
  assert.equal(result.coverage.remaining, 0);
  assert.equal(result.coverage.analyzed, plan.coverage.total);
  assert.equal(result.completed.size, plan.batches.length);
  assert.ok(result.markdown.includes(plan.batches[0].evidenceIds[0]));
});

test('all-empty structured output is processed but never claimed as cited or understood', async () => {
  const source = snapshot();
  const result = await analyzeReport(model(() => stream({changes: [], interfaces: [], impacts: [], qa: [], unknowns: []})), route, source);
  assert.equal(result.coverage.cited, 0);
  assert.equal(result.coverage.unreferencedIds.length, result.coverage.total);
  assert.equal(result.coverage.processed, result.coverage.total);
  assert.match(result.markdown, /已处理不等于每条证据有结论/);
  assert.match(result.markdown, /成功 1 片；失败 0 片；未处理 0 片/);
});

test('partial success is resumable only by explicit subsequent call using same plan and route', async () => {
  const source = snapshot('旧😀'.repeat(2200)), plan = createAnalysisPlan(source, {inputBudget: 8000});
  assert.ok(plan.batches.length > 1);
  let calls = 0, partial;
  const progress = [];
  await assert.rejects(analyzeReport(model(payload => { calls++; if (calls === 2) throw new Error('offline'); return stream(document(payload.evidence[0].id)); }), route, source, {plan, onProgress: value => progress.push(value.completed)}), error => { partial = error.completed; return /offline/.test(error.message); });
  assert.equal(calls, 2);
  assert.equal(partial.size, 1);
  assert.deepEqual(progress, [0, 1]);
  const reused = partial;
  let resumed = 0;
  const result = await analyzeReport(model(payload => { resumed++; return stream(document(payload.evidence[0].id)); }), route, source, {plan, completed: reused});
  assert.equal(resumed, plan.batches.length - 1);
  assert.equal(reused.size, 1, 'caller checkpoint must not mutate');
  assert.equal(result.completed.size, plan.batches.length);
  await assert.rejects(analyzeReport({}, {...route, model: 'other'}, source, {plan, completed: reused}), /不可复用/);
  await assert.rejects(analyzeReport({}, route, source, {plan, completed: new Map([['unknown', [...reused.values()][0]]])}), /不可复用/);
  const bad = new Map(reused), [id, entry] = [...bad][0];
  bad.set(id, {...entry, analysis: document(plan.batches[1].evidenceIds[0])});
  await assert.rejects(analyzeReport({}, route, source, {plan, completed: bad}), /非本批/);
});

test('plan mismatch and already aborted calls never dispatch model', async () => {
  let calls = 0;
  const llm = {stream() { calls++; throw new Error('must not run'); }}, source = snapshot();
  await assert.rejects(analyzeReport(llm, route, source, {plan: {...createAnalysisPlan(source), id: 'wrong'}}), /计划/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(analyzeReport(llm, route, source, {signal: controller.signal}), error => error.name === 'AbortError' && error.completed.size === 0);
  assert.equal(calls, 0);
});

test('cancel between batches preserves only validated completed batches and prevents next dispatch', async () => {
  const controller = new AbortController(), source = snapshot('大'.repeat(12000)), plan = createAnalysisPlan(source, {inputBudget: 8000});
  let calls = 0;
  await assert.rejects(analyzeReport(model(payload => { calls++; return stream(document(payload.evidence[0].id)); }), route, source, {signal: controller.signal, plan, onProgress(value) { if (value.completed === 1) controller.abort(); }}), error => error.name === 'AbortError' && error.completed.size === 1);
  assert.equal(calls, 1);
});

test('abort settles a hung adapter, retains accepted batches and does not await iterator.return', async () => {
  const source = snapshot('长'.repeat(12000)), plan = createAnalysisPlan(source, {inputBudget: 8000});
  const controller = new AbortController();
  let calls = 0, returned = 0, ready;
  const hung = new Promise(resolve => { ready = resolve; });
  const llm = model(payload => {
    calls++;
    if (calls === 1) return stream(document(payload.evidence[0].id));
    return {[Symbol.asyncIterator]() { return this; }, next() { ready(); return new Promise(() => {}); }, return() { returned++; return new Promise(() => {}); }};
  });
  const pending = analyzeReport(llm, route, source, {signal: controller.signal, plan});
  await hung;
  controller.abort();
  let timer;
  try {
    await assert.rejects(Promise.race([pending, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('abort did not settle')), 1000); })]), error => error.name === 'AbortError' && error.completed.size === 1);
  } finally { clearTimeout(timer); }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(returned, 1);
  assert.equal(calls, 2);
});

test('late next/return failures are observed after cancellation; legacy API also aborts hung next', async () => {
  const controller = new AbortController();
  let rejectNext, ready, returns = 0;
  const started = new Promise(resolve => { ready = resolve; });
  const adapter = {[Symbol.asyncIterator]() { return this; }, next() { ready(); return new Promise((_, reject) => { rejectNext = reject; }); }, return() { returns++; return Promise.reject(new Error('late cleanup')); }};
  const pending = analyze({stream: () => adapter}, route, {}, controller.signal);
  await started;
  controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError');
  rejectNext(new Error('late next failure'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(returns, 1);
});

test('model stream rejects free Markdown, tools, truncated, empty and post-finish output', async () => {
  for (const value of ['## free Markdown', 'JSON {broken']) await assert.rejects(consumeStructuredAnalysis(stream(value)), /JSON/);
  await assert.rejects(consumeStructuredAnalysis(stream('{}', 'length')), /完整/);
  await assert.rejects(consumeStructuredAnalysis((async function* () { yield {type: 'tool-call-delta'}; })()), /工具/);
  await assert.rejects(consumeStructuredAnalysis((async function* () { yield {type: 'text-delta', text: '{}'}; })()), /完整/);
  await assert.rejects(consumeStructuredAnalysis((async function* () { yield* stream('{}'); yield {type: 'text-delta', text: 'late'}; })()), /结束后/);
});

test('model text and reasoning share exact 256 KiB byte output budget including Unicode', async () => {
  const output = JSON.stringify({ok: true}), remainder = 256 * 1024 - Buffer.byteLength(output);
  const within = (async function* () { yield {type: 'reasoning-delta', text: '中'.repeat(Math.floor(remainder / 3)) + 'x'.repeat(remainder % 3)}; yield* stream(output); })();
  assert.deepEqual(await consumeStructuredAnalysis(within), {ok: true});
  const over = (async function* () { yield {type: 'reasoning-delta', text: '中'.repeat(Math.floor(remainder / 3)) + 'x'.repeat(remainder % 3 + 1)}; yield* stream(output); })();
  await assert.rejects(consumeStructuredAnalysis(over), /256 KiB/);
});

test('legacy direct analyze API remains Markdown-compatible and version context labels are accurate', async () => {
  const text = '## 对外接口变更\n待确认';
  assert.equal(await analyze({stream: () => stream(text)}, route, {}), text);
  const source = snapshot(); source.context = [{path: 'api.js', repository: 'app', revision: 'fixed-a', provenance: 'version-A', hash: 'hash', text: 'old'}];
  const result = markdown(source);
  assert.match(result, /固定版本 fixed-a（version-A）/);
  assert.ok(!result.includes('api.js；当前工作区快照'));
});

test('fixed evaluation fixtures validate schema, but semantics remain human reviewed', async () => {
  const suite = JSON.parse(await readFile(new URL('./fixtures/analysis-evaluation.json', import.meta.url), 'utf8'));
  assert.match(suite.qualityNotice, /人工/);
  assert.ok(suite.cases.length >= 5);
  for (const fixture of suite.cases) {
    const plan = createAnalysisPlan(fixture.snapshot);
    const ids = plan.batches[0].evidenceIds;
    const selected = fixture.evidenceSelector ? plan.batches[0].snapshot.evidence.find(item => item.kind === fixture.evidenceSelector.kind && fixture.evidenceSelector.contains.every(text => item.text.includes(text))) : null;
    if (fixture.evidenceSelector) assert.ok(selected, fixture.name + ': expected text must occur in actual selected hunk');
    const substitute = value => JSON.parse(JSON.stringify(value).replaceAll('EVIDENCE_0', ids[0]).replaceAll('EVIDENCE_HUNK', selected?.id ?? 'missing-hunk'));
    const output = substitute(fixture.output);
    if (fixture.schemaValid) validateAnalysis(output, ids);
    else assert.throws(() => validateAnalysis(output, ids), fixture.name);
    assert.ok(fixture.humanChecks.length);
  }
});
