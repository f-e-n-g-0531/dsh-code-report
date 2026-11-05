import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {version} from '../../package.json';
import {PACKAGE_NAME,PROTOCOL_VERSION} from '../../src/protocol.mjs';

// Synthetic service: dispatched model work can outlive its client transport.
const settings={count:1,ttl:600000,failPreview:false,failGenerate:false,delayPreview:0,delayGenerate:0,ignoreAbort:false,runtimeMismatch:false,progressFailure:false,holdGenerate:false,holdInstall:false,holdRefs:false,...window.__fixtureOptions};
const calls=[],previews=new Map(),results=new Map(),captureTasks=new Map(),gates=new Map();
let previewSequence=0,modelCalls=0,installCalls=0,settledPreviews=0,settledGenerations=0,generateAborts=0,switchSession;
const sessions={a:{id:'a',cwd:'G:/fixture/a',retainedBy:{mainView:1}},b:{id:'b',cwd:'G:/fixture/b',retainedBy:{mainView:1}}};
const ok=value=>({ok:true,value});
const execution=(phase,{dispatched=true,available=false}={})=>({backendInstanceId:'fixture-backend',dispatch:dispatched?'dispatched':'not-dispatched',dispatchCount:dispatched?1:0,completedBatches:available?(settings.analysisBatches||1):0,totalBatches:settings.analysisBatches||1,resultAvailability:available?'available':'unavailable',phase});
const fail=(message,code='code-report/input',extra={})=>({ok:false,error:{code,message,details:{fixture:true,...extra}}});
const info=()=>({packageName:PACKAGE_NAME,protocol:PROTOCOL_VERSION,runningVersion:settings.runtimeMismatch?'0.0.0':(settings.runningVersion||version),asyncPreview:true});
// Single-request fixtures are contract mocks, not real compaction or coverage calculations.
const singleCoverage=()=>({strategy:'single-request',originalSourceBytes:987654,fullManifestFiles:12,sentFileCount:7,sentTextFileCount:2,omittedFileCount:5,generatedFileCount:4,total:7,processed:7,remaining:0,completedBatches:1,totalBatches:1,cited:0});
const plan=()=>settings.singleRequest?{id:'plan-single-fixture',strategy:'single-request',inputBudget:settings.singleBudget||64000,estimated:true,batches:[{id:'batch-single',evidenceIds:['summary-1'],inputBytes:4200}],coverage:singleCoverage()}:{id:'plan-fixture',inputBudget:24000,estimated:true,batches:Array.from({length:settings.analysisBatches||1},(_,index)=>({id:'batch-'+(index+1),evidenceIds:['e-'+(index+1)],inputBytes:100})),coverage:{total:settings.analysisBatches||1,excluded:0}};
function gate(name){return new Promise(resolve=>{gates.set(name,resolve);});}
function release(name){const resolve=gates.get(name);if(resolve){gates.delete(name);resolve();}}
const wait=(ms,signal)=>new Promise((resolve,reject)=>{
 if(!settings.ignoreAbort)signal?.throwIfAborted();
 const abort=()=>{clearTimeout(timer);reject(signal.reason||new DOMException('Aborted','AbortError'));};
 const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},ms);
 if(!settings.ignoreAbort)signal?.addEventListener('abort',abort,{once:true});
});
function modelTransport(work,signal){
 if(settings.ignoreAbort||!signal)return work;
 return new Promise((resolve,reject)=>{
  const abort=()=>{generateAborts++;reject(signal.reason||new DOMException('Aborted','AbortError'));};
  if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});
  work.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
 });
}
async function rpc(channel,endpoint,payload,signal){
 calls.push({channel,endpoint,payload:structuredClone(payload)});
 if(endpoint==='runtime-info')return ok(info());
 if(endpoint==='preview-cancel'){const task=captureTasks.get(payload.operationId);if(!task||task.sessionId!==payload.sessionId)return fail('采集任务不存在');task.status='stopped';task.error={code:'code-report/capture-stopped',message:'fixture 采集已取消'};if(task.value)previews.delete(task.value.previewId);return ok({operationId:payload.operationId,status:'stopped'});}
 if(endpoint==='result'){
  const capture=captureTasks.get(payload.operationId);if(capture&&capture.sessionId===payload.sessionId){if(settings.failCaptureResultOnce){settings.failCaptureResultOnce=false;throw new Error('fixture capture result response lost');}return ok({status:capture.status,...(capture.status==='completed'?{result:capture.value}:{}),...(capture.error?{error:capture.error}:{})});}
  const entry=results.get(payload.operationId);
  if(!entry||entry.sessionId!==payload.sessionId)return ok({status:'unavailable',execution:execution('unknown',{dispatched:false})});
  if(entry.status==='stopped')return ok({status:'stopped',execution:entry.execution});
  if(settings.resultPending||entry.status==='pending')return ok({status:'pending',execution:execution('analyzing')});
  return ok({status:'completed',execution:execution('completed',{available:true}),result:entry.value});
 }
 if(endpoint==='check-update')return ok({...info(),latestVersion:'99.0.0',available:true,releaseUrl:'https://example.invalid/release'});
 if(endpoint==='discover')return ok({repositories:Array.from({length:settings.count},(_,i)=>({path:i?'project-'+i+'-'+('very-long-path-'.repeat(12)):'client',type:settings.mixed&&i===1?'svn':'git',branch:settings.mixed&&i===1?'trunk':'main'})),warnings:[],visited:settings.count+1});
 if(endpoint==='refs'){
  if(settings.holdRefs)await gate('refs');
  if(settings.refsAuthFailure&&payload.gitMode==='remote')return fail('Git 远端 '+(payload.gitRemote||'origin')+'：查询失败；SSH 公钥认证被拒绝；请确认当前仓库指定的密钥已在服务器授权，并可由 DSH 运行用户使用；未回退本地版本','code-report/git-remote',{diagnostic:'ssh-publickey'});
  return ok({refs:['main','release','refs/tags/v1.0']});
 }
 if(endpoint==='progress'){
  if(settings.progressFailure)throw new Error('fixture progress disconnected');
  const capture=captureTasks.get(payload.operationId);if(capture&&capture.sessionId===payload.sessionId)return ok({phase:capture.status==='pending'?'collecting':capture.status,completed:0,total:1,label:'fixture 正在采集'});
  const task=results.get(payload.operationId);
  if(task&&task.sessionId===payload.sessionId){
   const phase=task.status==='pending'?'analyzing':task.status;
   return ok({phase,completed:phase==='completed'?(settings.analysisBatches||1):0,total:settings.analysisBatches||1,label:'fixture '+phase});
  }
  return ok({phase:'collecting',completed:0,total:1,label:'fixture 正在处理'});
 }
 if(endpoint==='release-preview'){previews.delete(payload.previewId);return ok({released:true});}
 if(endpoint==='analysis-plan'){if(settings.singleRequest)settings.singleBudget=payload.inputBudget;return ok({analysisPlan:plan(),...plan()});}
 if(endpoint==='preview-start'){
  const prior=captureTasks.get(payload.operationId);if(prior)return prior.sessionId===payload.sessionId?ok({operationId:payload.operationId,status:prior.status}):fail('任务会话不匹配');
  if([...captureTasks.values()].some(task=>task.status==='pending'))return fail('采集仍在执行','code-report/busy');
  const request=structuredClone(payload.request),task={sessionId:payload.sessionId,status:'pending'};captureTasks.set(payload.operationId,task);
  // Backend work is intentionally detached from the short RPC request signal.
  task.work=(async()=>{if(settings.holdPreview)await gate('preview');await wait(settings.delayPreview);settledPreviews++;if(task.status==='stopped')return;
  if(settings.failPreview){task.status='stopped';task.error={code:'code-report/input',message:'fixture 采集失败'};return;}
  const previewId='preview-'+(++previewSequence);
  // Contract-only fixture data: no filesystem traversal or real exclusion checks occur here.
  const expanded=settings.directoryContextPreview;
  const context=expanded?structuredClone(expanded.context):[];
  const limitations=['模拟服务，不读取真实仓库',...(expanded?.limitations||[])];
  const value={defaultRoute:settings.noDefaultModel?null:{provider:'default-fixture',model:'default-mock'},previewId,expiresAt:Date.now()+settings.ttl,bytes:expanded?.bytes??100,repositories:request.repositories.map(row=>({...row,...(row.type==='git'?{gitSource:row.gitMode==='local'?'local':'remote',...(row.gitMode!=='local'?{remote:row.gitRemote||'origin',observedAt:'2026-11-03T10:00:00.000Z'}:{})}:{}),a:'a'.repeat(40),b:'b'.repeat(40),files:['api.ts']})),context,limitations,analysisPlan:plan(),markdown:'# 本地证据 '+payload.sessionId+' '+request.title+'\n未调用模型\n<script>window.fixtureInjected=true</script>'};
  previews.set(previewId,{sessionId:payload.sessionId,value});task.value=value;task.status='completed';})();
  if(settings.failPreviewStartResponse)throw new Error('fixture capture start response lost');return ok({operationId:payload.operationId,status:'pending'});
 }
 if(endpoint==='generate'){
  const preview=previews.get(payload.previewId);
  if(payload.sendToModel!==true)return fail('需要明确确认','code-report/input',{execution:execution('stopped',{dispatched:false})});
  if(!preview||preview.sessionId!==payload.sessionId||Date.now()>=preview.value.expiresAt)return fail('预览已过期','code-report/preview-expired',{execution:execution('stopped',{dispatched:false})});
  modelCalls++;results.set(payload.operationId,{sessionId:payload.sessionId,status:'pending'});
  const work=(async()=>{
   if(settings.holdGenerate)await gate('generate');
   await wait(settings.delayGenerate);
   settledGenerations++;
   if(settings.failGenerate){const proof=execution('stopped');results.set(payload.operationId,{sessionId:payload.sessionId,status:'stopped',execution:proof});return fail('fixture 模型失败','code-report/analysis-failed',{execution:proof});}
   const value={markdown:settings.richReport||('# 模型报告 '+payload.sessionId+'\n## 改动内容\n模型报告 '+payload.sessionId+'\n## 对外接口变更\n待确认\n<script>window.fixtureInjected=true</script>'),coverage:settings.singleRequest?singleCoverage():{total:settings.analysisBatches||1,completed:settings.analysisBatches||1,excluded:0}};
   results.set(payload.operationId,{sessionId:payload.sessionId,status:'completed',value});
   if(settings.failGenerateResponse)throw new Error('fixture response lost after generation');
   return ok(value);
  })();
  return modelTransport(work,signal);
 }
 return fail('未知模拟端点 '+endpoint);
}
window.fixture={configure(value){Object.assign(settings,value);},releasePreview:()=>release('preview'),releaseGenerate:()=>release('generate'),releaseInstall:()=>release('install'),releaseRefs:()=>release('refs'),getStats:()=>({calls:structuredClone(calls),modelCalls,installCalls,settledPreviews,settledGenerations,generateAborts,captureTasks:[...captureTasks.entries()].map(([operationId,task])=>({operationId,sessionId:task.sessionId,status:task.status}))}),switchSession:id=>switchSession(id),settings};
// Explicit host-theme simulation. This is not a screenshot of the live DSH GUI.
if(settings.theme){
 const dark=settings.theme==='dark',root=document.documentElement;
 root.dataset.theme=settings.theme;root.style.colorScheme=settings.theme;
 const colors=dark?{canvas:'#10141c',surface:'#171e29',raised:'#202938',text:'#edf2fa',secondary:'#b5c0d0',muted:'#a3aec0',border:'#3c495d'}:{canvas:'#f3f6fb',surface:'#ffffff',raised:'#edf2f9',text:'#172338',secondary:'#46566d',muted:'#52627a',border:'#c4cfdf'};
 document.body.style.background=colors.canvas;document.body.style.color=colors.text;
 for(const [token,key]of Object.entries({'bg-layer-1':'surface','bg-layer-2':'raised','bg-layer-3':'canvas','label-primary':'text','label-secondary':'secondary','label-tertiary':'muted','border-l3':'border'}))root.style.setProperty('--dsw-alias-'+token,colors[key]);
}
let entry;window.__ModuleLoader__={load(value){entry=value;}};
await new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='/client.js';script.onload=resolve;script.onerror=reject;document.head.append(script);});
const plugin=entry.factory(id=>{if(id!=='react')throw new Error('Unexpected external '+id);return React;});
let Page;
plugin.apply({connection:{rpc:{call:rpc}},remote:{pluginManager:{async installBundle(){installCalls++;if(settings.holdInstall)await gate('install');if(settings.failInstallResponse)throw new Error('fixture install response lost');return ok({application:'restart-required'});}}},slots:{inject(_name,fn){fn();},register(options,component){if(options.name==='main')Page=component;}}});
function App(){const [id,setId]=useState(settings.noSession?null:'a');switchSession=setId;return <><div aria-label="模拟宿主会话"><button onClick={()=>setId('a')}>测试会话 A</button><button onClick={()=>setId('b')}>测试会话 B</button><button onClick={()=>setId(null)}>关闭测试会话</button></div><Page useSessions={select=>select({byId:id?{[id]:sessions[id]}:{}})}/></>;}
createRoot(document.getElementById('root')).render(<App/>);
