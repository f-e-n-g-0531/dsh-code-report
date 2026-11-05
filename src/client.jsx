import React,{useState,useRef,useEffect} from 'react';
import css from './style.css';
import UpdatePanel from './UpdatePanel.jsx';
import RepositoryCards from './RepositoryCards.jsx';
import ReportDocument from './ReportDocument.jsx';
import {version} from '../package.json';
import {runtimeGate} from './protocol.mjs';
import {createUpdateController} from './update-client.mjs';
import {createLifecycleController} from './lifecycle-controller.mjs';
import {createClientRpc} from './client-rpc.mjs';
import {capturePreview} from './preview-client.mjs';
import {reportDownloadText} from './report-export.mjs';
import {fresh,mergeRepositories,repositoryIssues} from './repositories.mjs';
import {DEFAULT_SCAN,loadConfiguration,saveConfiguration} from './configuration.mjs';
import {createResultStore,staleResult,previewExpired,generationBlocker,parseVersionContexts,captureBlocker,completedViewResult,terminalAnalysisProgress} from './result-state.mjs';
export const inject=['slots','connection','remote','remote.pluginManager'];

export function apply(ctx){
 const rpc=createClientRpc(ctx.connection);
 const results=createResultStore();
 const lifecycle=createLifecycleController({rpc,results});
 const updateController=createUpdateController({lifecycle});
 function Page(props){
  const session=props.useSessions(s=>Object.values(s.byId).find(row=>(row.retainedBy.mainView??0)>0));
  return <Panel key={JSON.stringify([session?.id,session?.cwd])} session={session}/>;
 }
 function Panel({session}){
  const [updateState,setUpdateState]=useState(()=>updateController.getSnapshot());
  useEffect(()=>updateController.subscribe(setUpdateState),[]);
  const updating=updateState.updating,updateBarrier=updateState.barrier;
  const [runtime,setRuntime]=useState(null),[runtimeError,setRuntimeError]=useState(''),[runtimeAttempt,setRuntimeAttempt]=useState(0);
  const compatibility=updateBarrier||(updating?'插件更新正在进行，已暂停扫描和分析。':'')||runtimeError||runtimeGate(runtime,version);
  useEffect(()=>{
   const ac=new AbortController();setRuntime(null);setRuntimeError('');
   rpc('runtime-info',{},ac.signal).then(value=>{if(!ac.signal.aborted)setRuntime(value);})
    .catch(error=>{if(!ac.signal.aborted)setRuntimeError('后台验证失败：'+error.message);});
   return()=>ac.abort();
  },[runtimeAttempt]);
  const [initial]=useState(()=>{
   try{return {config:loadConfiguration(globalThis.localStorage,session?.cwd)};}
   catch(error){return {config:null,error:error.message};}
  });
  const saved=initial.config,scanSettings=DEFAULT_SCAN;
  const [configNotice,setConfigNotice]=useState(initial.error?'配置未恢复：'+initial.error:saved?restoredNotice(saved.allowSvnNetwork):'');
  const [rows,setRows]=useState(saved?.rows||[]),[title,setTitle]=useState(saved?.title||'版本发布报告');
  const [context,setContext]=useState(saved?.context||''),[versionContext,setVersionContext]=useState(saved?.versionContext||'');
  const [network,setNetwork]=useState(saved?.allowSvnNetwork===true);
  const [provider,setProvider]=useState(saved?.provider||''),[model,setModel]=useState(saved?.model||''),[consent,setConsent]=useState(false);
  const [useDefaultModel,setUseDefaultModel]=useState(saved?.useDefaultModel!==false);
  const [preview,setPreview]=useState(null),[result,setResult]=useState(()=>results.get(session));
  const [latestAnalysis,setLatestAnalysis]=useState(()=>results.getAnalysis(session));
  const [lifecycleState,setLifecycleState]=useState(()=>lifecycle.getSnapshot());
  useEffect(()=>lifecycle.subscribe(setLifecycleState),[]);
  const ownTask=lifecycleState.paid?.sessionKey===JSON.stringify([session?.id,session?.cwd])?lifecycleState.paid:null;
  const pendingRecovery=ownTask;
  const pendingRecoveryRef=useRef(pendingRecovery);pendingRecoveryRef.current=pendingRecovery;
  const [abandonConfirmed,setAbandonConfirmed]=useState(false),[recovering,setRecovering]=useState(false);
  const globalBusy=!!lifecycleState.lease;
  const draftRevision=useRef(0),submittedOperation=useRef(null);
  useEffect(()=>{
   if(lifecycleState.lastCompleted?.sessionKey===JSON.stringify([session?.id,session?.cwd])){
    setResult(completedViewResult(results.get(session),lifecycleState.lastCompleted,submittedOperation.current,draftRevision.current));
    setLatestAnalysis(results.getAnalysis(session));setPreview(null);setConsent(false);
    setProgress(terminalAnalysisProgress(lifecycleState.lastCompleted));setProgressWarning('');
   }
   if(lifecycleState.lastFailure?.sessionKey===JSON.stringify([session?.id,session?.cwd])){
    setError(lifecycleState.lastFailure.message);setConsent(false);
    setProgress(terminalAnalysisProgress(null,lifecycleState.lastFailure));setProgressWarning('');
   }
  },[lifecycleState.lastCompleted,lifecycleState.lastFailure]);
  const [busy,setBusy]=useState(''),[error,setError]=useState(''),[progress,setProgress]=useState(null),[progressWarning,setProgressWarning]=useState('');
  const [scanState,setScanState]=useState('idle'),[scanError,setScanError]=useState(''),[scanWarnings,setScanWarnings]=useState([]),[visited,setVisited]=useState(null);
  const [inputBudget,setInputBudget]=useState('64000'),[planDirty,setPlanDirty]=useState(false),[now,setNow]=useState(Date.now);
  const initialScanStarted=useRef(false),controller=useRef(null),mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;controller.current?.abort();};},[]);
  useEffect(()=>{
   if(!preview)return;
   const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);
  },[preview?.previewId]);
  useEffect(()=>{
   const id=preview?.previewId;
   return()=>{if(id&&session?.id&&!lifecycle.hasPaid(session))void rpc('release-preview',{sessionId:session.id,previewId:id}).catch(()=>{});};
  },[preview?.previewId,session?.id]);
  const expired=preview?previewExpired(preview,now):false;
  const hasCurrentReport=result?.kind==='analysis'&&!result.stale;
  const workflow=ownTask?['complete','complete','active']:preview&&!expired?['complete','active','pending']:hasCurrentReport?['complete','complete','complete']:['active','pending','pending'];
  useEffect(()=>{if(expired)setConsent(false);},[expired]);
  useEffect(()=>{
   if(!ownTask)return;
   const ac=new AbortController();let timer,failures=0;
   const poll=async()=>{
    try{const value=await rpc('progress',{sessionId:session.id,operationId:ownTask.operationId},ac.signal);if(!ac.signal.aborted){setProgress(value);setProgressWarning('');failures=0;}}
    catch(error){if(!ac.signal.aborted&&++failures>=2)setProgressWarning('进度连接暂时失联；任务身份仍保留，请只读恢复。'+error.message);}
    if(!ac.signal.aborted)timer=setTimeout(poll,500);
   };
   timer=setTimeout(poll,250);return()=>{ac.abort();clearTimeout(timer);};
  },[ownTask?.operationId]);
  const keepResult=value=>{results.set(session,value);setResult(value);setLatestAnalysis(results.getAnalysis(session));};
  const clearResult=()=>{
   if(result?.kind==='analysis')results.clearAnalysis(session);else results.clearCurrent(session);
   setResult(results.get(session));setLatestAnalysis(results.getAnalysis(session));
  };
  const invalidate=()=>{
   draftRevision.current++;
   setPreview(null);setConsent(false);setProgress(null);setPlanDirty(false);
   setResult(previous=>{const next=staleResult(previous);if(next)results.set(session,next);return next;});
  };
  const change=(index,key,value)=>{invalidate();setRows(previous=>previous.map((row,i)=>i===index?{...row,[key]:value}:row));};
  const store=()=>{
   try{saveConfiguration(globalThis.localStorage,session.cwd,{schema:1,rows,title,context,versionContext,allowBatches:true,provider,model,useDefaultModel,scan:scanSettings,allowSvnNetwork:network});setConfigNotice('已保存此工作区配置及 SVN 访问勾选状态；不保存密码、报告、源码内容或模型发送确认。');}
   catch(error){setConfigNotice('保存失败：'+error.message);}
  };
  const restore=()=>{
   try{
    const value=loadConfiguration(globalThis.localStorage,session.cwd);
    if(!value){setConfigNotice('此工作区尚无已保存配置。');return;}
    invalidate();setRows(value.rows);setTitle(value.title);setContext(value.context);setVersionContext(value.versionContext||'');
    setProvider(value.provider);setModel(value.model);setUseDefaultModel(value.useDefaultModel!==false);setNetwork(value.allowSvnNetwork===true);
    setScanState('idle');setScanWarnings([]);setScanError('');setConfigNotice(restoredNotice(value.allowSvnNetwork));
   }catch(error){setConfigNotice('恢复失败：'+error.message);}
  };
  const perform=async(label,fn)=>{
   const update=updateController.getSnapshot();
   if(controller.current)return;
   if(compatibility||update.updating||update.barrier){setError(compatibility||'更新未完成或需要重载');return;}
   let lease;try{lease=lifecycle.acquireBusiness(label,session);}catch(error){setError(error.message);return;}
   const ac=new AbortController();controller.current=ac;setBusy(label);setError('');setProgressWarning('');setProgress({phase:'starting',label});
   try{
    await fn(ac.signal);
    if(mounted.current&&!ac.signal.aborted)setProgress({phase:'completed',completed:1,total:1,label:label+'完成'});
   }catch(error){
    if(mounted.current&&!ac.signal.aborted){
     const details=error.details;
     const recovery=Number.isInteger(details?.completedBatches)&&Number.isInteger(details?.remainingBatches)?' 已完成 '+details.completedBatches+' 片，剩余 '+details.remainingBatches+' 片；请重新确认后重试剩余片。更换模型路由或更新分析计划会重跑全部分片，可能再次计费。':'';
     setError(error.message+recovery);setProgress({phase:'failed',label:'执行失败：'+error.message});
     if(error.code==='code-report/preview-expired'){setPreview(previous=>previous?{...previous,expiresAt:0}:null);setConsent(false);}
    }
   }finally{
    lease.release();
    if(controller.current===ac){controller.current=null;if(mounted.current){if(ac.signal.aborted)setProgress({phase:'cancelled',label:'执行已取消；已有报告已保留'});setBusy('');setProgressWarning('');}}
   }
  };
  const tracked=async(endpoint,payload,signal)=>{
   const operationId=crypto.randomUUID(),polling=new AbortController(),pollSignal=AbortSignal.any([signal,polling.signal]);
   let timer,failures=0;
   const poll=async()=>{
    try{const value=await rpc('progress',{sessionId:session.id,operationId},pollSignal);if(!pollSignal.aborted&&mounted.current){setProgress(value);setProgressWarning('');failures=0;}}
    catch(error){if(!pollSignal.aborted&&mounted.current&&++failures>=2)setProgressWarning('进度连接暂时失联，任务结果尚未知；请勿重复提交。'+error.message);}
    if(!pollSignal.aborted)timer=setTimeout(poll,500);
   };
   timer=setTimeout(poll,250);
   try{return await rpc(endpoint,{...payload,operationId},signal);}
   finally{polling.abort();clearTimeout(timer);}
  };
  const scan=()=>{
   if(compatibility){setScanError(compatibility);return;}
   return perform('扫描项目',async signal=>{
    setScanState('scanning');setScanError('');setScanWarnings([]);
    try{
     const value=await tracked('discover',{sessionId:session.id,scan:scanSettings},signal);signal.throwIfAborted();
     if(!mounted.current)return;
     setRows(previous=>mergeRepositories(previous,value.repositories));setVisited(value.visited);setScanState('completed');
     setScanWarnings([...value.warnings,...(rows.length+value.repositories.filter(found=>!rows.some(row=>row.path===found.path&&row.type===found.type)).length>500?['项目列表最多保留 500 项，请移除不需要的项目后重扫。']:[])]);
    }catch(error){if(mounted.current){setScanState(signal.aborted?'cancelled':'failed');if(!signal.aborted)setScanError(error.message);}throw error;}
   });
  };
  useEffect(()=>{if(session?.id&&!compatibility&&!lifecycle.getSnapshot().lease&&!initialScanStarted.current){initialScanStarted.current=true;void scan();}},[session?.id,compatibility,lifecycleState.revision]);
  let versionContexts=[],contextIssue='';
  try{
   versionContexts=parseVersionContexts(versionContext,rows);
  }catch(error){contextIssue=error.message;}
  const issues=repositoryIssues(rows),captureReason=globalBusy?'当前插件实例有任务或更新尚未确认，请先完成或恢复。':captureBlocker(rows,network,busy,compatibility,issues,contextIssue);
  const capture=()=>{
   if(captureReason)return;
   return perform('采集版本差异',async signal=>{
    setPreview(null);setConsent(false);setPlanDirty(false);
    const value=await capturePreview({rpc,signal,onProgress:value=>{if(mounted.current&&!signal.aborted)setProgress(value);},onWarning:value=>{if(mounted.current&&!signal.aborted)setProgressWarning(value);},payload:{sessionId:session.id,request:{title,repositories:rows.filter(row=>row.enabled).map(({enabled,...row})=>row),contextPaths:context.split(/\r?\n/).map(line=>line.trim()).filter(Boolean),versionContexts,allowSvnNetwork:network,allowBatches:true}}});
    if(!signal.aborted&&mounted.current){setNow(Date.now());setPreview(value);setInputBudget(String(value.analysisPlan?.inputBudget||64000));keepResult({markdown:value.markdown,stale:false,kind:'local'});}
   });
  };
  const generateReason=generationBlocker({preview,now,compatibility,busy:busy||(globalBusy?'其他任务执行中':''),consent,provider,model,useDefaultModel,pendingRecovery})||(planDirty?'输入预算已变化，请先更新分析计划。':'');
  const generate=()=>{
   const approved=consent;setConsent(false);
   if(generateReason||lifecycle.getSnapshot().lease)return;
   try{
    setError('');
    const operation=lifecycle.startGenerate(session,{previewId:preview.previewId,planId:preview.analysisPlan.id,sendToModel:approved,route:useDefaultModel?{mode:'default',provider:preview.defaultRoute.provider,model:preview.defaultRoute.model}:{provider:provider.trim(),model:model.trim()}});
    submittedOperation.current={operationId:operation.operationId,draftRevision:draftRevision.current};
   }catch(error){setError(error.message);}
  };
  const recover=async()=>{
   if(recovering||!lifecycle.hasPaid(session))return;
   setRecovering(true);setConsent(false);setError('');
   try{await lifecycle.recover(session);}catch(error){if(mounted.current)setError(error.message);}
   finally{if(mounted.current)setRecovering(false);}
  };
  const abandonRecovery=()=>{
   if(!abandonConfirmed||busy)return;
   try{lifecycle.abandon(session);setAbandonConfirmed(false);setConsent(false);setError('已标记放弃恢复，但未知任务的安全屏障继续保留；请核对到宿主明确停止或完成，不能据此重新派发或安装。');}
   catch(error){setError(error.message);}
  };
  const budgetValid=/^\d+$/.test(inputBudget)&&Number(inputBudget)>=4000&&Number(inputBudget)<=64000;
  const replan=()=>{
   setConsent(false);
   if(!preview||expired||!budgetValid||globalBusy)return;
   return perform('更新分析计划',async signal=>{
    const value=await tracked('analysis-plan',{sessionId:session.id,previewId:preview.previewId,inputBudget:Number(inputBudget)},signal);
    if(!signal.aborted&&mounted.current){setPreview(previous=>({...previous,analysisPlan:value.analysisPlan,planError:null}));setPlanDirty(false);}
   });
  };
  const loadRefs=async(repositoryPath,signal,{gitMode='remote',gitRemote='origin'}={})=>{
   if(compatibility||updateController.getSnapshot().updating||updateController.getSnapshot().barrier)throw new Error('后台或更新状态尚不可用');
   const lease=lifecycle.acquireBusiness(gitMode==='remote'?'读取远端 refs':'读取本地 refs',session);
   try{return (await rpc('refs',{sessionId:session.id,repositoryPath,gitMode,gitRemote},signal)).refs;}finally{lease.release();}
  };
  return <section className="cr-root"><style>{css}</style>
   <header className="cr-hero"><div className="cr-hero-title"><span className="cr-hero-mark" aria-hidden="true">▤</span><div><small>RELEASE WORKSPACE <span>· v{version}</span></small><h1>发布报告配置</h1><p>从版本差异到发布决策，让每一次交付都有据可依。</p></div></div><div className="cr-actions cr-header-actions"><button disabled={!session||!!busy||updating} onClick={store}>保存配置</button><button disabled={!session||!!busy||updating||!!pendingRecovery} onClick={restore}>恢复已保存</button></div></header>
   <nav className="cr-stage-nav" aria-label="报告工作流程"><div className="cr-stage" data-state={workflow[0]} aria-current={workflow[0]==='active'?'step':undefined}><span className="cr-stage-number">01</span><div><strong>配置发布范围</strong><span>项目与版本端点</span></div></div><div className="cr-stage" data-state={workflow[1]} aria-current={workflow[1]==='active'?'step':undefined}><span className="cr-stage-number">02</span><div><strong>核对差异证据</strong><span>固定快照 · 确认发送</span></div></div><div className="cr-stage" data-state={workflow[2]} aria-current={workflow[2]==='active'?'step':undefined}><span className="cr-stage-number">03</span><div><strong>生成与导出</strong><span>{ownTask?(ownTask.status==='running'?'模型分析进行中':'任务状态待核对'):hasCurrentReport&&!preview?'报告已生成，可下载':'影响分析与 QA 建议'}</span></div></div></nav>
   <details className="cr-update-details"><summary>插件版本与更新 · {version}</summary><UpdatePanel rpc={rpc} manager={ctx.remote?.pluginManager} reportBusy={!!busy||!!lifecycleState.paid||lifecycleState.lease?.kind==='business'} controller={updateController} updateState={updateState}/></details>
   {configNotice&&<p className="cr-hint" role="status">{configNotice}</p>}
   {compatibility&&<div className="cr-error" role="alert">{compatibility}<button disabled={!!busy||updating||!!updateBarrier} onClick={()=>setRuntimeAttempt(value=>value+1)}>重新验证后台</button></div>}
   <fieldset className="cr-report-form">
    {!session?<p role="status">请先打开一个带工作目录的会话。</p>:<>
     <div className="cr-workspace-bar"><div className="cr-workspace"><span className="cr-workspace-label">当前工作区</span><code>{session.cwd}</code></div><span className="cr-readonly-badge">仅读取，不修改版本库</span></div>
     <div className="cr-scan-settings"><button disabled={!!busy||!!compatibility||globalBusy} onClick={scan}>扫描 / 重新发现</button>{busy==='扫描项目'&&<button onClick={()=>controller.current?.abort()}>取消扫描</button>}<span className="cr-hint">只检查工作区根目录及一级子文件夹，不递归。{visited!==null?'上次检查 '+visited+' 个目录。':''}嵌套项目可手动添加；已保存的项目不会自动删除。</span></div>
     <fieldset className="cr-panel cr-scope" disabled={!!busy||globalBusy}><legend>1. 发布范围</legend><label className="cr-wide">报告标题<input value={title} onChange={event=>{invalidate();setTitle(event.target.value);}} maxLength={160}/></label>
      <div className="cr-section-intro"><div className="cr-section-heading"><h2>工作区项目</h2><p>{scanStateLabel(scanState)}当前列表 {rows.length} 个项目 · 已纳入 {rows.filter(row=>row.enabled).length} / 12。勾选需要生成报告的项目。</p></div><div className="cr-actions"><button onClick={()=>{invalidate();setRows(rows.map(row=>({...row,enabled:false})));}}>全部取消</button><button onClick={()=>{invalidate();setRows(rows.map((row,index)=>({...row,enabled:index<12})));}}>纳入前 12 项</button></div></div>
      {scanError&&<p className="cr-error" role="alert">{scanError}</p>}{scanWarnings.length>0&&<ul className="cr-scan-warnings">{scanWarnings.map((warning,index)=><li key={index}>{warning}</li>)}</ul>}
      <RepositoryCards replace={next=>{invalidate();setRows(next);}} scanState={scanState} rows={rows} change={change} remove={index=>{invalidate();setRows(rows.filter((_,i)=>i!==index));}} loadRefs={loadRefs} refsDisabled={!!compatibility||globalBusy}/>
      <button disabled={rows.length>=500} onClick={()=>{invalidate();setRows([...rows,fresh()]);}}>＋ 添加项目</button>
      <details className="cr-guide"><summary>版本填写与远端读取说明</summary><p className="cr-hint">自动扫描当前工作区，保留已经填写的版本。路径相对于工作区，根目录填「.」。版本留空默认取对应 A/B 分支最新提交；两侧分支相同且版本均留空时无差异。Git 默认远端实时读取，可填 main / develop / origin/develop 等；会联网并可能要求身份验证，在隔离临时目录完整抓取，不创建业务本地分支、不修改业务 refs 或工作区。显式选择“本地离线”才仅用本地对象、不自动 fetch；远端失败不回退本地。SVN 仍需历史读取授权。</p></details>
      <label className="cr-check"><input type="checkbox" checked={network} onChange={event=>{invalidate();setNetwork(event.target.checked);}}/> 允许通过 SVN 工作副本地址读取历史版本（可能访问网络；此勾选随工作区配置保存，不保存密码）</label>
      <p className="cr-hint">本地采集不设固定证据总量上限；默认生成一次请求的摘要分析，只发送预算内的本地摘要与选定片段，不发送全部正文。本地完整统计不等于模型全文覆盖，仍须核对范围并明确确认费用；失败不会自动重试。</p>
     </fieldset>
     <details className="cr-optional"><summary>2. 附带项目源码（可选）{context.trim()||versionContext.trim()?' · 已填写':''}</summary><fieldset disabled={!!busy||globalBusy}><legend>源码路径</legend><p>每行填写一个工作区内的文件或文件夹路径，根目录可填「.」。文件夹递归展开；不会自动附带未填写的目录或扫描调用链。</p>
      <textarea aria-label="源码上下文路径" rows={4} placeholder={'app/src/api.ts\napp/src/components'} value={context} onChange={event=>{invalidate();setContext(event.target.value);}}/>
      <label>固定版本源码（仅文件；每行：仓库路径|A或B|仓库相对路径）<textarea aria-label="固定版本源码路径" rows={3} placeholder="app|A|src/api.ts" value={versionContext} onChange={event=>{invalidate();setVersionContext(event.target.value);}}/></label>
      <p className="cr-hint">工作区路径条目、展开文件数、单文件大小和总证据不设固定规模上限，仍受可用内存等系统资源约束。支持无 NUL 的 UTF-8、GBK / GB18030 文本，优先 UTF-8，失败后严格按 GB18030 解码；差异逐行选择编码，预览标记结果。二进制、两种编码均无法解码或无法读取会使整次采集失败，不静默跳过或截断。当前工作区与历史 A/B 版本分开标记。</p><p className="cr-hint">目录展开跳过点前缀隐藏、敏感、依赖、构建和缓存路径、链接及非普通文件，排除计数见预览限制；显式填写敏感路径仍拒绝。不按 Windows Hidden 属性筛选。源码目录展开不设固定条目、目录或深度上限。发送前检查展开后的实际文件清单及限制，并自行检查源码内的密钥。</p>{contextIssue&&<p role="alert" className="cr-error">{contextIssue}</p>}
     </fieldset></details>
     <div className="cr-actions cr-execute"><button className="cr-primary" disabled={!!captureReason} aria-describedby={captureReason?'cr-capture-reason':undefined} onClick={capture}>开始执行 · 采集差异</button>{captureReason&&<span id="cr-capture-reason" role="status" aria-live="polite">{captureReason}</span>}{busy&&<><span role="status">{busy}…</span><button onClick={()=>controller.current?.abort()}>取消</button></>}</div>
     {lifecycleState.paid&&!ownTask&&<p className="cr-stale" role="status">其他会话有模型任务执行中或结果未知；本插件实例暂停新业务和安装。请回原会话恢复。此互斥不覆盖其他标签页或客户端。</p>}
     {pendingRecovery&&<section className="cr-stale" aria-label="报告恢复"><p role="status">{pendingRecovery.message} 恢复只读取已有报告，不调用模型、不再次计费。任务归属保留在当前插件实例，切换会话仅分离视图，不取消模型。恢复标识按会话及工作区暂存；刷新、重载或更换客户端不保证恢复，请先下载。</p><button disabled={recovering} onClick={recover}>恢复已完成报告</button><button onClick={()=>lifecycle.cancel(session)}>取消模型任务</button><label className="cr-check"><input type="checkbox" checked={abandonConfirmed} disabled={!!busy} onChange={event=>setAbandonConfirmed(event.target.checked)}/>我确认标记放弃恢复；未知任务屏障仍保留，不解锁新业务或安装</label><button disabled={!!busy||!abandonConfirmed||pendingRecovery.status==='running'} onClick={abandonRecovery}>放弃恢复</button></section>}
     {preview&&<PreviewSection preview={preview} busy={busy||(globalBusy?'等待任务核对':'')} expired={expired} useDefaultModel={useDefaultModel} setUseDefaultModel={setUseDefaultModel} provider={provider} model={model} consent={consent} setProvider={setProvider} setModel={setModel} setConsent={setConsent} generateReason={generateReason} onGenerate={generate} onCapture={capture} inputBudget={inputBudget} budgetValid={budgetValid} planDirty={planDirty} onBudget={value=>{setInputBudget(value);setConsent(false);setPlanDirty(true);}} onReplan={replan} compatibility={compatibility} now={now}/>}
     {progress&&<ProgressSection progress={progress}/>}{progressWarning&&<p className="cr-error" role="status">{progressWarning}</p>}
     {error&&error!==scanError&&<p className="cr-error" role="alert">{error}</p>}
     {latestAnalysis&&result?.kind!=='analysis'&&<p className="cr-stale">上一份成功模型报告仍保留，与当前草稿可能不同。<button onClick={()=>keepResult({...latestAnalysis,stale:true})}>查看上一份模型报告</button><button onClick={()=>downloadMarkdown(latestAnalysis.markdown,latestAnalysis.kind)}>下载上一份模型报告</button></p>}
     {result&&<ReportSection result={result} onDownload={()=>downloadMarkdown(result.markdown,result.kind)} onClear={clearResult}/>}
    </>}
   </fieldset>
  </section>;
 }
 function Icon(){return <span aria-hidden="true">▤</span>;}
 ctx.slots.inject('main',()=>ctx.slots.register({name:'main',key:'local-code-report'},Page));
 ctx.slots.inject('sidebar.panellist',()=>ctx.slots.register({name:'sidebar.panellist',id:'local-code-report',label:()=> '发布报告',order:66},Icon));
}
function restoredNotice(allowSvnNetwork){return allowSvnNetwork?'已恢复此工作区配置及 SVN 历史访问许可；模型发送仍需确认。':'已恢复此工作区配置；SVN 访问未授权，模型发送仍需确认。';}
function scanStateLabel(state){return state==='completed'?'扫描完成 · ':state==='scanning'?'扫描中 · ':state==='failed'?'扫描失败 · ':state==='cancelled'?'扫描已取消 · ':'尚未扫描 · ';}
function sideLabel(row,side){return row.type==='svn'?row['branch'+side]+' @ r'+row[side.toLowerCase()]:row[side.toLowerCase()];}
function downloadMarkdown(markdown,kind){const url=URL.createObjectURL(new Blob([reportDownloadText(markdown,kind)],{type:'text/markdown;charset=utf-8'}));const anchor=document.createElement('a');anchor.href=url;anchor.download=(kind==='analysis'?'release-report-':kind==='local'?'captured-evidence-':'unclassified-result-')+new Date().toISOString().slice(0,10)+'.md';anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function PreviewSection({preview,busy,expired,useDefaultModel=true,setUseDefaultModel,provider,model,consent,setProvider,setModel,setConsent,generateReason,onGenerate,onCapture,inputBudget,budgetValid,planDirty,onBudget,onReplan,compatibility,now}){
 const deadline=typeof preview.expiresAt==='number'?preview.expiresAt:Date.parse(preview.expiresAt);
 const plan=preview.analysisPlan,coverage=plan?.coverage||{},single=plan?.strategy==='single-request'||plan?.mode==='single-request'||coverage.strategy==='single-request';
 return <fieldset className="cr-panel cr-preview" disabled={!!busy}><legend>3. 确认分析范围</legend>
  <div className="cr-preview-metrics"><div className="cr-metric"><span>固定项目</span><strong>{preview.repositories.length}</strong></div><div className="cr-metric"><span>变更路径</span><strong>{preview.repositories.reduce((sum,row)=>sum+row.files.length,0)}</strong></div><div className="cr-metric"><span>源码文件</span><strong>{preview.context.length}</strong></div><div className="cr-metric"><span>{single?'模型请求':'模型分片'}</span><strong>{plan?.batches?.length??'—'}</strong></div></div>
  <p>证据 {preview.bytes} 字节（约 {(preview.bytes/1024).toFixed(1)} KiB）；{preview.repositories.length} 个项目，{preview.repositories.reduce((total,row)=>total+(row.files?.length||0),0)} 条变更路径，{preview.context.length} 个实际源码文件（目录已展开）。{expired?'快照已过期。':'快照剩余约 '+Math.max(0,Math.ceil((deadline-now)/1000))+' 秒。'}</p>
  {expired&&<div className="cr-error" role="status">快照已过期，请重新采集并确认发送。<button disabled={!!compatibility} onClick={onCapture}>重新采集</button></div>}
  <ul className="cr-preview-repos">{preview.repositories.map((row,index)=><li key={index}><strong>{row.path}</strong> · {row.type} · {row.files.length} 个变更路径<br/><code>{sideLabel(row,'A')} → {sideLabel(row,'B')}</code>{row.type==='git'&&<p>{row.gitSource==='remote'?'远端实时读取 · '+(row.remote||'origin')+' · 观察时间 '+(row.observedAt||'未记录')+'（本次快照，之后不自动更新）':row.gitSource==='local'?'本地离线读取':'Git 来源未记录'}</p>}<br/>差异解码 {row.diffEncoding||'未记录'} · 原始字节 SHA-256 {row.rawDiffHash||'未记录'}</li>)}</ul>
  <details open><summary>查看源码上下文及限制</summary><p className="cr-hint">以下为本次实际附带的文件清单（目录已展开）；请核对来源与排除限制后再授权模型。</p><ul aria-label="实际源码文件清单">{preview.context.map((item,index)=><li key={index}>{item.repository?item.repository+' / ':''}{item.path} · {item.provenance==='version-A'?'版本 A':item.provenance==='version-B'?'版本 B':'当前工作区'} {item.revision||''} · 编码 {item.encoding||'未记录'} · 原始字节 SHA-256 {item.rawHash||item.hash}</li>)}</ul><ul aria-label="源码及采集限制">{preview.limitations.map((text,index)=><li key={index}>{text}</li>)}</ul></details>
  <div className="cr-budget-row"><label>{single?'单次输入预算（保守字节估算，非 token）':'单片输入预算（保守字节估算，非 token）'}<input aria-label={single?'单次输入预算':'单片输入预算'} type="number" min={4000} max={64000} value={inputBudget} onChange={event=>onBudget(event.target.value)}/></label>
  <button disabled={expired||!budgetValid||!!compatibility} onClick={onReplan}>更新分析计划</button></div>
  {!budgetValid&&<p role="alert">输入预算必须是 4000–64000 的整数。</p>}{planDirty&&<p role="status">预算已变更，请更新分析计划并重新确认。</p>}
  {preview.planError&&<p className="cr-error" role="alert">分析计划尚不可用：{preview.planError.message}。可调整预算重新规划；本地证据清单仍可下载。</p>}
  {single&&<SingleRequestCoverage coverage={coverage}/>}
  <p className="cr-hint">{single?'本计划仅一次模型请求，发送预算内本地摘要和明确选择的片段，不是全部正文；失败不会自动重试。更换模型路由、更新分析计划或再次明确确认后重试可能再次计费。':'本计划 '+(plan?.batches?.length??0)+' 片，按顺序调用模型，可能产生多次费用；失败重试仅复用宿主保留的同计划、同路由已完成分片，每次仍须确认。更换模型路由或更新分析计划将重跑全部分片，可能再次计费。'}4000–64000 仅为合法输入范围，不保证一定可规划；4000 等较小预算可能连系统提示和元数据都容不下，此时请提高预算或缩小范围。字节估算也不能保证适配所有模型。</p>
  <label className="cr-check"><input type="checkbox" checked={useDefaultModel} onChange={event=>{setUseDefaultModel(event.target.checked);setConsent(false);}}/>使用 DSH 默认模型</label>
  {useDefaultModel?<p className="cr-hint" role="status">{preview.defaultRoute?<>本次模型：<strong>{preview.defaultRoute.provider} / {preview.defaultRoute.model}</strong>。来自 DSH 默认模型配置，已随本次采集固定；无需重复填写。修改宿主默认模型后请重新采集。</>:<>未能读取 DSH 默认模型；请在宿主配置默认模型后重新采集，或取消“使用 DSH 默认模型”手动指定。不会自动选择其他模型。</>}</p>:<div className="cr-route"><label>DSH 提供方 ID<input value={provider} placeholder="已在 DSH 配置的 provider ID" onChange={event=>{setProvider(event.target.value);setConsent(false);}}/></label><label>模型 ID<input value={model} placeholder="该提供方支持的 model ID" onChange={event=>{setModel(event.target.value);setConsent(false);}}/></label></div>}
  <p className="cr-hint">默认使用宿主配置，不跟随会话临时切换的聊天模型；只有确认发送并点击生成才调用模型。取消默认选项可手动覆盖，不修改宿主配置。</p>
  <label className="cr-check cr-consent"><input type="checkbox" checked={consent} disabled={expired||planDirty||!preview.analysisPlan} onChange={event=>setConsent(event.target.checked)}/> {single?'我确认向上方指定模型发送本次预算内摘要与所选片段（含文件名、路径与内容），理解未发送正文不属于模型全文分析，并确认一次请求可能计费':'我确认向上方指定模型发送本次差异及所选源码（含文件名、路径与内容），并确认分批调用可能多次计费'}</label>
  <div className="cr-actions"><button className="cr-primary" disabled={!!generateReason} onClick={onGenerate}>开始执行 · 生成报告</button><span>{generateReason||'也可直接导出下方证据清单，不调用模型；这不是发布报告，对外接口尚未分析。'}</span></div>
 </fieldset>;
}
function SingleRequestCoverage({coverage}){
 return <section className="cr-guide" aria-label="单次摘要覆盖范围"><strong>单次摘要分析 · 非模型全文覆盖</strong><p>本地完整统计：本地差异文本字节 {coverage.originalSourceBytes??'未提供'}（已解码 UTF-8 口径，非原始网络字节），完整文件清单 {coverage.fullManifestFiles??'未提供'} 个；发送文件专属元数据或片段 {coverage.sentFileCount??'未提供'} 个，其中实际发送正文片段 {coverage.sentTextFileCount??'未提供'} 个；完全未发送文件专属证据 {coverage.omittedFileCount??'未提供'} 个；生成物 {coverage.generatedFileCount??'未提供'} 个。</p><p>本地完整统计不等于模型全文覆盖。仅发送本地摘要及预算内明确选择的片段；未发送的正文无法据此宣称已分析，已发送文件也不代表其全文已发送。生成物可能只发送元数据，不据此推断接口或行为没有变化。</p></section>;
}
function ProgressSection({progress}){
 const counted=progress.total>0&&['collecting','analyzing','completed'].includes(progress.phase);
 return <section className="cr-progress" aria-label="执行进度"><div role="status" aria-live="polite">{progress.label}{counted?'（'+progress.completed+' / '+progress.total+'）':''}</div><progress aria-label="执行进度" max={progress.total||1} value={counted?progress.completed:undefined}/><p className="cr-hint">按实际完成的项目、文件或分片计数，不代表耗时比例；单次模型内部进度不可量化。</p></section>;
}
function ReportSection({result,onDownload,onClear}){
 const analysis=result.kind==='analysis',local=result.kind==='local';
 return <section className="cr-result"><div className="cr-actions"><h2>{analysis?'Markdown 报告':local?'采集证据（尚未生成发布报告）':'未分类结果（尚不能确认是发布报告）'}</h2><button onClick={onDownload}>{analysis?'下载 .md 文件':local?'下载证据清单 .md':'下载未分类结果 .md'}</button><button onClick={onClear}>{analysis?'清除报告':'清除证据结果'}</button></div>
  {!analysis&&<p className="cr-stale" role="status">{local?'仅采集完成，未调用模型；尚无改动解释、接口影响分析或测试建议。请核对上方默认模型和发送范围，明确确认后，点击“开始执行 · 生成报告”。':'结果类型未确认，不能据此认定已完成模型分析或发布报告。'}不会自动调用模型。</p>}
  {result.stale&&<p className="cr-stale" role="status">{analysis?'已有报告':'已有证据结果'}与当前草稿可能不同，旧结果已保留，可继续下载；重新采集后才用于当前范围分析。</p>}
  <p className="cr-hint">以下为安全排版的阅读视图，不执行报告中的 HTML、外部链接或图片；原始 Markdown 及内部附录可在下方展开检查；正式报告下载仅保留本次比较范围、改动内容、对外接口变更、影响范围、QA 测试范围五节，不含附录、额外章节或源码路径。模型建议需要人工复核，不代表测试已通过。结果仅在当前插件实例内按会话暂存当前报告及最近成功模型报告（最多 16 个会话，按会话数量淘汰；大报告更耗内存），刷新、重载或宿主重启前请下载；不写入浏览器本地存储。</p>
  {result.coverage?.strategy==='single-request'&&<SingleRequestCoverage coverage={result.coverage}/>}
  {result.coverage&&<><p role="status">{result.coverage.strategy==='single-request'?'已处理摘要证据':'已处理证据'} {result.coverage.processed??result.coverage.analyzed??0} / {result.coverage.total??0}；未处理 {result.coverage.remaining??0}；完成分片 {result.coverage.completedBatches??0} / {result.coverage.totalBatches??0}；被引用 {result.coverage.cited??0}。引用有效不代表结论正确，仍需人工复核。</p><details><summary>分析覆盖信息</summary><pre>{JSON.stringify(result.coverage,null,2)}</pre></details></>}<ReportDocument markdown={result.markdown}/><details className="cr-report-raw"><summary>查看原始 Markdown</summary><pre>{result.markdown}</pre></details>
 </section>;
}
