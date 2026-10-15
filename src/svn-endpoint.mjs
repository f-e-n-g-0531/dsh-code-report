// Branches are repository-root-relative paths, never arbitrary URLs.
export function svnRevision(value){
 if(typeof value!=='string'||!/^r?\d+$/i.test(value)||value.length>32)throw new Error('SVN 版本请填写 r123 或数字 123');
 return String(BigInt(value.replace(/^r/i,'')));
}
export function svnBranch(value){
 if(typeof value!=='string'||!value.trim()||value.length>2048)throw new Error('请填写 SVN 分支路径，例如 trunk 或 branches/release');
 const branch=value.trim();
 if(branch==='.')return branch;
 if(/[\x00-\x1f\x7f:%@?#\\]/.test(branch)||branch.startsWith('/')||branch.split('/').some(x=>!x||x==='.'||x==='..'))throw new Error('SVN 分支必须是仓库根目录下的路径，不能填写 URL 或上级路径');
 return branch;
}
export function branchUrl(repositoryRoot,currentUrl,branch){
 const value=svnBranch(branch);if(value==='.')return currentUrl;
 return repositoryRoot.replace(/\/$/,'')+'/'+value.split('/').map(encodeURIComponent).join('/');
}
