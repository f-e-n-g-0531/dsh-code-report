export function scanMessage(state){return state==='scanning'?'正在扫描工作区内的 Git / SVN 项目…':state==='failed'?'项目扫描失败，尚未确认项目数量。请查看上方错误，恢复连接后重新扫描。':state==='cancelled'?'项目扫描已取消，可重新扫描或手动添加。':state==='completed'?'当前扫描范围未发现项目，可手动添加。':'尚未扫描项目，请先打开带工作目录的会话。';}
export const fresh=()=>({path:'.',type:'git',a:'',b:'',branchA:'',branchB:'',enabled:true});
export function mergeRepositories(previous,discovered){
 const rows=previous.map(row=>({...row}));
 for(const found of discovered){const old=rows.find(row=>row.path===found.path&&row.type===found.type);if(old){if(!old.branchA)old.branchA=found.branch||'';if(!old.branchB)old.branchB=found.branch||'';}else if(rows.length<500)rows.push({...fresh(),...found,branchA:found.branch||'',branchB:found.branch||'',enabled:false});}
 return rows;
}
export function repositoryIssues(rows){
 const selected=rows.map((row,index)=>({row,index})).filter(({row})=>row.enabled);
 if(!selected.length)return ['请至少勾选一个项目。'];
 const issues=[];
 if(selected.length>12)issues.push('已选择 '+selected.length+' 个项目，一次最多 12 个，请取消多余项目。');
 for(const {row,index} of selected){const missing=missingFields(row);if(missing.length)issues.push(repositoryIssue(row,index,missing));}
 return issues;
}
function missingFields(row){
 const missing=[];
 if(!row.path.trim())missing.push('项目路径');
 if(row.type==='git'){
  if(!row.a.trim()&&!row.branchA.trim())missing.push('Git A 分支（版本留空时必填）');
  if(!row.b.trim()&&!row.branchB.trim())missing.push('Git B 分支（版本留空时必填）');
 }
 if(row.type==='svn'){
  if(!row.branchA.trim())missing.push('SVN A 分支');
  if(!row.branchB.trim())missing.push('SVN B 分支');
 }
 return missing;
}
function repositoryIssue(row,index,missing){return '项目 '+(index+1)+'（'+(row.path.trim()||'未填写路径')+'）：请填写 '+missing.join('、')+'。';}
export function readyRows(rows){return repositoryIssues(rows).length===0;}
