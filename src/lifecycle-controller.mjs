import {resultKey,readCompletedResult} from './result-state.mjs';

const READ_TIMEOUT=5000;
const POLL_FAILURE_LIMIT=4;
const SAVE_POLL_LIMIT=20*60*1000;
const identity=operation=>({sessionId:operation.session.id,operationId:operation.operationId});
async function bounded(signal,call){
 signal.throwIfAborted();
 let abort;
 try{
  const interrupted=new Promise((_,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});});
  return await Promise.race([interrupted,call()]);
 }finally{signal.removeEventListener('abort',abort);}
}
function delay(ms,signal){
 return new Promise((resolve,reject)=>{
  signal?.throwIfAborted();
  const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},ms);
  const abort=()=>{clearTimeout(timer);reject(signal.reason);};
  signal?.addEventListener('abort',abort,{once:true});
 });
}

// One controller per apply() invocation, not a cross-tab or cross-reload lock.
export function createLifecycleController({rpc,results,randomId=()=>crypto.randomUUID(),pollIntervalMs=500}={}){
 const listeners=new Set();
 let lease=null,paid=null,revision=0,lastCompleted=null,lastFailure=null,lastSavedReport=null;
 let snapshot={revision,lease:null,paid:null,lastCompleted:null,lastFailure:null,lastSavedReport:null};
 const publish=()=>{
  snapshot={revision:++revision,lease:lease?{kind:lease.kind,label:lease.label,sessionKey:lease.sessionKey}:null,
   paid:paid?{operationId:paid.operationId,sessionKey:paid.sessionKey,session:paid.session,status:paid.status,message:paid.message,forceRequested:paid.forceRequested===true,forceCancelling:paid.forceCancelling===true,asyncGenerate:paid.asyncGenerate,progress:paid.progress,progressWarning:paid.progressWarning}:null,lastCompleted,lastFailure,lastSavedReport};
  for(const listener of listeners){try{listener(snapshot);}catch{/* A detached view cannot affect ownership. */}}
 };
 function acquire(kind,label,session){
  if(lease)throw new Error('当前插件实例存在执行中或结果未知的任务，请先核对；不能重复提交。');
  const token={kind,label,sessionKey:session?resultKey(session):null};lease=token;publish();
  return {release(){if(lease===token){lease=null;publish();}},token};
 }
 function assertBackend(operation,execution){
  if(operation.backendInstanceId&&execution?.backendInstanceId!==operation.backendInstanceId)throw new Error('后台实例已变化或任务来源无法确认；不会重新发送。');
 }
 function readResult(operation,signal){
  return bounded(signal,()=>readCompletedResult(rpc,operation.session.id,operation.operationId,signal));
 }
 function readProgress(operation,signal){
  return bounded(signal,()=>rpc('progress',identity(operation),signal));
 }
 async function watchSave(operation){
  const deadline=Date.now()+SAVE_POLL_LIMIT;
  let failures=0,savedReport;
  while(Date.now()<deadline){
   await delay(pollIntervalMs);
   try{
    const progress=await readProgress(operation,AbortSignal.timeout(READ_TIMEOUT));
    assertBackend(operation,progress?.execution);
    failures=0;
    if(['saved','failed'].includes(progress?.savedReport?.status)){savedReport=progress.savedReport;break;}
    if(progress?.savedReport?.status!=='pending')break;
   }catch{if(++failures>=POLL_FAILURE_LIMIT)break;}
  }
  // Unknown disk status does not imply failure or make model retransmission safe.
  savedReport??={status:'unknown',message:'报告已生成，暂无法确认工作区保存状态；可下载报告，不要重新生成。'};
  if(results.updateSavedReport(operation.session,operation.operationId,savedReport)){
   lastSavedReport={sessionKey:operation.sessionKey,session:operation.session,operationId:operation.operationId,savedReport};publish();
  }
 }
 function finishCompleted(operation,value){
  if(paid!==operation)return;
  results.set(operation.session,{markdown:value.markdown,coverage:value.coverage,...(value.savedReport?{savedReport:value.savedReport}:{}),stale:false,kind:'analysis',operationId:operation.operationId});
  results.setRecovery(operation.session,null);
  paid=null;lease=null;lastFailure=null;
  lastCompleted={sessionKey:operation.sessionKey,session:operation.session,operationId:operation.operationId};publish();
  if(operation.asyncGenerate&&value.savedReport?.status==='pending')void watchSave(operation);
 }
 function markUnknown(operation,message){
  if(paid!==operation)return;
  operation.status='unknown';operation.message=message;
  results.setRecovery(operation.session,{operationId:operation.operationId});publish();
 }
 function finishFailed(operation,response){
  if(paid!==operation)return;
  results.setRecovery(operation.session,null);paid=null;lease=null;
  lastFailure={sessionKey:operation.sessionKey,session:operation.session,operationId:operation.operationId,message:(response.error?.message||'已核对任务在本地终止。')+' '+(response.execution?.dispatchCount>0?'已有 '+response.execution.dispatchCount+' 次模型派发，可能已计费；':'尚无模型派发记录；')+'重新确认后可重试未完成分片，费用仍需核对。',details:response};publish();
 }
 async function reconcile(operation){
  // This request is intentionally independent of the cancelled model-request signal.
  const response=await readResult(operation,AbortSignal.timeout(15000));
  assertBackend(operation,response.execution);
  if(paid!==operation)return response;
  if(response.status==='completed')finishCompleted(operation,response.result);
  else if(response.status==='stopped')finishFailed(operation,response);
  else markUnknown(operation,response.status==='pending'?'后台任务仍在执行，请稍后只读恢复。':'执行结果或可重试性尚未确认，请只读核对，不会重新调用模型。');
  return response;
 }
 function forceCancel(session){
   if(!paid||paid.sessionKey!==resultKey(session))return Promise.resolve();
   const operation=paid;if(operation.forcePromise)return operation.forcePromise;
   operation.forceRequested=true;operation.forceCancelling=true;
   markUnknown(operation,'已强制中断前端等待并请求后台取消；停止与计费尚待核对，安全屏障保留。');
   operation.controller.abort();
   operation.forcePromise=(async()=>{
    try{const signal=AbortSignal.timeout(READ_TIMEOUT);await bounded(signal,()=>rpc('generate-cancel',identity(operation),signal));}
    catch{markUnknown(operation,'强制取消请求未获确认；不能判定后台已停止或未计费，请只读恢复。');}
    try{return await reconcile(operation);}catch{markUnknown(operation,'强制取消后核对暂不可用；任务身份与安全屏障保留，请只读恢复。');return {status:'unknown'};}
    finally{operation.forceCancelling=false;operation.forcePromise=null;if(paid===operation)publish();}
   })();
   return operation.forcePromise;
 }
 async function pollGenerate(operation,acknowledgement){
  let failures=0,terminal=acknowledgement.status!=='pending';
  const controller=operation.controller;
  while(paid===operation&&!controller.signal.aborted){
   const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(READ_TIMEOUT)]);
   try{
    if(terminal){
     const response=await readResult(operation,signal);
     assertBackend(operation,response.execution);
     if(response.status==='completed'){finishCompleted(operation,response.result);return response;}
     if(response.status==='stopped'){finishFailed(operation,response);return response;}
     if(response.status!=='pending')throw new Error('已无法读取报告结果；不能据此重新生成。');
     terminal=false;
    }
    const progress=await readProgress(operation,signal);
    assertBackend(operation,progress?.execution);
    if(typeof progress?.phase!=='string')throw new Error('进度响应无效');
    if(paid!==operation||controller.signal.aborted)break;
    operation.progress=progress;operation.progressWarning='';publish();failures=0;
    terminal=progress.phase==='completed'||progress.phase==='stopped';
    if(terminal)continue;
   }catch(error){
    if(controller.signal.aborted)throw error;
    ++failures;
    operation.progressWarning='进度连接暂时失联，请勿重复提交。'+error.message;publish();
    if(failures>=POLL_FAILURE_LIMIT)throw error;
   }
   await delay(pollIntervalMs,controller.signal);
  }
  controller.signal.throwIfAborted();
  return {status:'unknown'};
 }
 return {
  getSnapshot:()=>snapshot,
  subscribe(listener){listeners.add(listener);listener(snapshot);return()=>listeners.delete(listener);},
  acquireBusiness(label,session){return acquire('business',label,session);},
  hasPaid(session){return !!paid&&(!session||paid.sessionKey===resultKey(session));},
  async recover(session){
   if(!paid||paid.sessionKey!==resultKey(session))throw new Error('此会话没有可恢复的分析任务');
   const operation=paid;
   try{return await reconcile(operation);}catch(error){markUnknown(operation,'只读恢复失败：'+error.message);throw error;}
  },
  cancel(session){
   if(!paid||paid.sessionKey!==resultKey(session))return;
   if(paid.asyncGenerate)return forceCancel(session);
   markUnknown(paid,'已请求取消；取消不证明模型未执行或未计费，请只读核对结果。');paid.controller.abort();
  },
  forceCancel,
  abandon(session){
   if(!paid||paid.sessionKey!==resultKey(session))return;
   if(paid.status==='running')throw new Error('任务仍在执行，请先取消并核对结果');
   paid.abandoned=true;paid.message='已标记放弃恢复，但任务是否停止仍未知。安全屏障继续保留，不能重新派发；请只读核对直到宿主确认终止或完成。';publish();
  },
  startGenerate(session,payload,{asyncGenerate=false,backendInstanceId}={}){
   if(!session?.id||!session?.cwd)throw new Error('需要有效会话及工作区');
   const operationId=randomId();
   acquire('paid','模型分析中',session);
   const operation={operationId,session:{id:session.id,cwd:session.cwd},sessionKey:resultKey(session),controller:new AbortController(),status:'running',message:'模型分析中；离开面板不会取消任务。',asyncGenerate:asyncGenerate===true,backendInstanceId:asyncGenerate===true?backendInstanceId:undefined};
   // Register identity and lease before the first RPC, so synchronous navigation cannot orphan it.
   paid=operation;lastCompleted=null;lastFailure=null;results.setRecovery(operation.session,{operationId:operation.operationId});publish();
   operation.promise=(async()=>{
    try{
     const request={...payload,...identity(operation)};
     if(operation.asyncGenerate){
      if(operation.backendInstanceId)request.backendInstanceId=operation.backendInstanceId;
      const signal=AbortSignal.any([operation.controller.signal,AbortSignal.timeout(READ_TIMEOUT)]);
      const acknowledgement=await bounded(signal,()=>rpc('generate-start',request,signal));
      if(acknowledgement?.operationId!==operation.operationId||!['pending','stopped','completed'].includes(acknowledgement.status))throw new Error('后台启动响应无效');
      assertBackend(operation,acknowledgement.execution);
      operation.backendInstanceId??=acknowledgement.execution?.backendInstanceId;
      return await pollGenerate(operation,acknowledgement);
     }
     const value=await rpc('generate',request,operation.controller.signal);
     if(typeof value?.markdown!=='string')throw new Error('生成响应缺少报告正文');
     finishCompleted(operation,value);return {status:'completed',result:value};
    }catch(error){
     if(!operation.asyncGenerate&&error.details?.execution?.phase==='stopped'){
      const response={status:'stopped',error:{message:error.message,details:error.details},execution:error.details.execution};
      finishFailed(operation,response);return response;
     }
     // forceCancel owns reconciliation after a user cancellation; do not compete with its receipt.
     if(operation.forcePromise)return operation.forcePromise;
     markUnknown(operation,'分析响应未确认：'+error.message);
     try{return await reconcile(operation);}catch(recoveryError){markUnknown(operation,'恢复暂不可用：'+recoveryError.message);return {status:'unknown'};}
    }
   })();
   return {operationId:operation.operationId,promise:operation.promise};
  }
 };
}
