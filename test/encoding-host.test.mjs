import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createHandler} from '../src/host.mjs';
import {run} from '../src/process.mjs';

test('GBK source preview shows raw provenance and only approved decoded bytes reach mock model',async t=>{
 const cwd=await mkdtemp(path.join(tmpdir(),'report-encoding-host-'));t.after(()=>rm(cwd,{recursive:true,force:true}));
 const root=path.join(cwd,'repo');await mkdir(root);const git=args=>run('git',args,{cwd:root});
 await git(['init']);await git(['config','user.name','Fixture']);await git(['config','user.email','fixture@example.invalid']);
 const raw=Buffer.from('d6d0cec40a','hex');await writeFile(path.join(root,'source.cpp'),raw);await git(['add','.']);await git(['commit','-m','base']);
 const revision=(await git(['rev-parse','HEAD'])).trim();const inputs=[];
 const handler=createHandler({sessions:new Map([['s',{header:{cwd}}]]),llm:{async *stream(input){inputs.push(JSON.parse(input.messages[0].content[0].text));yield {type:'text-delta',text:JSON.stringify({changes:[],interfaces:[],impacts:[],qa:[],unknowns:[]})};yield {type:'finish',reason:{kind:'stop'}};}}});
 const response=await handler('preview',{sessionId:'s',operationId:'encoding-preview',request:{repositories:[{path:'repo',type:'git',a:revision,b:revision}],contextPaths:['repo/source.cpp']}});
 assert.equal(response.ok,true,JSON.stringify(response));const p=response.value;const item=p.context[0];
 assert.equal(item.encoding,'gb18030');assert.equal(item.hash,createHash('sha256').update(raw).digest('hex'));assert.equal(item.rawHash,item.hash);assert.ok(!Object.hasOwn(item,'text'));
 assert.match(p.markdown,/编码 gb18030/);assert.match(p.markdown,/原始字节 SHA-256/);assert.ok(p.limitations.some(s=>s.includes('GB18030')));assert.equal(inputs.length,0);
 const payload={sessionId:'s',operationId:'encoding-consent',previewId:p.previewId,planId:p.analysisPlan.id,route:{provider:'fixture',model:'mock'},sendToModel:false};
 assert.equal((await handler('generate',payload)).error.code,'code-report/consent-required');assert.equal(inputs.length,0);
 await writeFile(path.join(root,'source.cpp'),'unapproved');
 const generated=await handler('generate',{...payload,operationId:'encoding-generate',sendToModel:true});assert.equal(generated.ok,true,JSON.stringify(generated));
 assert.match(JSON.stringify(inputs),/中文/);assert.doesNotMatch(JSON.stringify(inputs),/unapproved|�/);
});
