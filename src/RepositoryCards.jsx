import React,{useState,useEffect,useRef} from 'react';
import {scanMessage,rowIssues,zeroDifferenceWarning} from './repositories.mjs';
import {bulkVersions} from './configuration.mjs';
export default function RepositoryCards({rows,change,remove,scanState,replace,loadRefs,refsDisabled}){
 const [query,setQuery]=useState(''),[onlySelected,setOnlySelected]=useState(false),[expandedRows,setExpandedRows]=useState([]);
 const toggle=index=>setExpandedRows(current=>current.includes(index)?current.filter(value=>value!==index):[...current,index]);
 const removeRow=index=>{setExpandedRows(current=>current.filter(value=>value!==index).map(value=>value>index?value-1:value));remove(index);};
 const [type,setType]=useState('git'),[a,setA]=useState(''),[b,setB]=useState(''),[branchA,setBranchA]=useState(''),[branchB,setBranchB]=useState(''),[emptyOnly,setEmptyOnly]=useState(true);
 const visible=rows.map((row,index)=>({row,index})).filter(({row})=>(!onlySelected||row.enabled)&&row.path.toLowerCase().includes(query.toLowerCase()));
 const firstError=rows.findIndex((_,index)=>rowIssues(rows,index).length);
 const locateError=()=>{setQuery('');setOnlySelected(false);setExpandedRows(current=>current.includes(firstError)?current:[...current,firstError]);requestAnimationFrame(()=>document.getElementById('cr-project-config-'+firstError)?.querySelector('input')?.focus());};
 return <div className="cr-repositories">
  <div className="cr-table-toolbar"><input aria-label="搜索项目路径" placeholder="搜索项目路径…" value={query} onChange={event=>setQuery(event.target.value)}/><label className="cr-selection"><input type="checkbox" checked={onlySelected} onChange={event=>setOnlySelected(event.target.checked)}/>仅看已选</label><span>{visible.length} / {rows.length} 项</span>{firstError>=0&&<button onClick={locateError}>定位首个错误项目</button>}</div>
  <details className="cr-bulk"><summary>批量填版本 · 应用到所有已勾选的同类型项目</summary>
   <div className="cr-bulk-fields"><label>类型<select value={type} onChange={event=>setType(event.target.value)}><option value="git">Git</option><option value="svn">SVN</option></select></label><label>A 基线<input value={a} placeholder={type==='git'?'main / v1.0':'r1200'} onChange={event=>setA(event.target.value)}/></label><label>B 目标<input value={b} placeholder={type==='git'?'HEAD / v1.1':'r1250'} onChange={event=>setB(event.target.value)}/></label><label>A 分支<input value={branchA} placeholder={type==='git'?'main':'trunk'} onChange={event=>setBranchA(event.target.value)}/></label><label>B 分支<input value={branchB} placeholder={type==='git'?'release':'branches/release'} onChange={event=>setBranchB(event.target.value)}/></label></div>
   <div className="cr-actions"><label className="cr-selection"><input type="checkbox" checked={emptyOnly} onChange={event=>setEmptyOnly(event.target.checked)}/>只填空白，不覆盖已有值</label><button disabled={!rows.some(row=>row.enabled&&row.type===type)||![a,b,branchA,branchB].some(value=>value.trim())} onClick={()=>replace(bulkVersions(rows,{type,a,b,branchA,branchB,emptyOnly}))}>应用到已选 {type.toUpperCase()} 项目</button></div>
   <p className="cr-hint">将影响全部 {rows.filter(row=>row.enabled&&row.type===type).length} 个已选 {type.toUpperCase()} 项目，不受搜索过滤影响。空白字段保持原值；不同仓库的版本和 SVN 分支可能不同，执行前逐行确认。</p>
  </details>
  {!rows.length?<div className="cr-empty">{scanMessage(scanState)}</div>:<div className="cr-table-scroll"><table className="cr-config-table"><thead><tr><th scope="col">纳入</th><th scope="col">项目路径 / 类型</th><th scope="col">A · 比较基线</th><th scope="col">B · 发布目标</th><th scope="col">操作</th></tr></thead><tbody>
   {visible.map(({row,index})=><RepositoryRow key={index} row={row} index={index} issues={rowIssues(rows,index)} warning={zeroDifferenceWarning(row)} change={change} remove={removeRow} loadRefs={loadRefs} refsDisabled={refsDisabled} expanded={expandedRows.includes(index)} toggle={()=>toggle(index)}/>)}
  </tbody></table>{!visible.length&&<p className="cr-empty">没有符合筛选条件的项目，已选项目不会因此取消。</p>}</div>}
 </div>;
}
export function comparisonSummary(row){
 const endpoint=side=>{const branch=(row[side==='a'?'branchA':'branchB']||'').trim()||'未填写分支',version=(row[side]||'').trim();return branch+' @ '+(version?(row.type==='svn'?'r'+version.replace(/^r/i,''):version):'最新提交');};
 return 'A：'+endpoint('a')+' → B：'+endpoint('b');
}
function RepositoryRow({row,index,issues,warning,change,remove,loadRefs,refsDisabled,expanded,toggle}){
 const [refs,setRefs]=useState([]),[loading,setLoading]=useState(false),[error,setError]=useState('');
 const request=useRef(null),mounted=useRef(true);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;request.current?.abort();};},[]);
 useEffect(()=>{request.current?.abort();setRefs([]);setError('');setLoading(false);},[row.path,row.type,row.gitMode,row.gitRemote]);
 const refreshRefs=async()=>{
  if(!loadRefs||loading)return;
  request.current?.abort();const ac=new AbortController();request.current=ac;setLoading(true);setError('');
  try{const value=await loadRefs(row.path,ac.signal,{gitMode:row.gitMode??'remote',gitRemote:row.gitRemote??'origin'});if(!ac.signal.aborted&&mounted.current)setRefs(value);}
  catch(error){if(!ac.signal.aborted&&mounted.current)setError(error.message);}
  finally{if(!ac.signal.aborted&&mounted.current)setLoading(false);}
 };
 const listId='cr-refs-'+index,issueId='cr-issues-'+index,remote=(row.gitMode??'remote')==='remote';
 return <tr id={'cr-row-'+index} className="cr-project-card" data-selected={row.enabled} data-expanded={expanded}>
  <td className="cr-project-select"><label className="cr-selection"><input type="checkbox" checked={row.enabled} aria-label={'纳入项目 '+(index+1)} onChange={event=>change(index,'enabled',event.target.checked)}/><span>项目 {String(index+1).padStart(2,'0')}</span></label><span className={'cr-vcs-badge cr-'+row.type}>{row.type.toUpperCase()}</span><button type="button" className="cr-project-toggle" aria-label={(expanded?'收起项目 ':'展开项目 ')+(index+1)} aria-expanded={expanded} aria-controls={['cr-project-config-'+index,'cr-project-a-'+index,'cr-project-b-'+index].join(' ')} onClick={toggle}><span aria-hidden="true">{expanded?'▾':'▸'}</span><span className="cr-project-heading"><span className="cr-project-name">{row.path||'未填写项目路径'}</span>{!expanded&&<span className="cr-project-comparison" aria-label={'项目版本对比 '+(index+1)}>{comparisonSummary(row)}</span>}</span><span className="cr-project-toggle-hint">{expanded?'收起':'展开'}</span></button>{!!issues.length&&<span className="cr-project-error">{issues.length} 项错误</span>}</td>
  <td className="cr-project-config" id={'cr-project-config-'+index} hidden={!expanded}>
   {expanded&&<><div className="cr-project-fields"><label className="cr-project-path">项目路径<input value={row.path} aria-label={'项目路径 '+(index+1)} aria-invalid={issues.length>0} aria-describedby={issues.length?issueId:undefined} placeholder="相对于工作区" onChange={event=>change(index,'path',event.target.value)}/></label><label>版本控制<select value={row.type} aria-label={'VCS '+(index+1)} onChange={event=>change(index,'type',event.target.value)}><option value="git">Git</option><option value="svn">SVN</option></select></label>
   {row.type==='git'&&<><label>读取方式<select aria-label={'Git 读取方式 '+(index+1)} value={row.gitMode??'remote'} onChange={event=>change(index,'gitMode',event.target.value)}><option value="remote">远端实时读取</option><option value="local">本地离线</option></select></label>{remote&&<label>远端配置名<input aria-label={'Git 远端名 '+(index+1)} value={row.gitRemote??'origin'} placeholder="origin（非 URL）" onChange={event=>change(index,'gitRemote',event.target.value)}/></label>}</>}
   </div>
   {!!issues.length&&<ul className="cr-row-issues" id={issueId}>{issues.map((text,i)=><li key={i}>{text}</li>)}</ul>}
   {warning&&<p className="cr-card-hint">{warning}</p>}
   {row.type==='git'&&<div className="cr-source-notice" data-remote={remote}>
    <p>{remote?'选择远端方式即允许访问该配置远端。查询和采集会联网并可能要求身份验证；失败不会回退本地。':'仅使用本地已有引用和对象，离线读取，不自动 fetch。'}</p>
    {remote&&<details><summary>隔离读取说明</summary><p>采集在隔离临时目录完整抓取，不创建业务本地分支、不修改业务 refs 或工作区。失败不会回退本地。</p></details>}
    <div className="cr-ref-actions"><button disabled={refsDisabled||loading||!row.path.trim()} onClick={refreshRefs}>{loading?(remote?'读取远端 refs…':'读取本地 refs…'):(remote?'读取远端分支/标签':'读取本地分支/标签')}</button><datalist id={listId}>{refs.map(ref=><option key={ref} value={ref}/>)}</datalist>{refs.length>0&&<p className="cr-hint">已载入 {refs.length} 个{remote?'远端':'本地'}引用，在 A/B 输入中选择；{remote?'此次查询观察值，采集时会重新获取。':'不会 fetch。'}</p>}</div>
    {error&&<p className="cr-row-issues" role="alert">{error}</p>}
   </div>}</>}
  </td>
  {['a','b'].map((side,i)=><td className="cr-project-endpoint" id={'cr-project-'+side+'-'+index} hidden={!expanded} key={side} data-label={i?'B · 发布目标':'A · 比较基线'}>
   {expanded&&<><div className="cr-endpoint-title"><span aria-hidden="true">{side.toUpperCase()}</span><strong>{i?'发布目标':'比较基线'}</strong><small>{i?'TARGET':'BASELINE'}</small></div>
   <label>分支<input aria-label={row.type.toUpperCase()+' 分支 '+side.toUpperCase()+' '+(index+1)} value={row[i?'branchB':'branchA']} list={row.type==='git'?listId:undefined} placeholder={row.type==='git'?'分支，如 main / release':'仓库分支路径'} onChange={event=>change(index,i?'branchB':'branchA',event.target.value)}/></label>
   <label>版本 <span className="cr-field-optional">可选</span><input aria-label={'版本 '+side.toUpperCase()+' '+(index+1)} value={row[side]} list={row.type==='git'?listId:undefined} placeholder={row.type==='git'?'留空：此分支最新提交；或 SHA / 标签':'留空：此分支最新提交；或 r 版本'} onChange={event=>change(index,side,event.target.value)}/></label>
  </>}</td>)}
  <td className="cr-project-remove"><button className="cr-danger-ghost" onClick={()=>remove(index)} aria-label={'移除项目 '+(index+1)}>移除</button></td>
 </tr>;
}
