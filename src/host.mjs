import {randomUUID} from 'node:crypto';
import {runtimeInfo,checkUpdate} from './updates.mjs';
import {collect,discover} from './collect.mjs';
import {analyze,markdown} from './report.mjs';
export async function sessionCwd(ctx,id,signal){
 if(typeof id!=='string'||!id||id.length>256||/[/\\\0]/.test(id))throw new Error('需要有效 Session');
 const header=ctx.sessions.get(id)?.header??(await ctx.sessionPersistence.stat(id,{signal}))?.header;
 if(!header?.cwd)throw new Error('当前会话工作区不可用');return header.cwd;
}
export function createHandler(ctx){
 const previews=new Map(),progress=new Map();let active=0;
 const prune=()=>{for(const [id,p]of previews)if(Date.now()-p.time>10*60*1000)previews.delete(id);};
 return async(endpoint,payload,signal)=>{
  if(endpoint==='runtime-info')return {ok:true,value:runtimeInfo()};
  if(endpoint==='check-update'){try{return {ok:true,value:await checkUpdate({signal})};}catch(e){return {ok:false,error:{message:e.message}};}}
  if(endpoint==='progress'){
   try{const cwd=await sessionCwd(ctx,payload?.sessionId,signal);const item=progress.get(payload?.operationId);if(!item||item.sessionId!==payload.sessionId||item.cwd!==cwd||Date.now()-item.updatedAt>600000)throw new Error('进度不可用');return {ok:true,value:item.value};}catch(e){return {ok:false,error:{message:e.message}};}
  }
  let operation;
  if(active>=2)return {ok:false,error:{message:'报告任务繁忙，请稍后重试'}};
  active++;
  try{
   signal=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(240000)]);signal.throwIfAborted();prune();
   if(!['discover','preview','generate'].includes(endpoint)||!payload||typeof payload!=='object')throw new Error('无效请求');
   const cwd=await sessionCwd(ctx,payload.sessionId,signal);let value;
   const update=value=>{if(operation){operation.value=value;operation.updatedAt=Date.now();}};
   if(payload.operationId!==undefined){
    if(typeof payload.operationId!=='string'||!/^[a-zA-Z0-9-]{1,100}$/.test(payload.operationId))throw new Error('无效任务标识');
    for(const [id,item]of progress)if(Date.now()-item.updatedAt>600000)progress.delete(id);
    if(progress.has(payload.operationId))throw new Error('任务标识重复');
    for(const [id,item]of progress){if(progress.size<64)break;if(['completed','failed','cancelled'].includes(item.value.phase))progress.delete(id);}
    if(progress.size>=64)throw new Error('活动任务进度缓存已满');
    operation={sessionId:payload.sessionId,cwd,updatedAt:Date.now(),value:{phase:'starting',label:'准备执行'}};progress.set(payload.operationId,operation);
   }
   if(endpoint==='discover')value=await discover(cwd,signal,payload.scan,update);
   if(endpoint==='preview'){
    if(previews.size>=16)throw new Error('预览数量达到上限，请等待过期');
    const snapshot=await collect(cwd,payload.request,signal,update);const previewId=randomUUID();
    if(await sessionCwd(ctx,payload.sessionId,signal)!==cwd)throw new Error('会话目录已变更');
    previews.set(previewId,{snapshot,cwd,sessionId:payload.sessionId,time:Date.now(),used:false});
    value={previewId,bytes:Buffer.byteLength(JSON.stringify(snapshot)),repositories:snapshot.repositories.map(({diff,...r})=>r),context:snapshot.context.map(({text,...c})=>c),limitations:snapshot.limitations,markdown:markdown(snapshot)};
   }
   if(endpoint==='generate'){
    const p=previews.get(payload.previewId);
    if(!p||p.used||p.cwd!==cwd||p.sessionId!==payload.sessionId)throw new Error('预览已过期、已使用或会话变更，请重新预览');
    if(payload.sendToModel!==true)throw new Error('需要明确确认向所选模型发送源码');
    p.used=true;update({phase:'analyzing',label:'正在分析改动、影响范围与 QA 建议（模型进度不可量化）'});
    try{const analysis=await analyze(ctx.llm,payload.route,p.snapshot,signal);if(await sessionCwd(ctx,payload.sessionId,signal)!==cwd)throw new Error('会话目录已变更');value={markdown:markdown(p.snapshot,analysis,payload.route)};previews.delete(payload.previewId);}catch(e){p.used=false;throw e;}
   }
   signal.throwIfAborted();update({phase:'completed',completed:1,total:1,label:'执行完成'});return {ok:true,value};
  }catch(e){if(operation){operation.value={phase:signal?.aborted?'cancelled':'failed',label:signal?.aborted?'执行已取消或超时':e.message};operation.updatedAt=Date.now();}return {ok:false,error:{message:e.message||'报告生成失败'}};}finally{active--;}
 };
}
