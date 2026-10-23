import {randomUUID} from 'node:crypto';
import {runtimeInfo,checkUpdate} from './updates.mjs';
import {collect,discover,listRefs} from './collect.mjs';
import {createAnalysisPlan,analyzeReport,markdown} from './report.mjs';

const REQUEST_TIMEOUT=240000,PREVIEW_TTL=10*60*1000,PROGRESS_TTL=10*60*1000;
const PREVIEW_LIMIT=16,PREVIEW_BYTES=32*1024*1024,PROGRESS_LIMIT=64,ACTIVE_LIMIT=2;
const TERMINAL_PHASES=['completed','failed','cancelled'];
const endpointNames=['discover','preview','generate','analysis-plan','refs'];

function problem(code,message,details={}){
  return Object.assign(new Error(message),{code:'code-report/'+code,details});
}
function failure(error){
  return {ok:false,error:{code:typeof error?.code==='string'&&error.code.startsWith('code-report/')?error.code:'code-report/request-failed',message:error?.message||'报告请求失败',details:error?.details&&typeof error.details==='object'?error.details:{}}};
}
const respond=async body=>{try{return {ok:true,value:await body()};}catch(error){return failure(error);}};
export async function sessionCwd(ctx,id,signal){
  if(typeof id!=='string'||!id||id.length>256||id.includes('/')||id.includes(String.fromCharCode(92))||id.includes(String.fromCharCode(0)))throw problem('input','需要有效 Session');
  signal?.throwIfAborted();
  const header=ctx.sessions.get(id)?.header??(await ctx.sessionPersistence?.stat(id,{signal}))?.header;
  if(!header?.cwd)throw problem('session-unavailable','当前会话工作区不可用');
  signal?.throwIfAborted();
  return header.cwd;
}
function createPreviewStore(ctx,now){
  const items=new Map();
  const prune=()=>{for(const [id,p]of items)if(!p.used&&now()-p.time>=PREVIEW_TTL)items.delete(id);};
  const claim=(payload,cwd)=>{
    const p=items.get(payload.previewId);
    if(!p||p.cwd!==cwd||p.sessionId!==payload.sessionId)throw problem('preview-expired','预览已过期、已使用或会话变更，请重新采集');
    if(p.used)throw problem('busy','预览正在分析，请等待完成或取消');
    if(now()-p.time>=PREVIEW_TTL){items.delete(payload.previewId);throw problem('preview-expired','预览已过期，请重新采集');}
    return p;
  };
  const release=async(payload,signal)=>{
    const cwd=await sessionCwd(ctx,payload?.sessionId,signal),p=items.get(payload?.previewId);
    if(p&&(p.sessionId!==payload.sessionId||p.cwd!==cwd||p.used))throw problem('busy','预览不属于当前会话或正在分析');
    if(p)items.delete(payload.previewId);
    return {released:!!p};
  };
  const add=(id,entry)=>{
    const size=()=>[...items.values()].reduce((sum,p)=>sum+p.bytes,0);
    while(items.size>=PREVIEW_LIMIT||size()+entry.bytes>PREVIEW_BYTES){
      const oldest=[...items].find(([,p])=>!p.used);
      if(!oldest)throw problem('busy','预览缓存已满，请稍后重试');
      items.delete(oldest[0]);
    }
    items.set(id,entry);
  };
  return {prune,claim,release,add,discard:id=>items.delete(id)};
}
function createProgressStore(ctx,now){
  const items=new Map(),expired=item=>now()-item.updatedAt>PROGRESS_TTL;
  const begin=(id,sessionId,cwd)=>{
    if(typeof id!=='string'||!/^[a-zA-Z0-9-]{1,100}$/.test(id))throw problem('input','无效任务标识');
    for(const [key,item]of items)if(expired(item))items.delete(key);
    if(items.has(id))throw problem('input','任务标识重复');
    for(const [key,item]of items){if(items.size<PROGRESS_LIMIT)break;if(TERMINAL_PHASES.includes(item.value.phase))items.delete(key);}
    if(items.size>=PROGRESS_LIMIT)throw problem('busy','活动任务进度缓存已满');
    const operation={sessionId,cwd,updatedAt:now(),value:{phase:'starting',label:'准备执行'}};
    items.set(id,operation);return operation;
  };
  const update=(item,value)=>{if(item){item.value=value;item.updatedAt=now();}};
  const finish=(item,result)=>{
    if(!item)return;
    const bytes=Buffer.byteLength(JSON.stringify(result));
    // Retain bounded paid results for a lost response; evict oldest retained bodies only.
    const retained=()=>[...items.values()].reduce((sum,value)=>sum+(value.resultBytes||0),0);
    for(const value of items.values()){
      if(retained()+bytes<=PREVIEW_BYTES)break;
      if(value.result){delete value.result;delete value.resultBytes;}
    }
    if(bytes<=PREVIEW_BYTES){item.result=result;item.resultBytes=bytes;}
    update(item,{phase:'completed',completed:1,total:1,label:'报告完成，可只读恢复'});
  };
  const result=async(payload,signal)=>{
    const cwd=await sessionCwd(ctx,payload?.sessionId,signal),item=items.get(payload?.operationId);
    if(!item||item.sessionId!==payload.sessionId||item.cwd!==cwd||expired(item))throw problem('result-unavailable','已完成报告不在缓存中，请勿将未知状态当作可安全重试');
    if(item.result)return {status:'completed',result:item.result};
    if(item.value.phase==='completed')throw problem('result-unavailable','报告正文已被缓存淘汰；任务曾完成，不能据此假定可以免费重试');
    return {status:TERMINAL_PHASES.includes(item.value.phase)?'failed':'pending',phase:item.value.phase};
  };
  const read=async(payload,signal)=>{
    const cwd=await sessionCwd(ctx,payload?.sessionId,signal),item=items.get(payload?.operationId);
    if(!item||item.sessionId!==payload.sessionId||item.cwd!==cwd||expired(item))throw problem('progress-unavailable','进度不可用');
    return item.value;
  };
  return {begin,update,read,finish,result};
}
function publicPlan(plan){
  if(!plan)return null;
  return {id:plan.id,inputBudget:plan.inputBudget,estimated:plan.estimated,batches:plan.batches.map(({id,evidenceIds,inputBytes})=>({id,evidenceIds,inputBytes})),coverage:plan.coverage};
}
function routeKey(route){
  if(!route||typeof route.provider!=='string'||!route.provider.trim()||route.provider.length>200||typeof route.model!=='string'||!route.model.trim()||route.model.length>200)throw problem('input','请填写 DSH 已配置的提供方与模型 ID');
  return JSON.stringify([route.provider,route.model]);
}

// Dependencies are trusted in-process test seams, never fields accepted over RPC.
export function createHandler(ctx,{capture=collect,scan=discover,refs=listRefs,plan=createAnalysisPlan,analyze=analyzeReport,now=()=>Date.now()}={}){
  const previews=createPreviewStore(ctx,now),progress=createProgressStore(ctx,now);let active=0;
  const assertSession=async(payload,cwd,signal)=>{if(await sessionCwd(ctx,payload.sessionId,signal)!==cwd)throw problem('session-changed','会话目录已变更');};
  const endpoints={
    discover:({payload,cwd,signal,update})=>scan(cwd,signal,payload.scan,update),
    refs:async({payload,cwd,signal})=>({refs:await refs(cwd,payload.repositoryPath,signal)}),
    preview:async({payload,cwd,signal,update})=>{
      const snapshot=await capture(cwd,payload.request,signal,update);
      await assertSession(payload,cwd,signal);signal.throwIfAborted();
      const previewId=randomUUID(),time=now(),bytes=Buffer.byteLength(JSON.stringify(snapshot));let analysisPlan=null,planError=null;
      try{analysisPlan=plan(snapshot);}catch(error){planError={code:'code-report/plan-invalid',message:error.message};}
      previews.add(previewId,{snapshot,cwd,sessionId:payload.sessionId,time,bytes,used:false,plan:analysisPlan,completed:new Map(),routeKey:null});
      return {previewId,expiresAt:time+PREVIEW_TTL,bytes,repositories:snapshot.repositories.map(({diff,...r})=>r),context:snapshot.context.map(({text,...c})=>c),limitations:snapshot.limitations,markdown:markdown(snapshot),analysisPlan:publicPlan(analysisPlan),planError};
    },
    'analysis-plan':async({payload,cwd,signal})=>{
      const p=previews.claim(payload,cwd);signal.throwIfAborted();
      if(!Number.isInteger(payload.inputBudget)||payload.inputBudget<4000||payload.inputBudget>64000)throw problem('input','输入预算应为 4000–64000 字节；这是保守估算，不是 token 数');
      const next=plan(p.snapshot,{inputBudget:payload.inputBudget});
      p.plan=next;p.completed=new Map();p.routeKey=null;
      return {analysisPlan:publicPlan(next),expiresAt:p.time+PREVIEW_TTL};
    },
    generate:async({payload,cwd,signal,update,operation})=>{
      const p=previews.claim(payload,cwd);
      if(payload.sendToModel!==true)throw problem('consent-required','需要明确确认向所选模型发送源码');
      if(!p.plan||payload.planId!==p.plan.id)throw problem('plan-mismatch','分析计划已变化或不可用，请重新确认发送范围');
      const key=routeKey(payload.route);
      if(p.routeKey!==key){p.completed=new Map();p.routeKey=key;}
      signal.throwIfAborted();p.used=true;
      // Recheck authority before every model dispatch, not only before the first batch.
      let dispatched=false;
      const llm={async *stream(input){
        await assertSession(payload,cwd,signal);signal.throwIfAborted();
        if(!dispatched&&now()-p.time>=PREVIEW_TTL)throw problem('preview-expired','预览已过期，请重新采集');
        dispatched=true;yield* ctx.llm.stream(input);
      }};
      update({phase:'analyzing',label:'正在分析固定快照；分片内部进度不可量化',completed:p.completed.size,total:p.plan.batches.length});
      try{
        const result=await analyze(llm,payload.route,p.snapshot,{signal,plan:p.plan,completed:p.completed,onProgress:update});
        if(result.completed instanceof Map)p.completed=result.completed;
        await assertSession(payload,cwd,signal);signal.throwIfAborted();
        const value={markdown:markdown(p.snapshot,result.markdown,payload.route),coverage:result.coverage};
        progress.finish(operation,value);previews.discard(payload.previewId);return value;
      }catch(error){
        if(error.completed instanceof Map)p.completed=error.completed;
        if(!error.code)error.code='code-report/analysis-incomplete';
        error.details={...error.details,coverage:error.coverage,completedBatches:p.completed.size,remainingBatches:p.plan.batches.length-p.completed.size,requiresConfirmation:true};
        throw error;
      }finally{p.used=false;}
    }
  };
  return async(endpoint,payload,signal)=>{
    if(endpoint==='runtime-info')return respond(runtimeInfo);
    if(endpoint==='check-update')return respond(()=>checkUpdate({signal}));
    if(endpoint==='release-preview')return respond(()=>previews.release(payload,signal));
    if(endpoint==='progress')return respond(()=>progress.read(payload,signal));
    if(endpoint==='result')return respond(()=>progress.result(payload,signal));
    if(active>=ACTIVE_LIMIT)return failure(problem('busy','报告任务繁忙，请稍后重试'));
    active++;let operation;
    try{
      signal=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(REQUEST_TIMEOUT)]);signal.throwIfAborted();previews.prune();
      if(!endpointNames.includes(endpoint)||!payload||typeof payload!=='object')throw problem('input','无效请求');
      const cwd=await sessionCwd(ctx,payload.sessionId,signal);signal.throwIfAborted();
      if(payload.operationId!==undefined)operation=progress.begin(payload.operationId,payload.sessionId,cwd);
      const update=value=>progress.update(operation,value);
      const value=await endpoints[endpoint]({payload,cwd,signal,update,operation});
      signal.throwIfAborted();update({phase:'completed',completed:1,total:1,label:'执行完成'});return {ok:true,value};
    }catch(error){
      if(signal?.aborted){error=problem(signal.reason?.name==='TimeoutError'?'timeout':'cancelled','执行已取消或超时',error.details||{});}
      progress.update(operation,{phase:signal?.aborted?'cancelled':'failed',label:error.message});return failure(error);
    }finally{active--;}
  };
}
