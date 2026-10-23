import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {ensureNpm,ensureGithub,digest,createNpmLookup,waitForNpm} from './release-core.mjs';
import {createGitHubAdapter} from './release-transport.mjs';
const pkg=JSON.parse(await readFile('package.json','utf8'));const tag='v'+pkg.version;
assert.equal(process.env.GITHUB_REF_NAME,tag);assert.ok((process.env.GITHUB_REPOSITORY||'').split('/').length===2&&(process.env.GITHUB_REPOSITORY||'').split('/').every(part=>/^[a-zA-Z0-9_.-]+$/.test(part)));
const repo=process.env.GITHUB_REPOSITORY;const sha=process.env.GITHUB_SHA;assert.match(sha||'',/^[a-f0-9]{40}$/);
const sum=await readFile('release/SHA256SUMS.txt');const [expected,name]=sum.toString().trim().split(/\s+/);assert.match(name||'',/^[a-zA-Z0-9._-]+[.]tgz$/);
const archive=await readFile('release/'+name);assert.equal(digest(archive),expected);
const request=async(url,options={})=>fetch(url,{...options,signal:AbortSignal.timeout(30000)});
const lookupNpm=createNpmLookup(pkg,request);
const mode=process.argv[2];
if(mode==='npm'){
 await ensureNpm({archive,lookup:lookupNpm,publish:async()=>{assert.ok(process.env.NODE_AUTH_TOKEN,'Missing npm credential');const result=spawnSync('npm',['publish','./release/'+name,'--ignore-scripts','--access','public','--registry','https://registry.npmjs.org/'],{stdio:'inherit',timeout:180000});if(result.error)throw result.error;assert.equal(result.status,0,'npm publish failed; inspect before retry');}});console.log('npm artifact verified',expected);
}else if(mode==='github'){
 await waitForNpm({lookup:lookupNpm,archive});
 const adapter=createGitHubAdapter({repository:repo,tag,sha,token:process.env.GH_TOKEN,body:await readFile('RELEASE-NOTES.md','utf8'),request});
 await adapter.verifyTag();
 await ensureGithub({...adapter,tag,sha,files:[{name,bytes:archive},{name:'SHA256SUMS.txt',bytes:sum}]});
 console.log('GitHub release verified',tag);
}else throw new Error('Expected npm or github mode');
