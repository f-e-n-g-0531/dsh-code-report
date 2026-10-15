import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {npm} from './npm.mjs';
const root=process.cwd(),pkg=JSON.parse(await readFile('package.json','utf8'));
const [digest,filename]=(await readFile('release/SHA256SUMS.txt','utf8')).trim().split(/\s+/);const archive=path.join(root,'release',filename);assert.equal(createHash('sha256').update(await readFile(archive)).digest('hex'),digest);
const temp=await mkdtemp(path.join(tmpdir(),'dsh-report-install-'));
try{
 await writeFile(path.join(temp,'package.json'),'{"private":true}');npm(['install','--ignore-scripts','--omit=dev','--no-audit','--no-fund',archive],temp);
 const installed=path.join(temp,'node_modules',...pkg.name.split('/'));const manifest=JSON.parse(await readFile(path.join(installed,'package.json'),'utf8'));assert.equal(manifest.version,pkg.version);
 const plugin=await import(pathToFileURL(path.join(installed,'index.mjs')));let handler;
 const ctx={connection:{register(owner,channel,fn){assert.equal(owner,ctx);assert.equal(channel,'/code-report-rpc');handler=fn;}}};plugin.apply(ctx);assert.equal(typeof handler,'function');
 let client;vm.runInNewContext(await readFile(path.join(installed,'dist/client.js'),'utf8'),{window:{__ModuleLoader__:{load(entry){client=entry;}}}});assert.equal(client.id,pkg.name);
 console.log('Exact tarball production-only isolated install passed; stub host, not live GUI acceptance');
}finally{await rm(temp,{recursive:true,force:true});}
