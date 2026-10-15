import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {ensureNpm,ensureGithub,digest} from './release-core.mjs';
const pkg=JSON.parse(await readFile('package.json','utf8'));const tag='v'+pkg.version;
assert.equal(process.env.GITHUB_REF_NAME,tag);assert.ok((process.env.GITHUB_REPOSITORY||'').split('/').length===2&&(process.env.GITHUB_REPOSITORY||'').split('/').every(part=>/^[a-zA-Z0-9_.-]+$/.test(part)));
const repo=process.env.GITHUB_REPOSITORY;const sha=process.env.GITHUB_SHA;assert.match(sha||'',/^[a-f0-9]{40}$/);
const sum=await readFile('release/SHA256SUMS.txt');const [expected,name]=sum.toString().trim().split(/\s+/);assert.match(name||'',/^[a-zA-Z0-9._-]+[.]tgz$/);
const archive=await readFile('release/'+name);assert.equal(digest(archive),expected);
const request=async(url,options={})=>fetch(url,{...options,signal:AbortSignal.timeout(30000)});
const lookupNpm=async()=>{const response=await request('https://registry.npmjs.org/'+encodeURIComponent(pkg.name)+'/'+pkg.version,{headers:{Accept:'application/json','Cache-Control':'no-cache'},redirect:'error'});if(response.status===404)return null;assert.equal(response.status,200,'npm metadata status');const meta=await response.json();assert.equal(meta.name,pkg.name);assert.equal(meta.version,pkg.version);const url=new URL(meta.dist.tarball);assert.equal(url.origin,'https://registry.npmjs.org');const result=await request(url,{redirect:'error'});if(result.status===404)return null;assert.equal(result.status,200,'npm tarball status');return Buffer.from(await result.arrayBuffer());};
const mode=process.argv[2];
if(mode==='npm'){
 await ensureNpm({archive,lookup:lookupNpm,publish:async()=>{assert.ok(process.env.NODE_AUTH_TOKEN,'Missing npm credential');const result=spawnSync('npm',['publish','./release/'+name,'--ignore-scripts','--access','public','--registry','https://registry.npmjs.org/'],{stdio:'inherit',timeout:180000});if(result.error)throw result.error;assert.equal(result.status,0,'npm publish failed; inspect before retry');}});console.log('npm artifact verified',expected);
}else if(mode==='github'){
 const found=await lookupNpm();assert.ok(found,'npm artifact missing');assert.equal(digest(found),expected,'npm mismatch');
 const token=process.env.GH_TOKEN;assert.ok(token,'Missing GitHub credential');const base='https://api.github.com/repos/'+repo;
 const api=async(url,options={})=>{assert.ok(['api.github.com','uploads.github.com'].includes(new URL(url).hostname),'untrusted GitHub URL');return request(url,{...options,headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','User-Agent':'dsh-code-report-release',...options.headers}});};
 const json=async(url,options={})=>{const r=await api(url,options);assert.ok(r.ok,'GitHub HTTP '+r.status);return r.json();};
 const ref=await json(base+'/git/ref/tags/'+tag);let object=ref.object;for(let i=0;object.type==='tag'&&i<5;i++)object=(await json(base+'/git/tags/'+object.sha)).object;assert.equal(object.type,'commit');assert.equal(object.sha,sha,'tag SHA mismatch');
 const body=await readFile('RELEASE-NOTES.md','utf8');
 const lookup=async()=>{for(let page=1;page<=100;page++){const list=await json(base+'/releases?per_page=100&page='+page);const matches=list.filter(r=>r.tag_name===tag);assert.ok(matches.length<=1);if(matches.length)return matches[0];if(list.length<100)return null;}throw new Error('release lookup incomplete');};
 const listAssets=async release=>{const all=[];for(let page=1;page<=100;page++){const list=await json(base+'/releases/'+release.id+'/assets?per_page=100&page='+page);all.push(...list);if(list.length<100)return all;}throw new Error('asset lookup incomplete');};
 await ensureGithub({tag,sha,files:[{name,bytes:archive},{name:'SHA256SUMS.txt',bytes:sum}],lookup,listAssets,
 create:async()=>json(base+'/releases',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tag_name:tag,target_commitish:sha,name:tag,body,draft:true,prerelease:false})}),
 download:async asset=>{const r=await api(base+'/releases/assets/'+asset.id,{headers:{Accept:'application/octet-stream'}});assert.ok(r.ok,'asset download failed');return Buffer.from(await r.arrayBuffer());},
 upload:async(release,file)=>json('https://uploads.github.com/repos/'+repo+'/releases/'+release.id+'/assets?name='+encodeURIComponent(file.name),{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:file.bytes}),
 finalize:async release=>json(base+'/releases/'+release.id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({draft:false})})});console.log('GitHub release verified',tag);
}else throw new Error('Expected npm or github mode');
