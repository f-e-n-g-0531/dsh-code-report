import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {version} from '../../package.json';
import {PACKAGE_NAME,PROTOCOL_VERSION} from '../../src/protocol.mjs';

const settings={count:1,ttl:600000,failPreview:false,failGenerate:false,delayPreview:0,delayGenerate:0,ignoreAbort:false,runtimeMismatch:false,progressFailure:false,...window.__fixtureOptions};
const calls=[];const previews=new Map(),results=new Map();let previewSequence=0,modelCalls=0,installCalls=0,settledPreviews=0,switchSession;
const sessions={a:{id:'a',cwd:'G:/fixture/a',retainedBy:{mainView:1}},b:{id:'b',cwd:'G:/fixture/b',retainedBy:{mainView:1}}};
const ok=value=>({ok:true,value});
const fail=(message,code='code-report/input')=>({ok:false,error:{code,message,details:{fixture:true}}});
const info=()=>({packageName:PACKAGE_NAME,protocol:PROTOCOL_VERSION,runningVersion:settings.runtimeMismatch?'0.0.0':version});
const plan=()=>({id:'plan-fixture',inputBudget:24000,estimated:true,batches:[{id:'batch-1',evidenceIds:['e-1'],inputBytes:100}],coverage:{total:1,excluded:0}});
const wait=(ms,signal)=>new Promise((resolve,reject)=>{
 if(!settings.ignoreAbort)signal?.throwIfAborted();
 const abort=()=>{clearTimeout(timer);reject(signal.reason||new DOMException('Aborted','AbortError'));};
 const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},ms);
 if(!settings.ignoreAbort)signal?.addEventListener('abort',abort,{once:true});
});
async function rpc(channel,endpoint,payload,signal){
 calls.push({channel,endpoint,payload:structuredClone(payload)});
 if(endpoint==='runtime-info')return ok(info());
 if(endpoint==='result'){
  const entry=results.get(payload.operationId);
  if(!entry||entry.sessionId!==payload.sessionId)return fail('结果不可用','code-report/result-unavailable');
  return ok(settings.resultPending?{status:'pending'}:{status:'completed',result:entry.value});
 }
 if(endpoint==='check-update')return ok({...info(),latestVersion:'99.0.0',available:true,releaseUrl:'https://example.invalid/release'});
 if(endpoint==='discover')return ok({repositories:Array.from({length:settings.count},(_,i)=>({path:i?'project-'+i+'-'+('very-long-path-'.repeat(12)):'client',type:settings.mixed&&i===1?'svn':'git',branch:settings.mixed&&i===1?'trunk':'main'})),warnings:[],visited:settings.count+1});
 if(endpoint==='refs')return ok({refs:['main','release','refs/tags/v1.0']});
 if(endpoint==='progress'){if(settings.progressFailure)throw new Error('fixture progress disconnected');return ok({phase:'collecting',completed:0,total:1,label:'fixture 正在处理'});}
 if(endpoint==='release-preview'){previews.delete(payload.previewId);return ok({released:true});}
 if(endpoint==='analysis-plan')return ok({analysisPlan:plan(),...plan()});
 if(endpoint==='preview'){
  const request=structuredClone(payload.request);
  await wait(settings.delayPreview,signal);settledPreviews++;
  if(settings.failPreview)return fail('fixture 采集失败');
  const previewId='preview-'+(++previewSequence);
  const value={previewId,expiresAt:Date.now()+settings.ttl,bytes:100,repositories:request.repositories.map(row=>({...row,a:'a'.repeat(40),b:'b'.repeat(40),files:['api.ts']})),context:[],limitations:['模拟服务，不读取真实仓库'],analysisPlan:plan(),markdown:'# 本地证据 '+payload.sessionId+' '+request.title+'\n未调用模型\n<script>window.fixtureInjected=true</script>'};
  previews.set(previewId,{sessionId:payload.sessionId,value});return ok(value);
 }
 if(endpoint==='generate'){
  const preview=previews.get(payload.previewId);
  if(payload.sendToModel!==true)return fail('需要明确确认');
  if(!preview||preview.sessionId!==payload.sessionId)return fail('预览不可用','code-report/preview-expired');
  if(Date.now()>=preview.value.expiresAt)return fail('预览已过期','code-report/preview-expired');
  modelCalls++;await wait(settings.delayGenerate,signal);
  if(settings.failGenerate)return fail('fixture 模型失败');
  const value={markdown:'# 模型报告 '+payload.sessionId+'\n## 对外接口变更\n待确认\n<script>window.fixtureInjected=true</script>',coverage:{total:1,completed:1,excluded:0}};
  results.set(payload.operationId,{sessionId:payload.sessionId,value});
  if(settings.failGenerateResponse)throw new Error('fixture response lost after generation');
  return ok(value);
 }
 return fail('未知模拟端点 '+endpoint);
}
window.fixture={configure(value){Object.assign(settings,value);},getStats:()=>({calls:structuredClone(calls),modelCalls,installCalls,settledPreviews}),switchSession:id=>switchSession(id),settings};
let entry;window.__ModuleLoader__={load(value){entry=value;}};
await new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='/client.js';script.onload=resolve;script.onerror=reject;document.head.append(script);});
const plugin=entry.factory(id=>{if(id!=='react')throw new Error('Unexpected external '+id);return React;});
let Page;
plugin.apply({connection:{rpc:{call:rpc}},remote:{pluginManager:{async installBundle(){installCalls++;return ok({application:'restart-required'});}}},slots:{inject(_name,fn){fn();},register(options,component){if(options.name==='main')Page=component;}}});
function App(){const [id,setId]=useState(settings.noSession?null:'a');switchSession=setId;return <><div aria-label="模拟宿主会话"><button onClick={()=>setId('a')}>测试会话 A</button><button onClick={()=>setId('b')}>测试会话 B</button><button onClick={()=>setId(null)}>关闭测试会话</button></div><Page useSessions={select=>select({byId:id?{[id]:sessions[id]}:{}})}/></>;}
createRoot(document.getElementById('root')).render(<App/>);
