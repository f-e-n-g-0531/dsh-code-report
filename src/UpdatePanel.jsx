import React,{useEffect,useRef,useState} from 'react';
import {version as clientVersion} from '../package.json';
import {PROTOCOL_VERSION} from './protocol.mjs';
import {installUpdate} from './update-client.mjs';
export default function UpdatePanel({rpc,manager,reportBusy,onLock}){
 const [runtime,setRuntime]=useState(null),[runtimeFailed,setRuntimeFailed]=useState(false),[info,setInfo]=useState(null),[busy,setBusy]=useState(''),[notice,setNotice]=useState(''),[outcome,setOutcome]=useState(null),[confirmed,setConfirmed]=useState(false);const mounted=useRef(true),lock=useRef(false);
 useEffect(()=>{mounted.current=true;const ac=new AbortController();rpc('runtime-info',{},ac.signal).then(value=>{if(mounted.current)setRuntime(value);}).catch(e=>{if(mounted.current){setRuntimeFailed(true);setNotice(e.message);}});return()=>{mounted.current=false;ac.abort();};},[]);
 const check=async()=>{if(lock.current||reportBusy)return;lock.current=true;setBusy('正在检查更新');setNotice('');setConfirmed(false);try{const value=await rpc('check-update',{});if(mounted.current){setInfo(value);setRuntime(value);setRuntimeFailed(false);}}catch(e){if(mounted.current){setRuntimeFailed(true);setNotice(e.message);}}finally{lock.current=false;if(mounted.current)setBusy('');}};
 const update=async()=>{if(lock.current||reportBusy||!confirmed||!info)return;lock.current=true;setBusy('正在更新插件，请勿关闭页面');onLock(true);try{const result=await installUpdate(manager,info,{confirmed,requestId:crypto.randomUUID()});if(mounted.current){setOutcome(result);setConfirmed(false);}}catch(e){if(mounted.current)setNotice(e.message);}finally{lock.current=false;onLock(false);if(mounted.current)setBusy('');}};
 const terminal=outcome&&['restart-required','applied','unknown'].includes(outcome.state);
 return <aside className="cr-update" aria-label="插件版本与更新"><div className="cr-actions"><strong>插件更新</strong><span>界面版本：{clientVersion} · 后台版本：{runtime?.runningVersion||(runtimeFailed?'连接失败':'读取中')}</span><button disabled={!!busy||reportBusy||!!terminal} onClick={check}>检查更新</button></div>
 {runtime&&(runtime.runningVersion!==clientVersion||runtime.protocol!==PROTOCOL_VERSION)&&<p role="alert">界面与后台版本不一致。请先保存报告，再刷新页面；若仍不一致，请手动重启 DSH。</p>}
 {info&&!terminal&&<p>{info.available?'发现新版本 '+info.latestVersion:'当前运行版本没有更新的正式版本。'} <a href={info.releaseUrl} target="_blank" rel="noreferrer">查看版本说明</a></p>}
 {info?.available&&!terminal&&<><p>更新会修改当前 DSH 的插件安装环境。请先下载需要保留的报告，并备份 DSH 配置。更新已有插件通常需要手动重启，不会自动重启。</p><label><input type="checkbox" checked={confirmed} disabled={!!busy||reportBusy} onChange={e=>setConfirmed(e.target.checked)}/> 我确认将此插件更新到 {info.latestVersion}</label><button disabled={!confirmed||!!busy||reportBusy} onClick={update}>更新到 {info.latestVersion}</button></>}
 {busy&&<div role="status">{busy}<progress aria-label="更新进度"/></div>}{notice&&<p role="alert">{notice}</p>}{outcome&&<p role="status">{outcome.message}</p>}
 </aside>;
}
