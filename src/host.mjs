import {randomUUID} from 'node:crypto';
import {runtimeInfo,checkUpdate} from './updates.mjs';
import {collect,discover} from './collect.mjs';
import {analyze,markdown} from './report.mjs';
const REQUEST_TIMEOUT=240000,PREVIEW_TTL=10*60*1000,PROGRESS_TTL=10*60*1000,PREVIEW_LIMIT=16,PROGRESS_LIMIT=64,ACTIVE_LIMIT=2;
const REPORT_ENDPOINTS=['discover','preview','generate'],TERMINAL_PHASES=['completed','failed','cancelled'];
const failure=message=>({ok:false,error:{message}});
const respond=async body=>{try{return {ok:true,value:await body()};}catch(e){return failure(e.message);}};
export async function sessionCwd(ctx,id,signal){
 if(typeof id!=='string'||!id||id.length>256||/[/\\\0]/.test(id))throw new Error('需要有效 Session');
 const header=ctx.sessions.get(id)?.header??(await ctx.sessionPersistence.stat(id,{signal}))?.header;
 if(!header?.cwd)throw new Error('当前会话工作区不可用');return header.cwd;
}
function createPreviewStore(ctx){
 const items=new Map();
 const prune=()=>{for(const [id,p]of items)if(!p.used&&Date.now()-p.time>PREVIEW_TTL)items.delete(id);};
 const release=async(payload,signal)=>{const cwd=await sessionCwd(ctx,payload?.sessionId,signal);const p=items.get(payload?.previewId);if(p&&(p.sessionId!==payload.sessionId||p.cwd!==cwd||p.used))throw new Error('预览不属于当前会话或正在分析');if(p)items.delete(payload.previewId);return {released:!!p};};
 const claim=(payload,cwd)=>{const p=items.get(payload.previewId);if(!p||p.used||p.cwd!==cwd||p.sessionId!==payload.sessionId)throw new Error('预览已过期、已使用或会话变更，请重新预览');if(Date.now()-p.time>=PREVIEW_TTL){items.delete(payload.previewId);throw new Error('预览已过期，请重新采集');}return p;};
 const add=(previewId,entry)=>{while(items.size>=PREVIEW_LIMIT){const oldest=[...items].find(([,p])=>!p.used);if(!oldest)throw new Error('预览均在分析中，请稍后重试');items.delete(oldest[0]);}items.set(previewId,entry);};
 const use=p=>{p.used=true;};
 const abandon=p=>{p.used=false;};
 const discard=previewId=>{items.delete(previewId);};
 return {prune,release,claim,add,use,abandon,discard};
}
function createProgressStore(ctx){
 const items=new Map();
 const expired=item=>Date.now()-item.updatedAt>PROGRESS_TTL;
 const prune=()=>{for(const [id,item]of items)if(expired(item))items.delete(id);};
 const evictTerminal=()=>{for(const [id,item]of items){if(items.size<PROGRESS_LIMIT)break;if(TERMINAL_PHASES.includes(item.value.phase))items.delete(id);}};
 const begin=(operationId,sessionId,cwd)=>{
  if(typeof operationId!=='string'||!/^[a-zA-Z0-9-]{1,100}$/.test(operationId))throw new Error('无效任务标识');
  prune();
  if(items.has(operationId))throw new Error('任务标识重复');
  evictTerminal();
  if(items.size>=PROGRESS_LIMIT)throw new Error('活动任务进度缓存已满');
  const operation={sessionId,cwd,updatedAt:Date.now(),value:{phase:'starting',label:'准备执行'}};items.set(operationId,operation);return operation;
 };
 const read=async(payload,signal)=>{const cwd=await sessionCwd(ctx,payload?.sessionId,signal);const item=items.get(payload?.operationId);if(!item||item.sessionId!==payload.sessionId||item.cwd!==cwd||expired(item))throw new Error('进度不可用');return item.value;};
 const update=(operation,value)=>{if(!operation)return;operation.value=value;operation.updatedAt=Date.now();};
 const fail=(operation,error,signal)=>{if(!operation)return;const aborted=signal?.aborted;operation.value={phase:aborted?'cancelled':'failed',label:aborted?'执行已取消或超时':error.message};operation.updatedAt=Date.now();};
 return {begin,read,update,fail};
}
export function createHandler(ctx){
 const previews=createPreviewStore(ctx),progress=createProgressStore(ctx);let active=0;
 const runDiscover=async({payload,cwd,signal,update})=>discover(cwd,signal,payload.scan,update);
 const runPreview=async({payload,cwd,signal,update})=>{
  const snapshot=await collect(cwd,payload.request,signal,update);const previewId=randomUUID();
  if(await sessionCwd(ctx,payload.sessionId,signal)!==cwd)throw new Error('会话目录已变更');
  const evidence=markdown(snapshot);
  // Capacity is checked after collection so concurrent captures cannot overflow it.
  previews.add(previewId,{snapshot,cwd,sessionId:payload.sessionId,time:Date.now(),used:false});
  return {previewId,bytes:Buffer.byteLength(JSON.stringify(snapshot)),repositories:snapshot.repositories.map(({diff,...r})=>r),context:snapshot.context.map(({text,...c})=>c),limitations:snapshot.limitations,markdown:evidence};
 };
 const runGenerate=async({payload,cwd,signal,update})=>{
  const p=previews.claim(payload,cwd);
  if(payload.sendToModel!==true)throw new Error('需要明确确认向所选模型发送源码');
  signal.throwIfAborted();previews.use(p);update({phase:'analyzing',label:'正在分析改动、影响范围与 QA 建议（模型进度不可量化）'});
  try{const analysis=await analyze(ctx.llm,payload.route,p.snapshot,signal);if(await sessionCwd(ctx,payload.sessionId,signal)!==cwd)throw new Error('会话目录已变更');const value={markdown:markdown(p.snapshot,analysis,payload.route)};previews.discard(payload.previewId);return value;}catch(e){previews.abandon(p);throw e;}
 };
 const endpoints={discover:runDiscover,preview:runPreview,generate:runGenerate};
 const handle=async(endpoint,payload,signal)=>{
  if(endpoint==='runtime-info')return respond(runtimeInfo);
  if(endpoint==='check-update')return respond(()=>checkUpdate({signal}));
  if(endpoint==='release-preview')return respond(()=>previews.release(payload,signal));
  if(endpoint==='progress')return respond(()=>progress.read(payload,signal));
  if(active>=ACTIVE_LIMIT)return {ok:false,error:{message:'报告任务繁忙，请稍后重试'}};
  active++;let operation;
  try{
   signal=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(REQUEST_TIMEOUT)]);signal.throwIfAborted();previews.prune();
   if(!REPORT_ENDPOINTS.includes(endpoint)||!payload||typeof payload!=='object')throw new Error('无效请求');
   const cwd=await sessionCwd(ctx,payload.sessionId,signal);signal.throwIfAborted();
   if(payload.operationId!==undefined)operation=progress.begin(payload.operationId,payload.sessionId,cwd);
   const update=value=>progress.update(operation,value);
   const value=await endpoints[endpoint]({payload,cwd,signal,update});
   signal.throwIfAborted();update({phase:'completed',completed:1,total:1,label:'执行完成'});return {ok:true,value};
  }catch(e){progress.fail(operation,e,signal);return failure(e.message||'报告生成失败');}finally{active--;}
 };
 // Every failure must satisfy the Host Connection wire contract, including early exits.
 return async(...args)=>{
  try{
   const result=await handle(...args);
   if(result.ok)return result;
   return {ok:false,error:{code:'code-report/request-failed',message:result.error?.message||'报告请求失败',details:{}}};
  }catch(error){
   return {ok:false,error:{code:'code-report/internal',message:error?.message||'报告请求失败',details:{}}};
  }
 };
}
