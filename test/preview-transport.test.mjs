import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createHandler} from '../src/host.mjs';
import {capturePreview} from '../src/preview-client.mjs';
const snapshot={title:'transport fixture',createdAt:'fixed',repositories:[],context:[],limitations:[]};
test('real HTTP delayed-header deadline fails legacy capture while short task polling completes exactly once',async()=>{
 let captures=0,models=0;
 const handler=createHandler({sessions:new Map([['s',{header:{cwd:'/fixture'}}]]),llm:{stream(){models++;throw new Error('model forbidden');}}},{capture:async()=>{captures++;await new Promise(resolve=>setTimeout(resolve,900));return snapshot;}});
 const server=http.createServer(async(req,res)=>{
  let text='';for await(const chunk of req)text+=chunk;
  const result=await handler(req.url.slice(1),JSON.parse(text));if(!res.destroyed){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+server.address().port;
 const rpc=async(endpoint,payload,signal)=>{const response=await fetch(url+'/'+endpoint,{method:'POST',body:JSON.stringify(payload),signal});const envelope=await response.json();if(!envelope.ok)throw Object.assign(new Error(envelope.error.message),envelope.error);return envelope.value;};
 try{
  // A scaled controlled carrier deadline models a proxy dropping a silent unary request.
  await assert.rejects(rpc('preview',{sessionId:'s',request:{}},AbortSignal.timeout(400)),/abort|timeout/i);
  const result=await capturePreview({rpc,payload:{sessionId:'s',request:{}},operationId:'http-task',queryTimeoutMs:400,pollMs:25});
  assert.equal(typeof result.previewId,'string');assert.equal(captures,2);assert.equal(models,0);
  const recovered=await rpc('result',{sessionId:'s',operationId:'http-task'});assert.equal(recovered.result.previewId,result.previewId);assert.equal(captures,2);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
