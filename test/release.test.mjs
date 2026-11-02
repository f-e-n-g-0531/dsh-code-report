import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {sourceProvenance,verifyBuild,sha256} from '../scripts/provenance.mjs';
import {spawnSync} from 'node:child_process';
test('release workflow is tag-only, gated by four platforms and npm byte verification',async()=>{
 const source=await readFile(new URL('../.github/workflows/ci.yml',import.meta.url),'utf8');assert.match(source,/node: \[22, 24\]/);assert.match(source,/os: \[ubuntu-latest, windows-latest\]/);assert.doesNotMatch(source,/pull_request:|branches:/);assert.match(source,/needs: \[test, browser\]/);assert.match(source,/NPM_AUTOMATION_TOKEN/);assert.ok(source.indexOf('npm run release:npm')<source.indexOf('node scripts/verify-published.mjs'));assert.ok(source.indexOf('node scripts/verify-published.mjs')<source.indexOf('npm run release:github'));assert.ok(source.includes('actions/download-artifact'));
});
test('single browser job gates publishing without replacing the four-matrix package artifact',async()=>{
 const source=await readFile(new URL('../.github/workflows/ci.yml',import.meta.url),'utf8');
 const browser=source.split('  browser:\n')[1]?.split('  release:\n')[0];
 const release=source.split('  release:\n')[1];
 assert.ok(browser,'separate browser job exists');
 assert.equal((source.match(/^  browser:/gm)||[]).length,1);
 assert.match(browser,/runs-on: ubuntu-latest/);assert.match(browser,/node-version: 24/);
 assert.doesNotMatch(browser,/matrix:|release:npm|release:github|verify:package|npm pack/);
 assert.match(browser,/npm ci --include=dev --ignore-scripts/);
 assert.match(browser,/npx playwright install --with-deps chromium/);assert.match(browser,/npm run test:browser/);
 assert.match(browser,/if: always[(][)]/);assert.match(browser,/actions\/upload-artifact@v4/);
 assert.match(source,/needs: \[test, browser\]/);
 assert.match(release,/name: package-ubuntu-latest-node-24/);assert.match(release,/sha256sum --check SHA256SUMS[.]txt/);
 assert.doesNotMatch(release,/npm run build|npm run test:browser|npm run verify:package|npm pack/);
 assert.match(release,/if: startsWith[(]github[.]ref, 'refs\/tags\/'[)] && [(]github[.]event_name == 'push' \|\| inputs[.]publish[)]/);
});

test('release entry script passes Node syntax validation',()=>{const r=spawnSync(process.execPath,['--check','scripts/release.mjs'],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);});
test('npm publish uses explicit local tarball path rather than GitHub shorthand',async()=>{const source=await readFile(new URL('../scripts/release.mjs',import.meta.url),'utf8');assert.ok(source.includes("['publish','./release/'+name"));});
test('tag validator accepts matching stable version and rejects mismatch',async()=>{const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));const file=new URL('../scripts/verify-tag.mjs',import.meta.url);const {fileURLToPath}=await import('node:url');for(const [tag,expected]of [['v'+pkg.version,0],['v999.0.0',1],['main',1]]){const r=spawnSync(process.execPath,[fileURLToPath(file)],{env:{...process.env,GITHUB_REF_NAME:tag},encoding:'utf8'});assert.equal(r.status===0?0:1,expected);}});

async function buildFixture(t){
 const root=await mkdtemp(path.join(os.tmpdir(),'report-provenance-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 for(const dir of ['src','scripts','dist'])await mkdir(path.join(root,dir));
 for(const [name,text]of Object.entries({'package.json':'{"version":"1.0.0"}','package-lock.json':'{}','index.mjs':'export {};','build.mjs':'// build','scripts/provenance.mjs':'// helper','src/client.jsx':'// source'}))await writeFile(path.join(root,name),text);
 const provenance=await sourceProvenance(root);
 const client='window.__ModuleLoader__.load({id:"fixture",buildInfo:'+JSON.stringify({version:provenance.version,sourceHash:provenance.sourceHash})+',factory(){return {apply(){}}}});';
 await writeFile(path.join(root,'dist/client.js'),client);
 await writeFile(path.join(root,'dist/build-provenance.json'),JSON.stringify({...provenance,clientHash:sha256(client)}));
 return root;
}
test('provenance accepts exact input and client hashes without absolute paths',async t=>{
 const root=await buildFixture(t),result=await verifyBuild(root);
 assert.equal(result.version,'1.0.0');assert.ok(!JSON.stringify(result).includes(root));
});
test('provenance rejects same-version source changes and modified client bytes',async t=>{
 const stale=await buildFixture(t);await writeFile(path.join(stale,'src/client.jsx'),'// edited same version');
 await assert.rejects(verifyBuild(stale),/Stale build inputs/);
 const changed=await buildFixture(t);await writeFile(path.join(changed,'dist/client.js'),'// corrupted');
 await assert.rejects(verifyBuild(changed),/Client bytes/);
});
test('provenance rejects mismatched embedded version even when manifest hash matches bytes',async t=>{
 const root=await buildFixture(t),file=path.join(root,'dist/build-provenance.json');
 const provenance=JSON.parse(await readFile(file,'utf8'));
 const client='window.__ModuleLoader__.load({buildInfo:{version:"0.0.0",sourceHash:"'+provenance.sourceHash+'"},factory(){}});';
 await writeFile(path.join(root,'dist/client.js'),client);provenance.clientHash=sha256(client);await writeFile(file,JSON.stringify(provenance));
 await assert.rejects(verifyBuild(root),/Embedded client version/);
});
