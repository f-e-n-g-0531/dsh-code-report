import test from 'node:test';
import assert from 'node:assert/strict';
import {apply,inject} from '../index.mjs';
import {createClientRpc} from '../src/client-rpc.mjs';
import {createHandler} from '../src/host.mjs';
test('host registration declares webServer and registers route through plugin owner',async()=>{
 let handler,route;const allowed=new Set(inject);assert.ok(allowed.has('webServer'));
 const values={effect:fn=>fn(),webServer:{register(value){route=value;}},connection:{register(owner,channel,fn){handler=fn;return owner.effect(()=>owner.webServer.register({kind:'prefix',path:channel}));}}};
 const ctx=new Proxy(values,{get(target,key){if(key!=='effect'&&!allowed.has(key))throw new Error('cannot get property without inject: '+String(key));return target[key];}});apply(ctx);assert.equal(route.path,'/code-report-rpc');const result=await handler('runtime-info',{});assert.equal(result.ok,true);assert.equal(typeof result.value.runningVersion,'string');
});
test('all failed host endpoints satisfy strict Connection failure envelope',async()=>{
 const handler=createHandler({sessions:{get(){return undefined;}},sessionPersistence:{async stat(){return undefined;}}});
 const rpc=createClientRpc({rpc:{async call(channel,endpoint,payload){
  const wire=JSON.parse(JSON.stringify({type:'server-response',rpcId:'test',result:await handler(endpoint,payload)}));
  const failure=wire.result.error;
  assert.equal(wire.result.ok,false);assert.equal(typeof failure.code,'string');assert.equal(typeof failure.message,'string');assert.ok(failure.details&&typeof failure.details==='object'&&!Array.isArray(failure.details));
  return wire.result;
 }}});
 for(const endpoint of ['discover','preview','generate','progress','release-preview','invalid'])await assert.rejects(rpc(endpoint,{sessionId:'missing'}),/当前会话工作区不可用|无效请求/);
});
test('client explains HTTP 405 and does not retry or install anything',async()=>{let calls=0;const rpc=createClientRpc({rpc:{async call(){calls++;throw new Error('transport failure for /code-report-rpc/check-update: HTTP 405');}}});await assert.rejects(rpc('check-update',{}),e=>/插件后台连接失败/.test(e.message)&&/HTTP 405/.test(e.message)&&/只刷新页面不会重载后台/.test(e.message));assert.equal(calls,1);});
test('client preserves application errors and cancellation',async()=>{const rpc=createClientRpc({rpc:{async call(){return {ok:false,error:{message:'SVN 版本无效'}};}}});await assert.rejects(rpc('preview',{}),/SVN 版本无效/);const ac=new AbortController();ac.abort();const error=new Error('cancelled');const cancelled=createClientRpc({rpc:{async call(){throw error;}}});await assert.rejects(cancelled('preview',{},ac.signal),e=>e===error);});
