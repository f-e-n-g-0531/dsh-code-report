export const fresh=()=>({path:'.',type:'git',a:'',b:'',branchA:'',branchB:'',enabled:true});
export function mergeRepositories(previous,discovered){
 const rows=previous.map(row=>({...row}));
 for(const found of discovered){const old=rows.find(row=>row.path===found.path&&row.type===found.type);if(old){if(!old.branchA)old.branchA=found.branch||'';if(!old.branchB)old.branchB=found.branch||'';}else rows.push({...fresh(),...found,branchA:found.branch||'',branchB:found.branch||'',enabled:false});}
 return rows;
}
export function readyRows(rows){const selected=rows.filter(r=>r.enabled);return selected.length>0&&selected.length<=12&&selected.every(r=>r.path&&r.a.trim()&&r.b.trim()&&(r.type!=='svn'||(r.branchA.trim()&&r.branchB.trim())));}
