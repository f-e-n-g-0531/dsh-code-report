import test from 'node:test';
import assert from 'node:assert/strict';
import {createGitHubAdapter} from '../scripts/release-transport.mjs';
import {ensureGithub,createNpmLookup} from '../scripts/release-core.mjs';

const sha='a'.repeat(40),tag='v1.0.0',bytes=Buffer.from('verified package');
function fixture({lose,corrupt=false,status,tagSha=sha,pageSize=2,maxPages=10}={}){
 let release=null,nextId=10,lost=false;
 const assets=[],calls=[],mutations=[];
 const request=async(value,options={})=>{
  const url=new URL(value),method=options.method||'GET';calls.push({url,method,options});
  assert.equal(options.redirect,url.pathname.includes('/releases/assets/')?'manual':'error');assert.equal(options.headers.Authorization,'Bearer fixture-token');
  if(status)return new Response('',{status});
  let result,action;
  if(url.pathname.endsWith('/git/ref/tags/'+tag))result={object:{type:'tag',sha:'b'.repeat(40)}};
  else if(url.pathname.endsWith('/git/tags/'+'b'.repeat(40)))result={object:{type:'commit',sha:tagSha}};
  else if(method==='GET'&&url.pathname.endsWith('/releases')){
   const rows=[{id:1,tag_name:'other-1'},{id:2,tag_name:'other-2'},...(release?[release]:[])];
   const offset=(Number(url.searchParams.get('page'))-1)*pageSize;result=rows.slice(offset,offset+pageSize);
  }else if(method==='POST'&&url.pathname.endsWith('/releases')){
   action='create';assert.equal(JSON.parse(options.body).target_commitish,sha);release={id:3,tag_name:tag,prerelease:false,draft:true};result=release;
  }else if(method==='GET'&&url.pathname.endsWith('/assets')){
   const offset=(Number(url.searchParams.get('page'))-1)*pageSize;result=assets.slice(offset,offset+pageSize);
  }else if(method==='POST'&&url.hostname==='uploads.github.com'){
   action='upload';result={id:nextId++,name:url.searchParams.get('name'),bytes:Buffer.from(options.body)};assets.push(result);
  }else if(method==='GET'&&url.pathname.includes('/releases/assets/')){
   assert.equal(options.headers.Accept,'application/octet-stream');const asset=assets.find(item=>item.id===Number(url.pathname.split('/').at(-1)));
   return new Response(corrupt?'corrupt':asset.bytes);
  }else if(method==='PATCH'){action='finalize';release.draft=false;result=release;}
  else throw new Error('Unexpected fixture request: '+method+' '+url);
  if(action){mutations.push(action);if(lose===action&&!lost){lost=true;throw new Error('reply lost after remote write');}}
  return Response.json(result);
 };
 const adapter=createGitHubAdapter({repository:'owner/project',tag,sha,token:'fixture-token',body:'notes',request,pageSize,maxPages});
 const run=async()=>{await adapter.verifyTag();return ensureGithub({...adapter,tag,sha,files:[{name:'package.tgz',bytes},{name:'SHA256SUMS.txt',bytes:Buffer.from('checksum')}]});};
 return {adapter,run,assets,calls,mutations,get release(){return release;}};
}

test('HTTP adapter dereferences tags, paginates and verifies uploaded bytes before finalizing',async()=>{
 const f=fixture({pageSize:1});await f.run();
 assert.equal(f.release.draft,false);assert.equal(f.assets.length,2);
 assert.ok(f.calls.some(call=>call.url.searchParams.get('page')==='3'));
 assert.deepEqual(f.mutations,['create','upload','upload','finalize']);
 await f.run();assert.deepEqual(f.mutations,['create','upload','upload','finalize']);
});
for(const action of ['create','upload','finalize'])test('lost '+action+' reply stops then rerun reconciles without duplicate mutation',async()=>{
 const f=fixture({lose:action});await assert.rejects(f.run(),error=>error.code==='release/write-unknown');
 const before=f.mutations.filter(item=>item===action).length;assert.equal(before,1);
 await f.run();assert.equal(f.mutations.filter(item=>item===action).length,action==='upload'?2:1);
 assert.equal(f.assets.length,2);assert.equal(f.release.draft,false);
});
test('corrupted asset readback never finalizes or overwrites',async()=>{
 const f=fixture({corrupt:true});await assert.rejects(f.run(),/bytes mismatch/);
 assert.equal(f.release.draft,true);assert.equal(f.assets.length,1);assert.ok(!f.mutations.includes('finalize'));
 await assert.rejects(f.run(),/bytes mismatch/);assert.equal(f.assets.length,1);
});
test('wrong tag commit and incomplete pagination stop before writes',async()=>{
 const wrong=fixture({tagSha:'c'.repeat(40)});await assert.rejects(wrong.run(),/tag SHA mismatch/);assert.equal(wrong.mutations.length,0);
 const truncated=fixture({pageSize:1,maxPages:1});await assert.rejects(truncated.run(),/pagination incomplete/);assert.equal(truncated.mutations.length,0);
});
for(const status of [401,403,429,500])test('GitHub HTTP '+status+' is not treated as absent or retried',async()=>{
 const f=fixture({status});await assert.rejects(f.run(),new RegExp('HTTP '+status));assert.equal(f.calls.length,1);assert.equal(f.mutations.length,0);
});
test('duplicate release and asset entries fail closed',async()=>{
 const adapter=createGitHubAdapter({repository:'a/b',tag,sha,token:'t',request:async()=>Response.json([{tag_name:tag},{tag_name:tag}])});
 await assert.rejects(adapter.lookup(),/Duplicate releases/);
 const f=fixture();await f.run();f.assets.push({...f.assets[0]});await assert.rejects(f.run(),/duplicate release asset/);
 assert.equal(f.mutations.filter(action=>action==='finalize').length,1);
});
test('npm lookup rejects untrusted tarball origins before downloading',async()=>{
 let calls=0;const lookup=createNpmLookup({name:'fixture',version:'1.0.0'},async()=>{calls++;return Response.json({name:'fixture',version:'1.0.0',dist:{tarball:'https://evil.invalid/pkg.tgz'}});});
 await assert.rejects(lookup);assert.equal(calls,1);
});

test('asset download follows one trusted signed redirect without forwarding bearer credentials',async()=>{
 const calls=[];
 const adapter=createGitHubAdapter({repository:'a/b',tag,sha,token:'private-token',request:async(url,options)=>{
  calls.push({url,options});
  if(calls.length===1)return new Response(null,{status:302,headers:{location:'https://release-assets.githubusercontent.com/path/file?signature=fixture'}});
  return new Response(bytes);
 }});
 assert.deepEqual(await adapter.download({id:10}),bytes);
 assert.equal(calls.length,2);assert.equal(calls[0].options.redirect,'manual');
 assert.equal(calls[0].options.headers.Authorization,'Bearer private-token');
 assert.equal(calls[1].options.redirect,'error');assert.equal(calls[1].options.headers.Authorization,undefined);
});
for(const location of ['https://evil.invalid/file','http://release-assets.githubusercontent.com/file','https://token@release-assets.githubusercontent.com/file','https://release-assets.githubusercontent.com.evil.invalid/file','https://release-assets.githubusercontent.com:444/file'])test('asset redirect rejects untrusted target '+location,async()=>{
 let calls=0;
 const adapter=createGitHubAdapter({repository:'a/b',tag,sha,token:'t',request:async()=>{calls++;return new Response(null,{status:302,headers:{location}});}});
 await assert.rejects(adapter.download({id:10}),/Untrusted GitHub asset redirect/);assert.equal(calls,1);
});
test('asset download does not follow a second redirect',async()=>{
 let calls=0;
 const adapter=createGitHubAdapter({repository:'a/b',tag,sha,token:'t',request:async()=>{calls++;return new Response(null,{status:302,headers:{location:'https://release-assets.githubusercontent.com/path'}});}});
 await assert.rejects(adapter.download({id:10}),/asset download failed/);assert.equal(calls,2);
});
