import test from 'node:test';
import {reportDownloadText} from '../src/report-export.mjs';
import assert from 'node:assert/strict';
import {validateAnalysis, ANALYSIS_SYSTEM, createAnalysisPlan, estimatedInputBytes, analyzeReport} from '../src/analysis.mjs';
const empty = () => ({changes: [], interfaces: [], impacts: [], qa: [], unknowns: [], evidenceDispositions: []});
const source = {id: 'e1', repository: 'app', file: 'include/api.h', text: 'SDK published contract: query is an external consumer entry point.'};
const item = (audience = 'public-sdk') => ({text: 'query 参数新增，兼容性待确认', evidenceIds: ['e1'], symbol: 'query', declarationEvidenceIds: ['e1'], audience, publicBasis: audience === 'public-sdk' ? {kind: 'sdk-publication', description: 'SDK 发布契约', quote: source.text, evidenceIds: ['e1']} : null});
const validate = value => validateAnalysis(value, ['e1'], {evidence: [source]});
test('structured SDK publication evidence is required; legacy schema cannot bypass audience classification', () => {
  const doc = empty(); doc.interfaces = [item()];
  const clean = validate(doc);
  assert.equal(clean.interfaces[0].audience, 'public-sdk');
  for (const invalid of [{text: 'DLL_EXPORT public function', evidenceIds: ['e1']}, {...item(), publicBasis: null}, {...item(), publicBasis: {...item().publicBasis, kind: 'binary-export'}}, {...item(), publicBasis: {...item().publicBasis, quote: 'not in evidence'}}]) assert.throws(() => validate({...doc, interfaces: [invalid]}));
  assert.throws(() => validateAnalysis(doc, ['e1']), /摘录/);
  const macro = 'public DLL_EXPORT void query();';
  assert.throws(() => validateAnalysis({...doc, interfaces: [{...item(), publicBasis: {...item().publicBasis, quote: macro}}]}, ['e1'], {evidence: [{...source, text: macro}]}), /DLL/);
});
test('negative, internal and uncertain SDK contracts never become public via keywords or cherry-picked quotes', () => {
  for (const text of ['内部SDK发布契约，不对外', 'SDK published contract: internal only', 'SDK 发布契约待确认', 'SDK_API public void query();', 'not a public SDK published contract']) {
    const value = {...empty(), interfaces: [{...item(), publicBasis: {...item().publicBasis, quote: text}}]};
    assert.throws(() => validateAnalysis(value, ['e1'], {evidence: [{...source, text}]}));
  }
  assert.throws(() => validateAnalysis({...empty(), interfaces: [item()]}, ['e1'], {evidence: [{...source, text: 'Internal only: ' + source.text}]}), /内部/);
});
test('separate internal implementation notes do not invalidate an explicit SDK contract sentence', () => {
  assert.equal(validateAnalysis({...empty(), interfaces: [item()]}, ['e1'], {evidence: [{...source, text: source.text + '\nInternal implementation changed; private helpers are not API.'}]}).interfaces.length, 1);
});
test('internal and unknown interfaces are routed out of public section and remain resumable', () => {
  for (const [audience, target] of [['internal', 'changes'], ['unknown', 'unknowns']]) {
    const clean = validate({...empty(), interfaces: [item(audience)]});
    assert.equal(clean.interfaces.length, 0); assert.equal(clean[target].length, 1);
    assert.deepEqual(validate(clean), clean);
  }
});
test('configured candidate boundary is necessary but never a publication proof', () => {
  const doc = {...empty(), interfaces: [item()]};
  assert.equal(validateAnalysis(doc, ['e1'], {evidence: [source], publicApiPaths: [{repository: 'other', path: 'include/'}]}).unknowns.length, 1);
  assert.equal(validateAnalysis(doc, ['e1'], {evidence: [source], publicApiPaths: [{repository: 'app', path: 'include/'}]}).interfaces.length, 1);
});
test('unrelated public contract cannot launder an internal symbol or an out-of-bound declaration', () => {
  const internal = {id: 'internal', repository: 'app', file: 'src/private.h', text: 'Internal only: void Secret();'};
  const sdk = {id: 'sdk', repository: 'app', file: 'include/public.h', text: 'SDK published contract: PublicQuery is an external consumer entry point.'};
  const value = {...empty(), interfaces: [{text: 'Secret changed', evidenceIds: ['internal', 'sdk'], audience: 'public-sdk', symbol: 'Secret', declarationEvidenceIds: ['internal'], publicBasis: {kind: 'sdk-publication', description: 'SDK contract', quote: sdk.text, evidenceIds: ['sdk']}}]};
  const options = {evidence: [internal, sdk], publicApiPaths: [{repository: 'app', path: 'include/'}]};
  for (const declarationEvidenceIds of [['internal'], ['internal', 'sdk'], ['sdk'], []]) {
    const clean = validateAnalysis({...value, interfaces: [{...value.interfaces[0], declarationEvidenceIds}]}, ['internal', 'sdk'], options);
    assert.equal(clean.interfaces.length, 0); assert.equal(clean.unknowns.length, 1);
  }
  const positive = {...value, interfaces: [{...value.interfaces[0], symbol: 'PublicQuery', declarationEvidenceIds: ['sdk']}]};
  assert.equal(validateAnalysis(positive, ['internal', 'sdk'], options).interfaces.length, 1);
  const suffix = {...value, interfaces: [{...value.interfaces[0], symbol: 'Query', declarationEvidenceIds: ['sdk']}]};
  assert.equal(validateAnalysis(suffix, ['internal', 'sdk'], options).interfaces.length, 0);
});
test('language keywords and a same-named API in another repository cannot establish SDK identity', () => {
  for (const symbol of ['void', 'public', 'SDK', 'API']) {
    const text = 'SDK published contract: ' + symbol + ' is documented.';
    const value = {...empty(), interfaces: [{...item(), symbol, publicBasis: {...item().publicBasis, quote: text}}]};
    assert.equal(validateAnalysis(value, ['e1'], {evidence: [{...source, text}]}).interfaces.length, 0);
  }
  const declaration = {id: 'decl', repository: 'other', file: 'include/api.h', text: 'void query();'};
  const value = {...empty(), interfaces: [{...item(), evidenceIds: ['decl', 'e1'], declarationEvidenceIds: ['decl']}]};
  const clean = validateAnalysis(value, ['decl', 'e1'], {evidence: [declaration, source]});
  assert.equal(clean.interfaces.length, 0); assert.equal(clean.unknowns.length, 1);
});
test('every evidence requires a conclusion reference or one explicit no-conclusion reason', () => {
  const disposition = {evidenceId: 'e1', status: 'no-conclusion', reasonCode: 'insufficient-context', reason: '缺少调用方契约，无法判断兼容性。'};
  assert.throws(() => validate(empty()), /没有结论/);
  assert.equal(validate({...empty(), evidenceDispositions: [disposition]}).evidenceDispositions.length, 1);
  for (const ledger of [[disposition, disposition], [{...disposition, evidenceId: 'foreign'}], [{...disposition, reason: ''}], [{...disposition, reasonCode: 'done'}]]) assert.throws(() => validate({...empty(), evidenceDispositions: ledger}));
  assert.throws(() => validate({...empty(), changes: [{text: '变更', evidenceIds: ['e1']}], evidenceDispositions: [disposition]}), /重叠/);
  assert.throws(() => validateAnalysis(empty(), ['e1'], {requireDispositions: true}), /没有结论/);
});
test('normalized migration preserves bounded section aggregation and prefix byte limits', () => {
  const ordinary = {text: 'change', evidenceIds: ['e1']};
  for (const [audience, target] of [['internal', 'changes'], ['unknown', 'unknowns'], ['public-sdk', 'unknowns']]) {
    const raw = {...empty(), [target]: Array.from({length: 200}, () => ({...ordinary})), interfaces: Array.from({length: 200}, () => ({...item(audience), text: 'x'.repeat(16384)}))};
    const options = {evidence: [source], publicApiPaths: [{repository: 'app', path: 'elsewhere/'}]};
    const clean = validateAnalysis(raw, ['e1'], options);
    assert.equal(clean[target].length, 400);
    assert.ok(clean[target].some(row => Buffer.byteLength(row.text) > 16384));
    assert.deepEqual(validateAnalysis(clean, ['e1'], {...options, normalized: true}), clean);
    assert.throws(() => validateAnalysis(clean, ['e1'], options), /200/);
    assert.throws(() => validateAnalysis({...clean, [target]: [...clean[target], ordinary]}, ['e1'], {...options, normalized: true}), /400/);
  }
  const restore = value => validateAnalysis(value, ['e1'], {normalized: true, evidence: [source]});
  const entries = count => Array.from({length: count}, () => ({...ordinary}));
  assert.throws(() => restore({...empty(), changes: entries(400), unknowns: entries(400), impacts: entries(200), qa: entries(1)}), /1000/);
  assert.throws(() => restore({...empty(), impacts: entries(201)}), /200/);
  for (const text of ['x'.repeat(16385), '内部接口：' + 'x'.repeat(16385), '内部接口：' + 'x'.repeat(16383) + '\u0000']) assert.throws(() => restore({...empty(), changes: [{...ordinary, text}]}));
  assert.throws(() => restore({...empty(), interfaces: [item('internal')]}), /public-sdk/);
  assert.throws(() => validate({...empty(), interfaces: [{...item('internal'), text: 'x'.repeat(16385)}]}));
});
test('analyzeReport explicitly restores normalized migrated checkpoints without dispatching again', async () => {
  const snapshot = {title: 'scope', repositories: [{path: 'app', type: 'git', a: 'a', b: 'b', files: ['api.h'], diff: 'diff --git a/api.h b/api.h\n--- a/api.h\n+++ b/api.h\n@@ -1 +1 @@\n-old\n+new\n'}], context: [], limitations: []};
  const plan = createAnalysisPlan(snapshot, {inputBudget: 64000});
  let calls = 0;
  const llm = {async *stream(input) {
    calls++;
    const {evidence} = JSON.parse(input.messages[0].content[0].text);
    const value = {...empty(), changes: Array.from({length: 200}, () => ({text: 'change', evidenceIds: evidence.map(row => row.id)})), interfaces: [{...item('internal'), evidenceIds: evidence.map(row => row.id), declarationEvidenceIds: [evidence[0].id], text: 'x'.repeat(16384)}]};
    yield {type: 'text-delta', text: JSON.stringify(value)};
    yield {type: 'finish', reason: {kind: 'stop'}};
  }};
  const route = {provider: 'test', model: 'mock'};
  const first = await analyzeReport(llm, route, snapshot, {plan});
  const before = calls;
  const resumed = await analyzeReport(llm, route, snapshot, {plan, completed: first.completed});
  assert.equal(calls, before);
  assert.deepEqual(resumed.completed, first.completed);
  assert.equal(resumed.markdown, first.markdown);
});
test('candidate requires changed symbol evidence within the configured project and boundary',()=>{
 const diff={...source,provenance:'version-diff',text:'@@ -1 +1 @@\n-int query();\n+int query(int flags);'};
 const value={...empty(),interfaces:[item('sdk-candidate')]};
 const paths=[{repository:'app',path:'include/'}];
 const check=(evidence,publicApiPaths=paths,normalized=false,doc=value)=>validateAnalysis(doc,['e1'],{evidence:[evidence],publicApiPaths,normalized});
 const clean=check(diff);
 assert.equal(clean.interfaces[0].audience,'sdk-candidate');
 assert.deepEqual(check(diff,paths,true,clean),clean);
 for(const unsupported of [{...diff,file:'includes/api.h'},{...diff,repository:'other'},{...diff,provenance:'current-workspace'},{...diff,text:' int query();\n+int unrelated();'},{...diff,text:'+// query update'}])assert.equal(check(unsupported).unknowns.length,1);
 assert.equal(check(diff,[]).interfaces.length,0);
 assert.throws(()=>check(diff,paths,false,{...value,interfaces:[{...item('sdk-candidate'),publicBasis:item().publicBasis}]}),/正式发布依据/);
});
for(const strategy of ['full','single-request'])test('final report shows a changed candidate in the second section without claiming publication '+strategy,async()=>{
 const file='include/api.h';
 const snapshot={title:'scope',publicApiPaths:[{repository:'app',path:'include/'}],repositories:[{path:'app',type:'git',a:'a',b:'b',files:[file],diff:'diff --git a/'+file+' b/'+file+'\n--- a/'+file+'\n+++ b/'+file+'\n@@ -1 +1 @@\n-int query();\n+int query(int flags);\n'}],context:[],limitations:[]};
 const plan=createAnalysisPlan(snapshot,{inputBudget:64000,strategy});
 const llm={async *stream(input){
  const {evidence}=JSON.parse(input.messages[0].content[0].text);
  const changed=evidence.find(row=>row.provenance==='version-diff'&&row.text.includes('+int query('));
  assert.ok(changed);
  const value={...empty(),interfaces:[{...item('sdk-candidate'),evidenceIds:[changed.id],declarationEvidenceIds:[changed.id]}],evidenceDispositions:evidence.filter(row=>row.id!==changed.id).map(row=>({evidenceId:row.id,status:'no-conclusion',reasonCode:'non-behavioral',reason:'元数据'}))};
  yield {type:'text-delta',text:JSON.stringify(value)};
  yield {type:'finish',reason:{kind:'stop'}};
 }};
 const result=await analyzeReport(llm,{provider:'test',model:'mock'},snapshot,{plan});
 const report=reportDownloadText(result.markdown,'analysis');
 assert.equal([...report.matchAll(/^## (.+)$/gm)][1][1],'对外接口变更');
 assert.match(report.split('## 改动内容')[0],/SDK 候选接口（发布身份待确认）：query/);
});

test('prompt budget includes structured attribution and evidence disposition instructions', () => {
  assert.match(ANALYSIS_SYSTEM, /二进制导出≠公共SDK/); assert.match(ANALYSIS_SYSTEM, /evidenceDispositions/);
  const snapshot = {title: 'scope', repositories: [{path: 'app', type: 'git', a: 'a', b: 'b', files: ['api.h'], diff: 'diff --git a/api.h b/api.h\n--- a/api.h\n+++ b/api.h\n@@ -1 +1 @@\n-old\n+new\n'}], context: [], limitations: []};
  const plan = createAnalysisPlan(snapshot);
  assert.equal(plan.strategy, 'full'); assert.equal(plan.coverage.fullManifestFiles, 1); assert.equal(plan.coverage.files[0].sentText, true);
  for (const batch of plan.batches) assert.equal(estimatedInputBytes(batch.snapshot), batch.inputBytes);
});
