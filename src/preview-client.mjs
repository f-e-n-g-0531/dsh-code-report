// Capture is a server task, never a long-lived HTTP response or a model request.
const transportFailure=error=>!String(error?.code||'').startsWith('code-report/');
const pause=(ms,signal)=>new Promise((resolve,reject)=>{
 signal?.throwIfAborted();const abort=()=>{clearTimeout(timer);reject(signal.reason);};
 const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},ms);
 signal?.addEventListener('abort',abort,{once:true});
});
export async function capturePreview({rpc,payload,signal,onProgress=()=>{},onWarning=()=>{},operationId=crypto.randomUUID(),pollMs=500,queryTimeoutMs=15000}){
 const identity={sessionId:payload.sessionId,operationId};
 const query=(endpoint,value,parent=signal)=>rpc(endpoint,value,parent?AbortSignal.any([parent,AbortSignal.timeout(queryTimeoutMs)]):AbortSignal.timeout(queryTimeoutMs));
 const warn=error=>onWarning('采集连接暂时失联，正在只读查询同一任务；未重新采集，也未发送模型请求。'+error.message);
 let submitted=false;
 try{
  signal?.throwIfAborted();submitted=true;
  try{await query('preview-start',{...payload,operationId});}
  catch(error){if(signal?.aborted)throw error;if(!transportFailure(error))throw error;warn(error);}
  for(;;){
   signal?.throwIfAborted();let response;
   try{response=await query('result',identity);}
   catch(error){if(signal?.aborted)throw error;if(!transportFailure(error))throw error;warn(error);await pause(pollMs,signal);continue;}
   if(response.status==='completed'&&response.result){onWarning('');return response.result;}
   if(response.status==='stopped')throw Object.assign(new Error(response.error?.message||'采集任务已停止'),{code:response.error?.code||'code-report/capture-stopped'});
   if(response.status!=='pending')throw Object.assign(new Error('采集结果不可用；没有自动重新采集或发送模型请求，请核对后台任务状态。'),{code:'code-report/preview-unavailable'});
   try{const progress=await query('progress',identity);onProgress(progress);onWarning('');}
   catch(error){if(signal?.aborted)throw error;if(!transportFailure(error))throw error;warn(error);}
   await pause(pollMs,signal);
  }
 }finally{
  if(submitted&&signal?.aborted){
   // A view cancellation explicitly stops backend work; transport loss alone does not.
   try{await query('preview-cancel',identity,null);}catch{/* No model is dispatched; backend still enforces capture ownership/deduplication. */}
  }
 }
}
