// Results are private to one plugin instance. No source, preview or consent is persisted.
export function resultKey(session){return JSON.stringify([session?.id,session?.cwd]);}
export function createResultStore({limit=16,maxBytes=32*1024*1024}={}){
 const entries=new Map(),recoveries=new Map();
 const size=value=>new TextEncoder().encode(value.markdown).length;
 const entrySize=entry=>size(entry.current)+(entry.analysis&&entry.analysis.markdown!==entry.current.markdown?size(entry.analysis):0);
 const restore=value=>value?{...value,stale:true}:null;
 return {
  get(session){return restore(entries.get(resultKey(session))?.current);},
  getAnalysis(session){return restore(entries.get(resultKey(session))?.analysis);},
  getRecovery(session){const value=recoveries.get(resultKey(session));return value?{...value}:null;},
  setRecovery(session,value){
   const key=resultKey(session);recoveries.delete(key);
   if(value?.operationId&&session?.id&&session?.cwd)recoveries.set(key,{operationId:value.operationId});
   while(recoveries.size>64)recoveries.delete(recoveries.keys().next().value);
  },
  set(session,value){
   if(!session?.id||!session?.cwd||!value?.markdown)return;
   const current={markdown:value.markdown,stale:value.stale===true,coverage:value.coverage,...(value.kind?{kind:value.kind}:{})};
   const previous=entries.get(resultKey(session));
   // Keep only current output and latest successful AI output, not an unbounded history.
   const entry={current,analysis:value.kind==='analysis'?current:previous?.analysis};
   entries.delete(resultKey(session));entries.set(resultKey(session),entry);
   let bytes=[...entries.values()].reduce((sum,item)=>sum+entrySize(item),0);
   while(entries.size>limit||bytes>maxBytes){const key=entries.keys().next().value;bytes-=entrySize(entries.get(key));entries.delete(key);}
  },
  delete(session){entries.delete(resultKey(session));}
 };
}
export function staleResult(result){return result?{...result,stale:true}:null;}
export function previewExpired(preview,now=Date.now()){
 const deadline=typeof preview?.expiresAt==='number'?preview.expiresAt:Date.parse(preview?.expiresAt);
 return !Number.isFinite(deadline)||now>=deadline;
}
export function generationBlocker({preview,now,compatibility,busy,consent,provider,model,pendingRecovery}){
 if(pendingRecovery)return '上次分析结果尚未确认，请先只读恢复，勿重复生成。';
 if(busy)return '正在执行任务，请等待完成或取消。';
 if(compatibility)return compatibility;
 if(!preview||previewExpired(preview,now))return '快照已过期，请重新采集并确认发送。';
 if(!preview.analysisPlan?.id)return '分析计划不可用，请重新采集。';
 if(!provider.trim()||!model.trim())return '请填写 DSH 已配置的提供方与模型 ID。';
 if(!consent)return '请确认本次发送范围和分批调用费用。';
 return '';
}
// Only transport/unknown failures are ambiguous; explicit business failures may be retried after consent.
export function needsResultRecovery(error){return !String(error?.code||'').startsWith('code-report/');}
export async function readCompletedResult(rpc,sessionId,operationId,signal){
 const response=await rpc('result',{sessionId,operationId},signal);
 if(response?.status==='completed'&&typeof response.result?.markdown==='string')return response;
 if(response?.status==='pending'||response?.status==='failed')return response;
 throw new Error('报告恢复响应无效，执行结果仍未知；请勿重复生成。');
}
export function parseVersionContexts(text,rows){
 const selected=new Set(rows.filter(row=>row.enabled).map(row=>row.path));
 return text.split(/\r?\n/).map(line=>line.trim()).filter(Boolean).map((line,index)=>{
  const fields=line.split('|').map(field=>field.trim());
  if(fields.length!==3||!fields[0]||!['A','B'].includes(fields[1])||!fields[2])throw new Error('版本源码第 '+(index+1)+' 行格式应为 仓库路径|A或B|仓库相对路径');
  if(!selected.has(fields[0]))throw new Error('版本源码第 '+(index+1)+' 行仓库未纳入本次比较');
  return {repository:fields[0],side:fields[1],path:fields[2]};
 });
}
export function captureBlocker(rows,network,busy,compatibility,issues,contextIssue=''){
 if(busy)return busy+'，请等待完成或取消。';
 if(compatibility)return compatibility;
 if(issues.length)return '尚不能采集差异：'+issues.join(' ');
 if(contextIssue)return contextIssue;
 return rows.some(row=>row.enabled&&row.type==='svn')&&!network?'所选项目含 SVN，请先勾选允许读取 SVN 历史版本。':'';
}
