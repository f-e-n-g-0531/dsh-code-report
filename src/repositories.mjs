export function scanMessage(state){return state==='scanning'?'正在扫描工作区内的 Git / SVN 项目…':state==='failed'?'项目扫描失败，尚未确认项目数量。请查看上方错误，恢复连接后重新扫描。':state==='cancelled'?'项目扫描已取消，可重新扫描或手动添加。':state==='completed'?'当前扫描范围未发现项目，可手动添加。':'尚未扫描项目，请先打开带工作目录的会话。';}
export const fresh=()=>({path:'.',type:'git',a:'',b:'',branchA:'',branchB:'',enabled:true});
export function mergeRepositories(previous,discovered){
 const rows=previous.map(row=>({...row}));
 for(const found of discovered){const old=rows.find(row=>row.path===found.path&&row.type===found.type);if(old){if(!old.branchA)old.branchA=found.branch||'';if(!old.branchB)old.branchB=found.branch||'';}else if(rows.length<500)rows.push({...fresh(),...found,branchA:found.branch||'',branchB:found.branch||'',enabled:false});}
 return rows;
}
export function readyRows(rows){const selected=rows.filter(r=>r.enabled);return selected.length>0&&selected.length<=12&&selected.every(r=>r.path&&r.a.trim()&&r.b.trim()&&(r.type!=='svn'||(r.branchA.trim()&&r.branchB.trim())));}
