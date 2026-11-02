import {resultKey,readCompletedResult} from './result-state.mjs';

// One controller per apply() invocation, not a cross-tab or cross-reload lock.
export function createLifecycleController({rpc,results,randomId=()=>crypto.randomUUID()}={}){
 const listeners=new Set();
 let lease=null,paid=null,revision=0,lastCompleted=null,lastFailure=null;
 let snapshot={revision,lease:null,paid:null,lastCompleted:null,lastFailure:null};
 const publish=()=>{
  snapshot={revision:++revision,lease:lease?{kind:lease.kind,label:lease.label,sessionKey:lease.sessionKey}:null,
   paid:paid?{operationId:paid.operationId,sessionKey:paid.sessionKey,session:paid.session,status:paid.status,message:paid.message}:null,lastCompleted,lastFailure};
  for(const listener of listeners){try{listener(snapshot);}catch{/* A detached view cannot affect ownership. */}}
 };
 function acquire(kind,label,session){
  if(lease)throw new Error(lease.kind==='install'?'插件更新尚未确认，已阻止新业务。':'当前插件实例存在执行中或结果未知的任务，请先核对；不能重复提交或更新。');
  const token={kind,label,sessionKey:session?resultKey(session):null};lease=token;publish();
  return {release(){if(lease===token){lease=null;publish();}},token};
 }
 function finishCompleted(operation,value){
  if(paid!==operation)return;
  results.set(operation.session,{markdown:value.markdown,coverage:value.coverage,stale:false,kind:'analysis'});
  results.setRecovery(operation.session,null);
  paid=null;lease=null;lastFailure=null;
  lastCompleted={sessionKey:operation.sessionKey,operationId:operation.operationId};publish();
 }
 function markUnknown(operation,message){
  if(paid!==operation)return;
  operation.status='unknown';operation.message=message;
  results.setRecovery(operation.session,{operationId:operation.operationId});publish();
 }
 function finishFailed(operation,response){
  if(paid!==operation)return;
  results.setRecovery(operation.session,null);paid=null;lease=null;
  lastFailure={sessionKey:operation.sessionKey,operationId:operation.operationId,message:(response.error?.message||'已核对任务在本地终止。')+' '+(response.execution?.dispatchCount>0?'已有 '+response.execution.dispatchCount+' 次模型派发，可能已计费；':'尚无模型派发记录；')+'重新确认后可重试未完成分片，费用仍需核对。',details:response};publish();
 }
 async function reconcile(operation){
  // This request is intentionally independent of the cancelled model-request signal.
  const response=await readCompletedResult(rpc,operation.session.id,operation.operationId,AbortSignal.timeout(15000));
  if(paid!==operation)return response;
  if(response.status==='completed')finishCompleted(operation,response.result);
  else if(response.status==='stopped')finishFailed(operation,response);
  else markUnknown(operation,response.status==='pending'?'后台任务仍在执行，请稍后只读恢复。':'执行结果或可重试性尚未确认，请只读核对，不会重新调用模型。');
  return response;
 }
 return {
  getSnapshot:()=>snapshot,
  subscribe(listener){listeners.add(listener);listener(snapshot);return()=>listeners.delete(listener);},
  acquireBusiness(label,session){return acquire('business',label,session);},
  acquireInstall(){return acquire('install','插件更新');},
  hasPaid(session){return !!paid&&(!session||paid.sessionKey===resultKey(session));},
  async recover(session){
   if(!paid||paid.sessionKey!==resultKey(session))throw new Error('此会话没有可恢复的分析任务');
   const operation=paid;
   try{return await reconcile(operation);}catch(error){markUnknown(operation,'只读恢复失败：'+error.message);throw error;}
  },
  cancel(session){
   if(!paid||paid.sessionKey!==resultKey(session))return;
   markUnknown(paid,'已请求取消；取消不证明模型未执行或未计费，请只读核对结果。');paid.controller.abort();
  },
  abandon(session){
   if(!paid||paid.sessionKey!==resultKey(session))return;
   if(paid.status==='running')throw new Error('任务仍在执行，请先取消并核对结果');
   paid.abandoned=true;paid.message='已标记放弃恢复，但任务是否停止仍未知。安全屏障继续保留，不能重新派发或安装；请只读核对直到宿主确认终止或完成。';publish();
  },
  startGenerate(session,payload){
   if(!session?.id||!session?.cwd)throw new Error('需要有效会话及工作区');
   const operationId=randomId();
   acquire('paid','模型分析中',session);
   const operation={operationId,session:{id:session.id,cwd:session.cwd},sessionKey:resultKey(session),controller:new AbortController(),status:'running',message:'模型分析中；离开面板不会取消任务。'};
   // Register identity and lease before the first RPC, so synchronous navigation cannot orphan it.
   paid=operation;lastCompleted=null;lastFailure=null;results.setRecovery(operation.session,{operationId:operation.operationId});publish();
   operation.promise=(async()=>{
    try{
     const value=await rpc('generate',{...payload,sessionId:session.id,operationId:operation.operationId},operation.controller.signal);
     if(typeof value?.markdown!=='string')throw new Error('生成响应缺少报告正文');
     finishCompleted(operation,value);return {status:'completed',result:value};
    }catch(error){
     if(error.details?.execution?.phase==='stopped'){
      const response={status:'stopped',error:{message:error.message},execution:error.details.execution};
      finishFailed(operation,response);return response;
     }
     markUnknown(operation,'分析响应未确认：'+error.message);
     try{return await reconcile(operation);}catch(recoveryError){markUnknown(operation,'恢复暂不可用：'+recoveryError.message);return {status:'unknown'};}
    }
   })();
   return {operationId:operation.operationId,promise:operation.promise};
  }
 };
}
