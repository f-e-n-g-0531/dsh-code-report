import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSingleRequestEvidence} from '../src/single-request.mjs';
import {evidenceHash,snapshotHash} from '../src/evidence.mjs';

const estimate=items=>1800+Buffer.byteLength(JSON.stringify(JSON.stringify({evidence:items})));
const options={inputBudget:24000,estimate};
const patch=(name,text)=>'diff --git a/'+name+' b/'+name+'\n--- a/'+name+'\n+++ b/'+name+'\n@@ -1 +1 @@\n-old\n+'+text+'\n';
const repository=(path,files)=>({path,type:'git',a:'a'.repeat(40),b:'b'.repeat(40),files:Object.keys(files),diff:Object.entries(files).map(([name,text])=>patch(name,text)).join(''),excludedPaths:[]});
const snapshot=repositories=>({title:'digest',createdAt:'fixed',limitations:[],repositories,context:[]});

test('digest is deterministic, snapshot-bound, within exact callback budget and does not mutate source',()=>{
  const source=snapshot([repository('app',{'api.js':'中文🙂'.repeat(500)})]);
  const before=JSON.stringify(source),one=buildSingleRequestEvidence(source,options),two=buildSingleRequestEvidence(source,options);
  assert.deepEqual(one,two);assert.equal(JSON.stringify(source),before);
  assert.equal(one.snapshotHash,snapshotHash(source));assert.ok(estimate(one.items)<=options.inputBudget);
  assert.equal(new Set(one.items.map(item=>item.id)).size,one.items.length);
  assert.equal(one.coverage.strategy,'single-request');assert.match(one.coverage.note,/不等于模型全文覆盖/);
  const raw=one.items.filter(item=>item.provenance==='version-diff');assert.ok(raw.length);
  for(const item of raw){assert.equal(item.text,source.repositories[0].diff.slice(item.start,item.end));assert.ok(!/[\uD800-\uDBFF]$/.test(item.text));}
  const changed=structuredClone(source);changed.repositories[0].b='c'.repeat(40);
  assert.notDeepEqual(buildSingleRequestEvidence(changed,options).items.map(item=>item.id),one.items.map(item=>item.id));
});

test('large linker maps retain complete local hashes and metadata but never send symbol bodies',()=>{
  const symbol='LINKER_PRIVATE_SYMBOL_'.repeat(100000),source=snapshot([repository('app',{'big.map':symbol,'api.cpp':'real code'})]);
  const result=buildSingleRequestEvidence(source,options),map=result.manifest.find(file=>file.path==='big.map');
  assert.equal(result.manifest.length,2);assert.equal(result.coverage.generatedFileCount,1);
  assert.equal(map.generated,true);assert.equal(map.sentText,false);
  assert.ok(map.sourceBytes>2_000_000);assert.equal(map.sourceHash,evidenceHash(patch('big.map',symbol)));
  assert.ok(!JSON.stringify(result.items).includes('LINKER_PRIVATE_SYMBOL_'));
  assert.equal(result.coverage.originalSourceBytes,Buffer.byteLength(source.repositories[0].diff));
  assert.equal(result.coverage.sourceBytesBasis,'decoded-utf8');assert.ok(result.coverage.sentSourceBytes<result.coverage.decodedSourceBytes);
});

test('same paths across repositories remain distinct and optional evidence is fairly budgeted',()=>{
  const source=snapshot([repository('one',{'same.cpp':'one'.repeat(3000)}),repository('two',{'same.cpp':'two'.repeat(3000)})]);
  const result=buildSingleRequestEvidence(source,{...options,inputBudget:12000});
  assert.equal(result.manifest.length,2);assert.notEqual(result.manifest[0].source,result.manifest[1].source);
  for(const name of ['one','two']){
    assert.ok(result.items.some(item=>item.repository===name&&item.kind==='scope'));
    assert.ok(result.items.some(item=>item.repository===name&&item.provenance==='version-diff'));
  }
  assert.equal(result.coverage.sentFileCount,2);assert.equal(result.coverage.omittedFileCount,0);
});

test('all contexts share the same bounded budget and omissions have a full local manifest',()=>{
  const source=snapshot([repository('app',{'x.js':'x'})]);
  source.context=Array.from({length:80},(_,i)=>({path:'same.js',repository:i%2?'a':'b',revision:'r'+i,provenance:'version-A',hash:'raw-'+i,text:'content-'+i+'🙂'.repeat(1000)}));
  const result=buildSingleRequestEvidence(source,{...options,inputBudget:12000});
  assert.equal(result.coverage.contextManifest.length,80);
  assert.equal(result.coverage.sentContextFileCount+result.coverage.omittedContextFileCount,80);
  const scope=JSON.parse(result.items.find(item=>item.source==='single-context-scope').text);
  assert.equal(scope.sentFileCount,result.coverage.sentContextFileCount);
  assert.equal(scope.omittedFileCount,result.coverage.omittedContextFileCount);
  assert.equal(result.coverage.sentTextFileCount,result.manifest.filter(file=>file.sentText).length);
  assert.equal(result.coverage.sentContextTextFileCount,result.coverage.contextManifest.filter(file=>file.sentText).length);
  assert.ok(result.coverage.omittedContextFileCount>0);assert.ok(estimate(result.items)<=12000);
  for(const item of result.items.filter(item=>item.kind==='context')){
    const index=Number(item.source.split(':')[1]);assert.equal(item.text,source.context[index].text.slice(item.start,item.end));
    assert.equal(item.revision,'r'+index);assert.equal(item.hash,'raw-'+index);
  }
});

test('unassigned paths are never fabricated and synthetic offsets are independent',()=>{
  const source=snapshot([{path:'svn',type:'svn',a:'1',b:'2',files:['nested/x.cpp',''],changes:[{path:'',kind:'dir',item:'none',props:'modified'}],diff:'Index: x.cpp\n===\n@@ -1 +1 @@\n-a\n+b\n'}]);
  const result=buildSingleRequestEvidence(source,options);
  assert.ok(result.coverage.unassignedSourceBytes>0);
  assert.ok(!result.items.some(item=>item.provenance==='version-diff'));
  assert.equal(result.manifest.length,2);
  for(const item of result.items){assert.equal(item.start,0);assert.equal(item.end,item.text.length);assert.ok(item.source.startsWith('single-'));}
});

test('path heuristics favor contracts and code over assets and preserve safe scope identity',()=>{
  const source=snapshot([repository('app',{'00-image.svg':'asset'.repeat(500),'api/public.hpp':'signature'.repeat(500),'z.cpp':'code'.repeat(500)})]);
  Object.assign(source.repositories[0],{requestedA:'main~1',requestedB:'main',gitSource:'remote',remote:'origin',observedAt:'fixed',identity:{urlA:'secret-url'}});
  const result=buildSingleRequestEvidence(source,{...options,inputBudget:8000});
  const selected=result.items.filter(item=>item.provenance==='version-diff');assert.equal(selected[0].file,'api/public.hpp');
  assert.equal(selected[0].sourceHash,evidenceHash(source.repositories[0].diff));
  assert.equal(selected[0].blockHash,evidenceHash(patch('api/public.hpp','signature'.repeat(500))));
  const summary=JSON.parse(result.items[0].text);assert.equal(summary.requestedA,'main~1');assert.equal(summary.remote,'origin');
  assert.ok(!JSON.stringify(result.items).includes('secret-url'));
  assert.match(result.coverage.note,/并非语义/);
});

test('actual analysis estimator bounds JSON escape expansion and final omission counts',async()=>{
  const {estimatedInputBytes}=await import('../src/analysis.mjs');
  const source=snapshot([repository('app',{'api.hpp':'\x01"\\🙂'.repeat(4000)})]);
  const exact=items=>estimatedInputBytes({schema:2,evidenceVersion:2,title:source.title,limitations:source.limitations,evidence:items});
  const result=buildSingleRequestEvidence(source,{inputBudget:8000,estimate:exact});
  assert.ok(exact(result.items)<=8000);
  const scope=JSON.parse(result.items[0].text);
  assert.equal(scope.sentFileCount,result.coverage.sentFileCount);
  assert.equal(scope.omittedFileCount,result.coverage.omittedFileCount);
  assert.equal(scope.sentTextFileCount,result.coverage.sentTextFileCount);
});

test('insufficient mandatory metadata fails visibly rather than dropping projects',()=>{
  const source=snapshot([repository('first',{'a':'x'}),repository('second',{'b':'y'})]);
  assert.throws(()=>buildSingleRequestEvidence(source,{inputBudget:4000,estimate:items=>5000+items.length}),/未静默遗漏项目/);
  assert.throws(()=>buildSingleRequestEvidence(source,{inputBudget:3999,estimate}),/4000/);
  assert.throws(()=>buildSingleRequestEvidence(source,{inputBudget:10000,estimate:()=>NaN}),/估算/);
});
