import test from 'node:test';
import {withDispositions} from './analysis-fixture.mjs';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createAnalysisPlan, analyzeReport, analyze, markdown} from '../src/report.mjs';
import {validateAnalysis, consumeStructuredAnalysis, estimatedInputBytes, ANALYSIS_PLAN_VERSION, MODEL_SYSTEM, modelEvidencePayload} from '../src/analysis.mjs';
import {createEvidenceIndex, evidenceHash} from '../src/evidence.mjs';

const route = {provider: 'fixture', model: 'structured'};
const snapshot = (text = '-old\n+new\n') => ({title: 'fixture', createdAt: 'fixed', limitations: [], context: [], repositories: [{path: 'app', type: 'git', a: 'a', b: 'b', requestedA: 'a', requestedB: 'b', files: ['api.js'], diff: 'diff --git a/api.js b/api.js\n--- a/api.js\n+++ b/api.js\n@@ -1 +1 @@\n' + text, summary: 'api.js', diffHash: 'hash'}]});
const document = id => ({changes: [{text: '参数发生变化', evidenceIds: [id]}], interfaces: [], impacts: [], qa: [{text: 'P1 前置：旧调用方；步骤：调用新接口；预期：核对返回值', evidenceIds: [id]}], unknowns: [{text: '调用方未提供，间接影响待确认', evidenceIds: []}]});
async function* stream(value, reason = 'stop') { yield {type: 'text-delta', text: typeof value === 'string' ? value : JSON.stringify(value)}; yield {type: 'finish', reason: {kind: reason}}; }
const model = callback => ({stream(input) { assert.deepEqual(input.tools, []); const payload = JSON.parse(input.messages[0].content[0].text); const result = callback(payload, input); if (typeof result.next === 'function') { const next = result.next.bind(result); result.next = async (...args) => { const step = await next(...args); if (step.value?.type === 'text-delta') { try { step.value.text = JSON.stringify(withDispositions(JSON.parse(step.value.text), payload.evidence)); } catch {} } return step; }; return result; } return (async function* () { for await (const chunk of result) { if (chunk.type === 'text-delta') { try { chunk.text = JSON.stringify(withDispositions(JSON.parse(chunk.text), payload.evidence)); } catch {} } yield chunk; } })(); }});

test('linear packing matches reference JSON packing and preserves payload and plan hashes', () => {
  const source = snapshot(('@@ -1 +1 @@\n-\\\t\u0001😀\n+新\n').repeat(120));
  source.title = '"quoted"\t😀'; source.limitations = ['slashes \\ and controls \t \u0001 \ud800'];
  for (const inputBudget of [14000, 24000, 64000]) {
    const payloadFor = evidence => ({schema: ANALYSIS_PLAN_VERSION, evidenceVersion: 2, title: source.title, publicApiPaths: source.publicApiPaths ?? [], evidence});
    const overhead = estimatedInputBytes(payloadFor([]));
    const index = createEvidenceIndex(source, {groupAdjacentDiff: true, maxTextBytes: Math.max(64, Math.floor((inputBudget - overhead - 512) / 8))});
    const groups = []; let group = [];
    for (const item of index.items) {
      if (group.length && (estimatedInputBytes(payloadFor([...group, item])) > inputBudget)) { groups.push(group); group = []; }
      group.push(item);
    }
    if (group.length) groups.push(group);
    const payloadHashes = groups.map((items,index) => evidenceHash(JSON.stringify(modelEvidencePayload(payloadFor(items),index+1))));
    const id = 'plan-' + evidenceHash(JSON.stringify([ANALYSIS_PLAN_VERSION, 2, index.snapshotHash, inputBudget, MODEL_SYSTEM, payloadHashes]));
    const plan = createAnalysisPlan(source, {inputBudget});
    assert.equal(plan.id, id);
    assert.deepEqual(plan.batches.map(batch => batch.payloadHash), payloadHashes);
    assert.deepEqual(plan.batches.map(batch => batch.evidenceIds), groups.map(items => items.map(item => item.id)));
    for (const batch of plan.batches) assert.equal(batch.inputBytes, estimatedInputBytes(batch.snapshot));
  }
});

test('over 32 batches cancel with exact complete coverage and explicitly resume without repeats', async () => {
  const source = snapshot(''); source.repositories[0].files = Array.from({length: 400}, (_, i) => 'directory-' + i);
  const plan = createAnalysisPlan(source, {inputBudget: 14000}), controller = new AbortController();
  assert.ok(plan.batches.length > 33);
  let calls = 0, partial;
  const llm = model(payload => { calls++; return stream(document(payload.evidence[0].id)); });
  await assert.rejects(analyzeReport(llm, route, source, {plan, signal: controller.signal, onProgress(value) { if (value.completed === 33) controller.abort(); }}), error => {
    partial = error.completed;
    const processed = plan.batches.slice(0, 33).reduce((sum, batch) => sum + batch.evidenceIds.length, 0);
    assert.equal(error.coverage.processed, processed);
    assert.equal(error.coverage.remaining, plan.coverage.total - processed);
    assert.equal(error.coverage.total, plan.coverage.total);
    assert.equal(error.coverage.files.length, 400);
    assert.equal(error.coverage.cited, 33);
    assert.equal(error.coverage.unreferencedIds.length, plan.coverage.total - 33);
    assert.deepEqual(error.coverage.pendingBatchIds, plan.batches.slice(33).map(batch => batch.id));
    return error.name === 'AbortError';
  });
  assert.equal(calls, 33); assert.equal(partial.size, 33);
  const result = await analyzeReport(llm, route, source, {plan, completed: partial});
  assert.equal(calls, plan.batches.length);
  assert.equal(result.coverage.processed, plan.coverage.total);
  assert.equal(result.coverage.remaining, 0);
  assert.equal(result.coverage.cited, plan.batches.length);
  assert.equal(result.coverage.files.length, 400);
  assert.equal(result.completed.size, plan.batches.length);
  for (const batch of plan.batches) assert.equal(result.completed.get(batch.id).payloadHash, batch.payloadHash);
});

test('strict schema rejects arbitrary objects, extras, invalid references and unsupported unknown claims', () => {
  const valid = document('e1');
  assert.deepEqual(validateAnalysis(valid, ['e1']), {...valid, evidenceDispositions: []});
  const invalid = [null, [], {}, {...valid, extra: []}, {...valid, changes: {}}, {...valid, changes: [{text: 'x', evidenceIds: ['wrong']}]}, {...valid, changes: [{text: 'x', evidenceIds: []}]}, {...valid, changes: [{text: 'x', evidenceIds: ['e1'], url: 'evil'}]}, {...valid, changes: [{text: '', evidenceIds: ['e1']}]}, {...valid, unknowns: [{text: '确定安全', evidenceIds: []}]}];
  for (const value of invalid) assert.throws(() => validateAnalysis(value, ['e1']));
  assert.throws(() => validateAnalysis({...valid, changes: Array(201).fill(valid.changes[0])}, ['e1']));
});

test('model duplicate references normalize without changing attribution or saved checkpoints', async () => {
  const valid = document('e1'), changes = [{text:'fixture', evidenceIds:['e2','e1','e2']}];
  assert.deepEqual(validateAnalysis({...valid,changes},['e1','e2']).changes[0].evidenceIds,['e2','e1']);
  assert.deepEqual(changes[0].evidenceIds,['e2','e1','e2']);
  assert.throws(()=>validateAnalysis({...valid,changes},['e1','e2'],{normalized:true}),error=>error.details.referenceFailure.reason==='duplicate');
  const evidence=[{id:'e1',repository:'app',provenance:'version-diff',text:'+int fixture();'}, {id:'e2',repository:'app',text:'外部接入契约：fixture'}];
  const item={text:'fixture',symbol:'fixture',audience:'public-sdk',evidenceIds:['e1','e1'],declarationEvidenceIds:['e1','e1'],publicBasis:{kind:'integration-contract',description:'fixture',quote:evidence[1].text,evidenceIds:['e2','e2']}};
  const [entry]=validateAnalysis({...valid,interfaces:[item]},['e1','e2'],{evidence}).interfaces;
  assert.deepEqual(entry.evidenceIds,['e1','e2']);assert.deepEqual(entry.declarationEvidenceIds,['e1']);assert.deepEqual(entry.publicBasis.evidenceIds,['e2']);
  const source=snapshot(),plan=createAnalysisPlan(source);
  let calls=0;
  const result=await analyzeReport(model(payload=>{calls++;const id=payload.evidence[0].id;return stream({...document(id),changes:[{text:'fixture',evidenceIds:[id,id]}]});}),route,source,{plan});
  assert.equal(calls,plan.batches.length);assert.equal(result.coverage.dispositionComplete,true);
});

test('reference diagnostics identify fixed fields and reasons without copying model data', () => {
  const valid = document('e1'), ids = ['e1', 'e2'];
  for (const [evidenceIds, reason] of [['SECRET', 'not-array'], [[1], 'not-string'], [['e1','e1','SECRET'], 'out-of-batch'], [['SECRET'], 'out-of-batch'], [[], 'empty']]) {
    assert.throws(() => validateAnalysis({...valid, changes:[{text:'SECRET', evidenceIds}]}, ids), error => {
      assert.equal(error.code, 'code-report/analysis-reference');
      assert.deepEqual(error.details.referenceFailure, {section:'changes', field:'evidenceIds', reason});
      assert.doesNotMatch(error.message + JSON.stringify(error.details), /SECRET/);
      return true;
    });
  }
  const entry={text:'fixture',symbol:'fixture',audience:'public-sdk',evidenceIds:['e1'],declarationEvidenceIds:['e1'],publicBasis:{kind:'sdk-publication',description:'fixture',quote:'fixture',evidenceIds:['SECRET']}};
  for(const [item,field] of [[{...entry,declarationEvidenceIds:['SECRET']},'declarationEvidenceIds'],[entry,'publicBasis.evidenceIds']]){
    assert.throws(()=>validateAnalysis({...valid,interfaces:[item]},ids),error=>{
      assert.deepEqual(error.details.referenceFailure,{section:'interfaces',field,reason:'out-of-batch'});return true;
    });
  }
});

test('wire references reject another batch and restore original IDs in the disposition ledger',async()=>{
  const source=snapshot('旧😀'.repeat(2200)),plan=createAnalysisPlan(source,{inputBudget:14000});
  assert.ok(plan.batches.length>1);
  let calls=0;
  const rejected=async alias=>assert.rejects(analyzeReport(model(payload=>{
    calls++;assert.equal(payload.evidence[0].id,'B1-E1');
    assert.equal(evidenceHash(JSON.stringify(payload)),plan.batches[0].payloadHash);
    assert.ok(estimatedInputBytes(payload)<=plan.batches[0].inputBytes);
    return stream(document(alias));
  }),route,source,{plan}),error=>error.details.referenceFailure.reason==='out-of-batch'&&error.details.referenceFailure.batchNumber===1);
  await rejected('B2-E1');await rejected(plan.batches[0].evidenceIds[0]);assert.equal(calls,2);
  const result=await analyzeReport(model(()=>stream({changes:[],interfaces:[],impacts:[],qa:[],unknowns:[]})),route,source,{plan});
  for(const batch of plan.batches){
    const ledger=result.completed.get(batch.id).analysis.evidenceDispositions;
    assert.deepEqual(ledger.map(item=>item.evidenceId),batch.evidenceIds);
  }
});

test('reference diagnostic uses the original plan ordinal on failure and resume', async () => {
  const source = snapshot('旧😀'.repeat(2200)), plan = createAnalysisPlan(source, {inputBudget: 14000});
  assert.ok(plan.batches.length > 1);
  let calls=0, checkpoint;
  const bad=()=>stream(document('SECRET'));
  await assert.rejects(analyzeReport(model(payload=>++calls===1?stream(document(payload.evidence[0].id)):bad()),route,source,{plan}), error=>{
    checkpoint=error.completed;
    assert.equal(error.details.referenceFailure.batchNumber,2);
    assert.match(error.message,/^第 2 \/ /);
    assert.doesNotMatch(error.message + JSON.stringify(error.details), /SECRET/);
    return true;
  });
  assert.equal(calls,2);assert.equal(checkpoint.size,1);
  await assert.rejects(analyzeReport(model(()=>{calls++;return bad();}),route,source,{plan,completed:checkpoint}),error=>error.details.referenceFailure.batchNumber===2);
  assert.equal(calls,3);
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

test('all-empty full model output records gaps without claiming semantic completeness', async () => {
  const source = snapshot();
  let calls = 0;
  const llm = {stream() { calls++; return stream({changes: [], interfaces: [], impacts: [], qa: [], unknowns: []}); }};
  const result = await analyzeReport(llm, route, source);
  assert.equal(calls, 1);
  assert.equal(result.coverage.cited, 0);
  assert.equal(result.coverage.noConclusion, result.coverage.total);
  assert.equal(result.coverage.semanticCompleteness, 'not-verified');
  assert.match(result.markdown, /模型未对该证据给出可核对的结论/);
  const restored = await analyzeReport(llm, route, source, {completed: result.completed});
  assert.equal(calls, 1);
  assert.deepEqual(restored, result);
});

test('explicit no-conclusion disposition covers every full-mode evidence without semantic claims', async () => {
  const result = await analyzeReport(model(() => stream({changes: [], interfaces: [], impacts: [], qa: [], unknowns: []})), route, snapshot());
  assert.equal(result.coverage.cited, 0);
  assert.equal(result.coverage.disposed, result.coverage.total);
  assert.equal(result.coverage.noConclusion, result.coverage.total);
  assert.equal(result.coverage.semanticCompleteness, 'not-verified');
  assert.match(result.markdown, /未得出结论/);
  assert.match(result.markdown, /不代表语义完整/);
  const body = result.markdown.split('<details>')[0];
  assert.doesNotMatch(body, /已处理证据|分片覆盖与证据索引/);
  assert.match(body.split('## 未知和待确认')[1], /未得出结论（待确认）/);
});

test('partial success is resumable only by explicit subsequent call using same plan and route', async () => {
  const source = snapshot('旧😀'.repeat(2200)), plan = createAnalysisPlan(source, {inputBudget: 14000});
  assert.ok(plan.batches.length > 1);
  let calls = 0, partial;
  const progress = [];
  await assert.rejects(analyzeReport(model(payload => { calls++; if (calls === 2) throw new Error('offline'); return stream(document(payload.evidence[0].id)); }), route, source, {plan, onProgress: value => progress.push(value.completed)}), error => { partial = error.completed; return /offline/.test(error.message); });
  assert.equal(calls, 2);
  assert.equal(partial.size, 1);
  assert.deepEqual(progress.filter((count, index) => index === 0 || count !== progress[index - 1]), [0, 1]);
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
  await assert.rejects(analyzeReport({}, route, source, {plan, completed: bad}), error=>error.code==='code-report/analysis-reference'&&error.details.referenceFailure.reason==='out-of-batch');
});

test('format versions and payload hashes bind plans and reject legacy checkpoints', async () => {
  const source = snapshot(), plan = createAnalysisPlan(source);
  assert.equal(plan.formatVersion, ANALYSIS_PLAN_VERSION);
  assert.equal(plan.evidenceVersion, 2);
  const result = await analyzeReport(model(payload => {
    assert.equal(Object.hasOwn(payload, 'limitations'), false);
    assert.equal(plan.batches[0].payloadHash, evidenceHash(JSON.stringify(payload)));
    return stream(document(payload.evidence[0].id));
  }), route, source, {plan});
  const [id, checkpoint] = [...result.completed][0];
  assert.equal(checkpoint.formatVersion, ANALYSIS_PLAN_VERSION);
  assert.equal(checkpoint.payloadHash, plan.batches[0].payloadHash);
  for (const invalid of [{...checkpoint, formatVersion: 1}, {...checkpoint, payloadHash: 'old'}, Object.fromEntries(Object.entries(checkpoint).filter(([key]) => !['formatVersion', 'payloadHash'].includes(key)))]) {
    await assert.rejects(analyzeReport({}, route, source, {plan, completed: new Map([[id, invalid]])}), /不可复用/);
  }
  const altered = {...source, limitations: ['new scope limitation']};
  const alteredPlan = createAnalysisPlan(altered);
  assert.notEqual(alteredPlan.snapshotHash, plan.snapshotHash);
  assert.notEqual(alteredPlan.id, plan.id);
  assert.notDeepEqual(alteredPlan.batches[0].evidenceIds, plan.batches[0].evidenceIds);
  assert.equal(alteredPlan.batches[0].payloadHash, plan.batches[0].payloadHash);
  await assert.rejects(analyzeReport({}, route, altered, {plan}), /当前证据不一致/);
  const alteredBatchId = alteredPlan.batches[0].id;
  await assert.rejects(analyzeReport({}, route, altered, {
    plan: alteredPlan, completed: new Map([[alteredBatchId, {...checkpoint, batchId: alteredBatchId}]])
  }), /不可复用/);
});

test('plan mismatch and already aborted calls never dispatch model', async () => {
  let calls = 0;
  const llm = {stream() { calls++; throw new Error('must not run'); }}, source = snapshot();
  await assert.rejects(analyzeReport(llm, route, source, {plan: {...createAnalysisPlan(source), id: 'wrong'}}), /计划/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(analyzeReport(llm, route, source, {signal: controller.signal}), error => error.name === 'AbortError' && error.completed.size === 0);
  assert.equal(calls, 0);
});

test('bounded workers preserve plan order, verify checkpoints, and estimate remaining time', async () => {
  const source = snapshot('长'.repeat(12000)), plan = createAnalysisPlan(source, {inputBudget: 14000});
  const seen = [], samples = [], persisted = [];
  let live = 0, peak = 0, first = true;
  const llm = model(async function* (payload) {
    const isFirst = first; first = false;
    live++; peak = Math.max(live, peak); seen.push(payload.evidence[0].id);
    try {
      if (isFirst) await new Promise(resolve => setTimeout(resolve, 20));
      yield* stream(document(payload.evidence[0].id));
    } finally { live--; }
  });
  const result = await analyzeReport(llm, route, source, {plan, concurrency: 2, onBatchComplete(id, entry) { persisted.push([id, entry]); }, onProgress(p) { samples.push(p); }});
  assert.equal(peak, 2); assert.equal(seen.length, plan.batches.length);
  assert.notEqual(persisted[0][0], plan.batches[0].id);
  assert.ok(samples.some(p => p.inFlight === 2 && p.queued > 0));
  assert.ok(samples.some(p => p.etaMs !== null && p.etaMs >= 0));
  assert.ok(samples.every(p => p.concurrency === 2 && p.inFlight <= 2));
  assert.equal(result.markdown, (await analyzeReport(model(p=>stream(document(p.evidence[0].id))), route, source, {plan})).markdown);
});

test('first parallel failure stops admission without dropping a successful in-flight peer', async () => {
  const source = snapshot('长'.repeat(12000)), plan = createAnalysisPlan(source, {inputBudget: 14000});
  let calls = 0, release, admission;
  const resumed = new Promise(resolve => { release = resolve; });
  const mock = model(payload => stream(document(payload.evidence[0].id)));
  const llm = {async *stream(input, options) {
    admission = options.admissionSignal;
    const i = ++calls;
    if (i === 1) { await new Promise(resolve => setImmediate(resolve)); throw new Error('fixture failed'); }
    await resumed; yield* mock.stream(input);
  }};
  const result = analyzeReport(llm, route, source, {plan, concurrency: 2});
  const check = assert.rejects(result, error => error.message === 'fixture failed' && error.completed.has(plan.batches[1].id) && error.completed.size === 1);
  try {
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(admission.aborted, true);
    assert.equal(calls, 2);
  } finally { release(); }
  await check;
  assert.equal(calls, 2);
});

test('cancel between batches preserves only validated completed batches and prevents next dispatch', async () => {
  const controller = new AbortController(), source = snapshot('大'.repeat(12000)), plan = createAnalysisPlan(source, {inputBudget: 14000});
  let calls = 0;
  await assert.rejects(analyzeReport(model(payload => { calls++; return stream(document(payload.evidence[0].id)); }), route, source, {signal: controller.signal, plan, onProgress(value) { if (value.completed === 1) controller.abort(); }}), error => error.name === 'AbortError' && error.completed.size === 1);
  assert.equal(calls, 1);
});

test('abort settles a hung adapter, retains accepted batches and does not await iterator.return', async () => {
  const source = snapshot('长'.repeat(12000)), plan = createAnalysisPlan(source, {inputBudget: 14000});
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

test('legacy direct analyze API remains Markdown-compatible without listing version context metadata', async () => {
  const text = '## 对外接口变更\n待确认';
  assert.equal(await analyze({stream: () => stream(text)}, route, {}), text);
  const source = snapshot(); source.context = [{path: 'api.js', repository: 'app', revision: 'fixed-a', provenance: 'version-A', hash: 'hash', text: 'old'}];
  const result = markdown(source);
  assert.doesNotMatch(result, /附带源码|固定版本 fixed-a（version-A）/);
  assert.equal(source.context[0].revision, 'fixed-a');
  assert.equal(source.context[0].provenance, 'version-A');
  assert.ok(!result.includes('api.js；当前工作区快照'));
});

test('fixed evaluation fixtures validate schema, but semantics remain human reviewed', async () => {
  const suite = JSON.parse(await readFile(new URL('./fixtures/analysis-evaluation.json', import.meta.url), 'utf8'));
  assert.match(suite.qualityNotice, /人工/);
  assert.ok(suite.cases.length >= 5);
  for (const fixture of suite.cases) {
    const plan = createAnalysisPlan(fixture.snapshot);
    const ids = plan.batches[0].evidenceIds;
    const selector = fixture.evidenceSelector;
    const fine = selector && createEvidenceIndex(fixture.snapshot).items.find(item => item.kind === selector.kind && selector.contains.every(text => item.text.includes(text)));
    if (selector) assert.ok(fine, fixture.name + ': expected text must occur in one original hunk');
    const selected = fine && plan.batches[0].snapshot.evidence.find(item => item.source === fine.source && item.file === fine.file && item.start <= fine.start && item.end >= fine.end && item.text.slice(fine.start - item.start, fine.end - item.start) === fine.text);
    if (selector) assert.ok(selected, fixture.name + ': the actual request must contain that complete hunk');
    const substitute = value => JSON.parse(JSON.stringify(value).replaceAll('EVIDENCE_0', ids[0]).replaceAll('EVIDENCE_HUNK', selected?.id ?? 'missing-hunk'));
    const output = substitute(fixture.output);
    if (fixture.schemaValid) validateAnalysis(output, ids, {requireDispositions: false, evidence: plan.batches[0].snapshot.evidence});
    else assert.throws(() => validateAnalysis(output, ids), fixture.name);
    assert.ok(fixture.humanChecks.length);
  }
});
