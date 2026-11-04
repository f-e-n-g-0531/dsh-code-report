import {randomUUID,createHash} from 'node:crypto';
import {snapshotJsonBytes} from './snapshot-json.mjs';
import {runtimeInfo,checkUpdate} from './updates.mjs';
import {collect,discover,listRefs} from './collect.mjs';
import {createAnalysisPlan,analyzeReport,markdown} from './report.mjs';

const PREVIEW_TTL=10*60*1000,PROGRESS_TTL=10*60*1000;
const PREVIEW_LIMIT=16,PROGRESS_LIMIT=64,ACTIVE_LIMIT=2;
const TERMINAL_PHASES=['completed','stopped'];
const PAID_ID_LIMIT=1024;
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
    // Bound retained snapshots by count, not by the size of one legitimate release.
    while(items.size>=PREVIEW_LIMIT){
      const oldest=[...items].find(([,p])=>!p.used);
      if(!oldest)throw problem('busy','预览缓存已满，请稍后重试');
      items.delete(oldest[0]);
    }
    items.set(id,entry);
  };
  return {prune,claim,release,add,discard:id=>items.delete(id)};
}
function createProgressStore(ctx,now,backendInstanceId){
  const items=new Map(),paidIds=new Map();
  const terminal=item=>TERMINAL_PHASES.includes(item.value.phase);
  const expired=item=>terminal(item)&&now()-item.updatedAt>PROGRESS_TTL;
  const execution=item=>({backendInstanceId,dispatch:item.dispatchCount?'dispatched':'not-dispatched',dispatchCount:item.dispatchCount,completedBatches:item.completedBatches,totalBatches:item.totalBatches,resultAvailability:item.result?'available':'unavailable',phase:terminal(item)?item.value.phase:'pending'});
  const begin=(id,sessionId,cwd,endpoint,fingerprint)=>{
    if(typeof id!=='string'||!/^[a-zA-Z0-9-]{1,100}$/.test(id))throw problem('input','无效任务标识');
    for(const [key,item]of items)if(expired(item))items.delete(key);
    const prior=items.get(id),known=paidIds.get(id);
    if(prior||known){
      const owner=prior||known;
      if(owner.sessionId!==sessionId||owner.cwd!==cwd||owner.endpoint!==endpoint||owner.fingerprint!==fingerprint)throw problem('operation-conflict','任务标识已绑定其他请求，禁止重复发送');
      if(prior?.result)return {operation:prior,replay:prior.result};
      throw problem('operation-exists','此任务标识已使用，请只读核对结果；禁止重新派发',{...(prior?{execution:execution(prior)}:{backendInstanceId})});
    }
    for(const [key,item]of items){if(items.size<PROGRESS_LIMIT)break;if(terminal(item))items.delete(key);}
    if(items.size>=PROGRESS_LIMIT)throw problem('busy','活动任务进度缓存已满');
    const operation={id,sessionId,cwd,endpoint,fingerprint,dispatchCount:0,completedBatches:0,totalBatches:0,updatedAt:now(),value:{phase:'starting',label:'准备执行'}};
    items.set(id,operation);
    return {operation};
  };
  const authorize=item=>{
    if(!item)return;
    if(paidIds.size>=PAID_ID_LIMIT)throw problem('busy','本后台实例的付费任务身份容量已满，下载不会释放身份名额。请先恢复并下载全部所需报告，再有计划地重载后台；重载将丢失内存报告，不会自动继续任务');
    paidIds.set(item.id,{sessionId:item.sessionId,cwd:item.cwd,endpoint:item.endpoint,fingerprint:item.fingerprint});
  };
  const update=(item,value)=>{if(item&&!terminal(item)){item.value=value;item.updatedAt=now();if(Number.isInteger(value.completed))item.completedBatches=value.completed;if(Number.isInteger(value.total))item.totalBatches=value.total;}};
  const finish=(item,result)=>{
    if(!item)return;
    // Result lifetime follows terminal metadata TTL/count. Large reports must remain
    // recoverable too; do not silently drop a paid result at a fixed byte threshold.
    item.result=result;
    item.value={phase:'completed',completed:item.completedBatches,total:item.totalBatches,label:'报告完成，可只读恢复'};item.updatedAt=now();
  };
  const stop=(item,error)=>{
    if(!item||terminal(item))return;
    item.error={code:error.code||'code-report/request-failed',message:String(error.message||'任务已停止').slice(0,1200)};
    item.value={phase:'stopped',label:item.error.message};item.updatedAt=now();
  };
  const owned=async(payload,signal,code)=>{
    const cwd=await sessionCwd(ctx,payload?.sessionId,signal),item=items.get(payload?.operationId);
    if(!item||item.sessionId!==payload.sessionId||item.cwd!==cwd||expired(item))throw problem(code,'任务记录已过期、不可用或归属变化；不能据此假定未执行或可免费重试',{backendInstanceId});
    return item;
  };
  const result=async(payload,signal)=>{
    const item=await owned(payload,signal,'result-unavailable'),facts=execution(item);
    if(item.result)return {status:'completed',result:item.result,execution:facts};
    if(item.value.phase==='completed')return {status:'unavailable',phase:'completed',execution:facts};
    if(item.value.phase==='stopped')return {status:'stopped',phase:'stopped',error:item.error,execution:facts};
    return {status:'pending',phase:item.value.phase,execution:facts};
  };
  const read=async(payload,signal)=>{const item=await owned(payload,signal,'progress-unavailable');return {...item.value,execution:execution(item)};};
  return {begin,authorize,update,read,finish,stop,result,execution};
}
function publicPlan(plan){
  if(!plan)return null;
  return {id:plan.id,strategy:plan.strategy,mode:plan.mode,formatVersion:plan.formatVersion,evidenceVersion:plan.evidenceVersion,inputBudget:plan.inputBudget,estimated:plan.estimated,batches:plan.batches.map(({id,evidenceIds,inputBytes})=>({id,evidenceIds,inputBytes})),coverage:plan.coverage};
}
function routeKey(route){
  if(!route||typeof route.provider!=='string'||!route.provider.trim()||route.provider.length>200||typeof route.model!=='string'||!route.model.trim()||route.model.length>200)throw problem('input','请填写 DSH 已配置的提供方与模型 ID');
  return JSON.stringify([route.provider,route.model]);
}

// Dependencies are trusted in-process test seams, never fields accepted over RPC.
const defaultAnalysisPlan=(snapshot,options={})=>createAnalysisPlan(snapshot,{inputBudget:64000,...options,strategy:'single-request'});
function localManifest(snapshot){
 const files=snapshot.repositories.flatMap(r=>r.files.map(path=>({repository:r.path,path,status:'unknown',sentMetadata:false,sentText:false})));
 return {strategy:'single-request',originalSourceBytes:snapshot.repositories.reduce((n,r)=>n+Buffer.byteLength(r.diff),0)+snapshot.context.reduce((n,c)=>n+Buffer.byteLength(c.text),0),fullManifestFiles:files.length,files};
}
export function createHandler(ctx,{capture=collect,scan=discover,refs=listRefs,plan=defaultAnalysisPlan,analyze=analyzeReport,now=()=>Date.now()}={}){
  const backendInstanceId=randomUUID();
  const previews=createPreviewStore(ctx,now),progress=createProgressStore(ctx,now,backendInstanceId);let active=0;
  const assertSession=async(payload,cwd,signal)=>{if(await sessionCwd(ctx,payload.sessionId,signal)!==cwd)throw problem('session-changed','会话目录已变更');};
  const endpoints={
    discover:({payload,cwd,signal,update})=>scan(cwd,signal,payload.scan,update),
    refs:async({payload,cwd,signal})=>({refs:await refs(cwd,payload.repositoryPath,signal,{gitMode:payload.gitMode,gitRemote:payload.gitRemote})}),
    preview:async({payload,cwd,signal,update})=>{
      const snapshot=await capture(cwd,payload.request,signal,update);
      await assertSession(payload,cwd,signal);signal.throwIfAborted();
      const previewId=randomUUID(),time=now(),bytes=snapshotJsonBytes(snapshot);let analysisPlan=null,planError=null;
      try{analysisPlan=plan(snapshot);}catch(error){planError={code:'code-report/plan-invalid',message:error.message};}
      previews.add(previewId,{snapshot,cwd,sessionId:payload.sessionId,time,bytes,used:false,plan:analysisPlan,completed:new Map(),routeKey:null});
      return {previewId,expiresAt:time+PREVIEW_TTL,bytes,repositories:snapshot.repositories.map(({diff,...r})=>r),context:snapshot.context.map(({text,...c})=>c),limitations:snapshot.limitations,markdown:markdown(snapshot,null,null,{evidenceManifest:analysisPlan?.strategy==='single-request'?analysisPlan.coverage:plan===defaultAnalysisPlan?localManifest(snapshot):null}),analysisPlan:publicPlan(analysisPlan),planError};
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
      signal.throwIfAborted();progress.authorize(operation);p.used=true;
      // Recheck authority before every model dispatch, not only before the first batch.
      let dispatched=false;
      const llm={async *stream(input){
        await assertSession(payload,cwd,signal);signal.throwIfAborted();
        if(!dispatched&&now()-p.time>=PREVIEW_TTL)throw problem('preview-expired','预览已过期，请重新采集');
        if(p.plan.strategy==='single-request'&&dispatched)throw problem('analysis-plan','单次摘要禁止隐式第二次模型请求；失败后须重新明确确认');
        dispatched=true;if(operation)operation.dispatchCount++;yield* ctx.llm.stream(input);
      }};
      update({phase:'analyzing',label:'正在分析固定快照；分片内部进度不可量化',completed:p.completed.size,total:p.plan.batches.length});
      try{
        const result=await analyze(llm,payload.route,p.snapshot,{signal,plan:p.plan,completed:p.completed,onProgress:update});
        if(result.completed instanceof Map)p.completed=result.completed;
        // Completed validated analysis is a server fact, separate from cancelled delivery.
        // Still recheck authoritative ownership without borrowing the delivery signal.
        await assertSession(payload,cwd,AbortSignal.timeout(15000));
        if(operation){operation.completedBatches=p.completed.size;operation.totalBatches=p.plan.batches.length;}
        const value={markdown:markdown(p.snapshot,result.markdown,payload.route,{structured:true,evidenceManifest:p.plan.strategy==='single-request'?p.plan.coverage:null}),coverage:result.coverage};
        progress.finish(operation,value);previews.discard(payload.previewId);return value;
      }catch(error){
        if(error.completed instanceof Map)p.completed=error.completed;
        if(operation){operation.completedBatches=p.completed.size;operation.totalBatches=p.plan.batches.length;}
        if(!error.code)error.code='code-report/analysis-incomplete';
        error.details={...error.details,coverage:error.coverage,completedBatches:p.completed.size,remainingBatches:p.plan.batches.length-p.completed.size,requiresConfirmation:true};
        throw error;
      }finally{p.used=false;}
    }
  };
  return async(endpoint,payload,signal)=>{
    if(endpoint==='runtime-info')return respond(()=>({...runtimeInfo(),backendInstanceId}));
    if(endpoint==='check-update')return respond(()=>checkUpdate({signal}));
    if(endpoint==='release-preview')return respond(()=>previews.release(payload,signal));
    if(endpoint==='progress')return respond(()=>progress.read(payload,signal));
    if(endpoint==='result')return respond(()=>progress.result(payload,signal));
    active++;let operation;
    try{
      // Large collections and many model batches have no arbitrary request deadline.
      // Caller cancellation remains authoritative (except validated delivery completion).
      signal=signal||new AbortController().signal;signal.throwIfAborted();previews.prune();
      if(!endpointNames.includes(endpoint)||!payload||typeof payload!=='object')throw problem('input','无效请求');
      const cwd=await sessionCwd(ctx,payload.sessionId,signal);signal.throwIfAborted();
      if(payload.operationId!==undefined||endpoint==='generate'){
        const fingerprint=createHash('sha256').update(JSON.stringify([endpoint,payload.previewId,payload.planId,payload.route?.provider,payload.route?.model,payload.sendToModel])).digest('hex');
        const started=progress.begin(payload.operationId,payload.sessionId,cwd,endpoint,fingerprint);
        if(started.replay)return {ok:true,value:started.replay};
        operation=started.operation;
      }
      if(active>ACTIVE_LIMIT)throw problem('busy','报告任务繁忙，请稍后重试');
      const update=value=>progress.update(operation,value);
      const value=await endpoints[endpoint]({payload,cwd,signal,update,operation});
      if(operation?.value.phase!=='completed')signal.throwIfAborted();
      update({phase:'completed',completed:1,total:1,label:'执行完成'});return {ok:true,value};
    }catch(error){
      if(signal?.aborted){error=problem(signal.reason?.name==='TimeoutError'?'timeout':'cancelled','执行已取消或超时',error.details||{});}
      progress.stop(operation,error);
      if(operation)error.details={...error.details,execution:progress.execution(operation)};
      return failure(error);
    }finally{active--;}
  };
}
