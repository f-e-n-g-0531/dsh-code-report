import test from 'node:test';
import assert from 'node:assert/strict';
import {capturePreview} from '../src/preview-client.mjs';
const payload={sessionId:'a',request:{repositories:[{path:'client',a:'main',b:'develop'}]}};
const options=rpc=>({rpc,payload,operationId:'capture-1',pollMs:1,queryTimeoutMs:1000});
test('capture uses one short start and polls original task until preview is available',async()=>{
 const calls=[],progress=[];let reads=0;
 const value=await capturePreview({...options(async(endpoint,body)=>{calls.push(endpoint);assert.equal(body.operationId,'capture-1');if(endpoint==='preview-start')return {status:'pending'};if(endpoint==='progress')return {phase:'collecting'};return ++reads<3?{status:'pending'}:{status:'completed',result:{previewId:'p',markdown:'local'}};}),onProgress:value=>progress.push(value)});
 assert.equal(value.previewId,'p');assert.equal(calls.filter(x=>x==='preview-start').length,1);assert.equal(progress.length,2);assert.ok(!calls.includes('generate'));
});
test('lost start response and transient result transport failures never resubmit capture',async()=>{
 const calls=[],warnings=[];let reads=0;
 const value=await capturePreview({...options(async endpoint=>{calls.push(endpoint);if(endpoint==='preview-start')throw new TypeError('Failed to fetch');if(endpoint==='result'&&++reads===1)throw new TypeError('Failed to fetch');return {status:'completed',result:{previewId:'recovered'}};}),onWarning:value=>warnings.push(value)});
 assert.equal(value.previewId,'recovered');assert.deepEqual(calls,['preview-start','result','result']);assert.ok(warnings.some(x=>x.includes('未重新采集')));
});
test('confirmed backend failure is reported without retry or model dispatch',async()=>{
 const calls=[];await assert.rejects(capturePreview(options(async endpoint=>{calls.push(endpoint);return endpoint==='preview-start'?{status:'pending'}:{status:'stopped',error:{code:'code-report/git',message:'Git fetch denied'}};})),/Git fetch denied/);assert.deepEqual(calls,['preview-start','result']);
});
test('user abort sends independent explicit cancel and never resubmits',async()=>{
 const calls=[],ac=new AbortController();
 await assert.rejects(capturePreview({...options(async(endpoint,body,signal)=>{calls.push(endpoint);if(endpoint==='preview-start')return {status:'pending'};if(endpoint==='result'){ac.abort(new Error('user stop'));throw ac.signal.reason;}assert.equal(endpoint,'preview-cancel');assert.equal(signal.aborted,false);return {status:'stopped'};}),signal:ac.signal}),/user stop/);assert.deepEqual(calls,['preview-start','result','preview-cancel']);
});
test('already aborted capture never starts or cancels an unknown server task',async()=>{
 const ac=new AbortController();ac.abort();let calls=0;await assert.rejects(capturePreview({...options(async()=>{calls++;}),signal:ac.signal}));assert.equal(calls,0);
});
test('structured ownership and unavailable errors do not loop or restart capture',async()=>{
 let calls=0;await assert.rejects(capturePreview(options(async()=>{calls++;throw Object.assign(new Error('wrong owner'),{code:'code-report/session-changed'});})),/wrong owner/);assert.equal(calls,1);
 await assert.rejects(capturePreview(options(async endpoint=>endpoint==='preview-start'?{status:'pending'}:{status:'unavailable'})),/没有自动重新采集/);
});
