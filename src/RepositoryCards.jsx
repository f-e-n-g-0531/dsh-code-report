import React,{useState,useEffect,useRef} from 'react';
import {scanMessage,rowIssues,zeroDifferenceWarning} from './repositories.mjs';
import {bulkVersions} from './configuration.mjs';
export default function RepositoryCards({rows,change,remove,scanState,replace,loadRefs,refsDisabled}){
 const [query,setQuery]=useState(''),[onlySelected,setOnlySelected]=useState(false);
 const [type,setType]=useState('git'),[a,setA]=useState(''),[b,setB]=useState(''),[branchA,setBranchA]=useState(''),[branchB,setBranchB]=useState(''),[emptyOnly,setEmptyOnly]=useState(true);
 const visible=rows.map((row,index)=>({row,index})).filter(({row})=>(!onlySelected||row.enabled)&&row.path.toLowerCase().includes(query.toLowerCase()));
 const firstError=rows.findIndex((_,index)=>rowIssues(rows,index).length);
 const locateError=()=>{setQuery('');setOnlySelected(false);requestAnimationFrame(()=>document.getElementById('cr-row-'+firstError)?.querySelector('input')?.focus());};
 return <div className="cr-repositories">
  <div className="cr-table-toolbar"><input aria-label="搜索项目路径" placeholder="搜索项目路径…" value={query} onChange={event=>setQuery(event.target.value)}/><label className="cr-selection"><input type="checkbox" checked={onlySelected} onChange={event=>setOnlySelected(event.target.checked)}/>仅看已选</label><span>{visible.length} / {rows.length} 项</span>{firstError>=0&&<button onClick={locateError}>定位首个错误项目</button>}</div>
  <details className="cr-bulk"><summary>批量填版本 · 应用到所有已勾选的同类型项目</summary>
   <div className="cr-bulk-fields"><label>类型<select value={type} onChange={event=>setType(event.target.value)}><option value="git">Git</option><option value="svn">SVN</option></select></label><label>A 基线<input value={a} placeholder={type==='git'?'main / v1.0':'r1200'} onChange={event=>setA(event.target.value)}/></label><label>B 目标<input value={b} placeholder={type==='git'?'HEAD / v1.1':'r1250'} onChange={event=>setB(event.target.value)}/></label><label>A 分支<input value={branchA} placeholder={type==='git'?'main':'trunk'} onChange={event=>setBranchA(event.target.value)}/></label><label>B 分支<input value={branchB} placeholder={type==='git'?'release':'branches/release'} onChange={event=>setBranchB(event.target.value)}/></label></div>
   <div className="cr-actions"><label className="cr-selection"><input type="checkbox" checked={emptyOnly} onChange={event=>setEmptyOnly(event.target.checked)}/>只填空白，不覆盖已有值</label><button disabled={!rows.some(row=>row.enabled&&row.type===type)||![a,b,branchA,branchB].some(value=>value.trim())} onClick={()=>replace(bulkVersions(rows,{type,a,b,branchA,branchB,emptyOnly}))}>应用到已选 {type.toUpperCase()} 项目</button></div>
   <p className="cr-hint">将影响全部 {rows.filter(row=>row.enabled&&row.type===type).length} 个已选 {type.toUpperCase()} 项目，不受搜索过滤影响。空白字段保持原值；不同仓库的版本和 SVN 分支可能不同，执行前逐行确认。</p>
  </details>
  {!rows.length?<div className="cr-empty">{scanMessage(scanState)}</div>:<div className="cr-table-scroll"><table className="cr-config-table"><thead><tr><th scope="col">纳入</th><th scope="col">项目路径 / 类型</th><th scope="col">A · 比较基线</th><th scope="col">B · 发布目标</th><th scope="col">操作</th></tr></thead><tbody>
   {visible.map(({row,index})=><RepositoryRow key={index} row={row} index={index} issues={rowIssues(rows,index)} warning={zeroDifferenceWarning(row)} change={change} remove={remove} loadRefs={loadRefs} refsDisabled={refsDisabled}/>)}
  </tbody></table>{!visible.length&&<p className="cr-empty">没有符合筛选条件的项目，已选项目不会因此取消。</p>}</div>}
 </div>;
}
function RepositoryRow({row,index,issues,warning,change,remove,loadRefs,refsDisabled}){
 const [refs,setRefs]=useState([]),[loading,setLoading]=useState(false),[error,setError]=useState('');
 const request=useRef(null),mounted=useRef(true);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;request.current?.abort();};},[]);
 useEffect(()=>{request.current?.abort();setRefs([]);setError('');setLoading(false);},[row.path,row.type]);
 const refreshRefs=async()=>{
  if(!loadRefs||loading)return;
  request.current?.abort();const ac=new AbortController();request.current=ac;setLoading(true);setError('');
  try{const value=await loadRefs(row.path,ac.signal);if(!ac.signal.aborted&&mounted.current)setRefs(value);}
  catch(error){if(!ac.signal.aborted&&mounted.current)setError(error.message);}
  finally{if(!ac.signal.aborted&&mounted.current)setLoading(false);}
 };
 const listId='cr-refs-'+index,issueId='cr-issues-'+index;
 return <tr id={'cr-row-'+index} data-selected={row.enabled}>
  <td><input type="checkbox" checked={row.enabled} aria-label={'纳入项目 '+(index+1)} onChange={event=>change(index,'enabled',event.target.checked)}/></td>
  <td><input value={row.path} aria-label={'项目路径 '+(index+1)} aria-invalid={issues.length>0} aria-describedby={issues.length?issueId:undefined} placeholder="相对于工作区" onChange={event=>change(index,'path',event.target.value)}/><select value={row.type} aria-label={'VCS '+(index+1)} onChange={event=>change(index,'type',event.target.value)}><option value="git">Git</option><option value="svn">SVN</option></select>
   {!!issues.length&&<ul className="cr-row-issues" id={issueId}>{issues.map((text,i)=><li key={i}>{text}</li>)}</ul>}
   {warning&&<p className="cr-hint">{warning}</p>}
   {row.type==='git'&&<><button disabled={refsDisabled||loading||!row.path.trim()} onClick={refreshRefs}>{loading?'读取本地 refs…':'读取本地分支/标签'}</button><datalist id={listId}>{refs.map(ref=><option key={ref} value={ref}/>)}</datalist>{refs.length>0&&<p className="cr-hint">已载入 {refs.length} 个本地引用，在 A/B 输入中选择；不会 fetch。</p>}{error&&<p className="cr-row-issues" role="alert">{error}</p>}</>}
  </td>
  {['a','b'].map((side,i)=><td key={side} data-label={i?'B · 发布目标':'A · 比较基线'}>
   <input aria-label={row.type.toUpperCase()+' 分支 '+side.toUpperCase()+' '+(index+1)} value={row[i?'branchB':'branchA']} list={row.type==='git'?listId:undefined} placeholder={row.type==='git'?'分支，如 main / release':'仓库分支路径'} onChange={event=>change(index,i?'branchB':'branchA',event.target.value)}/>
   <input aria-label={'版本 '+side.toUpperCase()+' '+(index+1)} value={row[side]} list={row.type==='git'?listId:undefined} placeholder={row.type==='git'?'留空：此分支最新提交；或 SHA / 标签':'留空：此分支最新提交；或 r 版本'} onChange={event=>change(index,side,event.target.value)}/>
  </td>)}
  <td><button onClick={()=>remove(index)} aria-label={'移除项目 '+(index+1)}>移除</button></td>
 </tr>;
}
