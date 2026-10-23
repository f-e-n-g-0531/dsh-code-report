import test from 'node:test';
import assert from 'node:assert/strict';
import {createResultStore,staleResult,previewExpired,generationBlocker,parseVersionContexts,captureBlocker,needsResultRecovery,readCompletedResult} from '../src/result-state.mjs';
import {fresh,repositoryIssues,rowIssues,zeroDifferenceWarning} from '../src/repositories.mjs';
import {createClientRpc} from '../src/client-rpc.mjs';
const one={id:'one',cwd:'G:/workspace'},two={id:'two',cwd:'G:/workspace'};
test('private result store restores only bounded session and workspace scoped result metadata',()=>{
 const store=createResultStore({limit:2,maxBytes:100});
 store.set(one,{markdown:'report',consent:true,previewId:'unsafe',snapshot:{text:'source'}});
 assert.deepEqual(store.get(one),{markdown:'report',stale:true,coverage:undefined});
 assert.equal(store.get(two),null);assert.equal(store.get({...one,cwd:'G:/other'}),null);
 store.set(two,{markdown:'second'});store.set({id:'three',cwd:'G:/workspace'},{markdown:'third'});assert.equal(store.get(one),null);
 assert.equal(createResultStore().get(two),null);
 store.set(one,{markdown:'x'.repeat(101)});assert.equal(store.get(one),null);
});
test('draft invalidation retains old report but never mutates its evidence',()=>{
 const original={markdown:'fixed evidence',stale:false,coverage:{total:2}};
 assert.deepEqual(staleResult(original),{...original,stale:true});assert.equal(original.stale,false);assert.equal(staleResult(null),null);
});
test('snapshot expiry fails closed and generation requires exact current approval',()=>{
 const preview={expiresAt:1000,analysisPlan:{id:'plan'}};
 assert.equal(previewExpired(preview,999),false);assert.equal(previewExpired(preview,1000),true);
 assert.equal(previewExpired({expiresAt:'invalid'},0),true);
 const input={preview,now:999,compatibility:'',busy:'',consent:true,provider:'p',model:'m'};
 assert.equal(generationBlocker(input),'');
 for(const change of [{now:1000},{consent:false},{provider:''},{model:''},{busy:'collecting'},{compatibility:'mismatch'},{preview:{expiresAt:1000}}])assert.ok(generationBlocker({...input,...change}));
});
test('fixed version context parser accepts only explicit selected repository sides',()=>{
 const rows=[{...fresh(),path:'app'}];
 assert.deepEqual(parseVersionContexts('app|A|src/api.ts\n app | B | src/api.ts ',rows),[{repository:'app',side:'A',path:'src/api.ts'},{repository:'app',side:'B',path:'src/api.ts'}]);
 for(const text of ['app|C|src/a','app|A','other|B|a','app|A|a|extra'])assert.throws(()=>parseVersionContexts(text,rows));
 assert.throws(()=>parseVersionContexts('app|A|x',[{...rows[0],enabled:false}]));
});
test('row validation explains missing input, selected duplicates and zero differences',()=>{
 const row={...fresh(),path:'app',branchA:'main',branchB:'release'};
 assert.deepEqual(rowIssues([row],0),[]);assert.equal(zeroDifferenceWarning(row),'');
 assert.match(rowIssues([row,{...row,path:'app/'}],0).join(' '),/重复/);
 assert.deepEqual(rowIssues([row,{...row,enabled:false}],0),[]);
 assert.match(zeroDifferenceWarning({...row,branchB:'main'}),/无差异/);
 assert.match(captureBlocker([{...row,type:'svn'}],false,'','',[]),/SVN/);
 assert.match(captureBlocker([row],false,'','',repositoryIssues([{...row,branchA:''}])),/Git A/);
 assert.equal(captureBlocker([row],false,'','',[]),'');
});
test('current local result never overwrites latest successful paid analysis',()=>{
 const store=createResultStore({maxBytes:1000});
 store.set(one,{markdown:'paid model report',kind:'analysis'});
 store.set(one,{markdown:'new local evidence',kind:'local'});
 assert.equal(store.get(one).markdown,'new local evidence');
 assert.equal(store.getAnalysis(one).markdown,'paid model report');
 assert.equal(store.getAnalysis(one).stale,true);assert.equal(store.getAnalysis(two),null);
 store.set(one,{markdown:'next paid report',kind:'analysis'});
 assert.equal(store.getAnalysis(one).markdown,'next paid report');
 store.delete(one);assert.equal(store.getAnalysis(one),null);
 const bounded=createResultStore({maxBytes:10});
 bounded.set(one,{markdown:'123456',kind:'analysis'});
 bounded.set(one,{markdown:'789012',kind:'local'});
 assert.equal(bounded.get(one),null);assert.equal(bounded.getAnalysis(one),null);
});
test('unknown paid operation recovery survives session switches without crossing boundaries',()=>{
 const store=createResultStore();
 store.setRecovery(one,{operationId:'paid-operation',consent:true,source:'not retained'});
 assert.equal(store.getRecovery(two),null);assert.equal(store.getRecovery({...one,cwd:'other'}),null);
 assert.deepEqual(store.getRecovery(one),{operationId:'paid-operation'});
 store.set(one,{markdown:'previous report'});store.delete(one);
 assert.deepEqual(store.getRecovery(one),{operationId:'paid-operation'});
 store.setRecovery(one,null);assert.equal(store.getRecovery(one),null);
 assert.equal(createResultStore().getRecovery(one),null);
});
test('ambiguous model outcome is read once without dispatch or inherited approval',async()=>{
 assert.equal(needsResultRecovery(new Error('response lost')),true);
 assert.equal(needsResultRecovery({code:'code-report/analysis-incomplete'}),false);
 const calls=[];
 const rpc=async(endpoint,payload)=>{calls.push({endpoint,payload});return {status:'completed',result:{markdown:'paid result',coverage:{total:1}}};};
 const response=await readCompletedResult(rpc,'one','operation');
 assert.equal(response.result.markdown,'paid result');
 assert.deepEqual(calls,[{endpoint:'result',payload:{sessionId:'one',operationId:'operation'}}]);
 for(const status of ['pending','failed'])assert.equal((await readCompletedResult(async()=>({status}),'one','operation')).status,status);
 await assert.rejects(readCompletedResult(async()=>({status:'completed'}),'one','operation'),/响应无效/);
 assert.match(generationBlocker({pendingRecovery:{operationId:'operation'}}),/勿重复生成/);
});
test('RPC preserves typed business error and cancellation without transport retries',async()=>{
 let calls=0;
 const rpc=createClientRpc({rpc:{async call(){calls++;return {ok:false,error:{code:'code-report/preview-expired',message:'expired',details:{remainingBatches:2}}};}}});
 await assert.rejects(rpc('generate',{}),error=>error.code==='code-report/preview-expired'&&error.details.remainingBatches===2&&error.message==='expired');assert.equal(calls,1);
 const ac=new AbortController();ac.abort();const original=new Error('cancelled');
 await assert.rejects(createClientRpc({rpc:{async call(){throw original;}}})('preview',{},ac.signal),error=>error===original);
});
