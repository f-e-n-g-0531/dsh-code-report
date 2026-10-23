import assert from 'node:assert/strict';

// No mutation is retried here. A lost reply may mean the remote write succeeded.
export function createGitHubAdapter({repository,tag,sha,token,body,request=fetch,pageSize=100,maxPages=100}){
 assert.match(repository,/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/);
 assert.match(tag,/^v\d+\.\d+\.\d+$/);
 assert.match(sha,/^[a-f0-9]{40}$/);
 assert.ok(typeof token==='string'&&token,'Missing GitHub credential');
 assert.ok(Number.isInteger(pageSize)&&pageSize>=1&&pageSize<=100);
 assert.ok(Number.isInteger(maxPages)&&maxPages>=1&&maxPages<=100);
 const base='https://api.github.com/repos/'+repository;
 const id=value=>{assert.ok(Number.isSafeInteger(value)&&value>0,'Invalid GitHub identifier');return value;};
 async function api(url,options={},assetRedirect=false){
  const target=new URL(url);
  assert.ok(target.protocol==='https:'&&!target.username&&!target.password&&['api.github.com','uploads.github.com'].includes(target.host),'Untrusted GitHub URL');
  const method=options.method||'GET';
  try{
   const response=await request(target.href,{...options,redirect:assetRedirect?'manual':'error',headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','User-Agent':'dsh-code-report-release',...options.headers}});
   assert.ok(!response.redirected,'Unexpected GitHub redirect');
   assert.ok(response.ok||(assetRedirect&&response.status===302),'GitHub HTTP '+response.status);
   return response;
  }catch(cause){
   if(method==='GET')throw cause;
   const error=new Error('GitHub '+method+' result unknown; inspect remote state before rerunning',{cause});
   error.code='release/write-unknown';error.details={method};throw error;
  }
 }
 async function json(url,options){
  const response=await api(url,options);
  try{return await response.json();}catch(cause){
   if(!options?.method||options.method==='GET')throw cause;
   const error=new Error('GitHub write response unreadable; inspect remote state before rerunning',{cause});
   error.code='release/write-unknown';throw error;
  }
 }
 async function pages(url){
  const all=[];
  for(let page=1;page<=maxPages;page++){
   const rows=await json(url+'?per_page='+pageSize+'&page='+page);
   assert.ok(Array.isArray(rows),'Invalid paginated GitHub response');
   all.push(...rows);
   if(rows.length<pageSize)return all;
  }
  throw new Error('GitHub pagination incomplete; refusing mutation');
 }
 return {
  async verifyTag(){
   const ref=await json(base+'/git/ref/tags/'+encodeURIComponent(tag));
   let object=ref.object;
   for(let depth=0;object?.type==='tag'&&depth<5;depth++){
    assert.match(object.sha,/^[a-f0-9]{40}$/);
    object=(await json(base+'/git/tags/'+object.sha)).object;
   }
   assert.equal(object?.type,'commit','Tag did not resolve to commit');
   assert.equal(object.sha,sha,'tag SHA mismatch');
  },
  async lookup(){
   const matches=(await pages(base+'/releases')).filter(release=>release.tag_name===tag);
   assert.ok(matches.length<=1,'Duplicate releases for tag');
   return matches[0]||null;
  },
  create:()=>json(base+'/releases',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tag_name:tag,target_commitish:sha,name:tag,body,draft:true,prerelease:false})}),
  listAssets:release=>pages(base+'/releases/'+id(release.id)+'/assets'),
  async download(asset){
   let response=await api(base+'/releases/assets/'+id(asset.id),{headers:{Accept:'application/octet-stream'}},true);
   if(response.status===302){
    const target=new URL(response.headers.get('location')||'');
    assert.ok(target.protocol==='https:'&&target.host==='release-assets.githubusercontent.com'&&!target.username&&!target.password,'Untrusted GitHub asset redirect');
    // Signed asset URL needs no credential. Never forward the API bearer token.
    response=await request(target.href,{redirect:'error',headers:{Accept:'application/octet-stream'}});
    assert.ok(response.ok&&!response.redirected,'GitHub asset download failed');
   }
   return Buffer.from(await response.arrayBuffer());
  },
  upload:(release,file)=>json('https://uploads.github.com/repos/'+repository+'/releases/'+id(release.id)+'/assets?name='+encodeURIComponent(file.name),{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:file.bytes}),
  finalize:release=>json(base+'/releases/'+id(release.id),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({draft:false})})
 };
}
