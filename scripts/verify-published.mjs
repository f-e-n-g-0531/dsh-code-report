import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const pkg=JSON.parse(await readFile('package.json','utf8'));const [digest,filename]=(await readFile('release/SHA256SUMS.txt','utf8')).trim().split(/\s+/);
let last;
for(let attempt=0;attempt<30;attempt++){
 try{const response=await fetch('https://registry.npmjs.org/'+encodeURIComponent(pkg.name)+'/'+pkg.version,{signal:AbortSignal.timeout(15000)});assert.equal(response.status,200);const metadata=await response.json();assert.equal(metadata.version,pkg.version);const url=new URL(metadata.dist.tarball);assert.equal(url.protocol,'https:');assert.equal(url.hostname,'registry.npmjs.org');const archive=await fetch(url,{signal:AbortSignal.timeout(30000)});assert.equal(archive.status,200);assert.equal(createHash('sha256').update(Buffer.from(await archive.arrayBuffer())).digest('hex'),digest);console.log('Registry artifact matches',filename,digest);process.exit(0);}catch(e){last=e;console.log('Waiting for registry propagation',attempt+1);if(attempt<29)await new Promise(resolve=>setTimeout(resolve,10000));}
}
throw new Error('npm artifact not verified; do not create GitHub Release: '+last.message);
