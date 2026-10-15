import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
test('release workflow is tag-only, gated by four platforms and npm byte verification',async()=>{
 const source=await readFile(new URL('../.github/workflows/ci.yml',import.meta.url),'utf8');assert.match(source,/node: \[22, 24\]/);assert.match(source,/os: \[ubuntu-latest, windows-latest\]/);assert.doesNotMatch(source,/pull_request:|branches:/);assert.match(source,/needs: test/);assert.match(source,/NPM_AUTOMATION_TOKEN/);assert.ok(source.indexOf('npm run release:npm')<source.indexOf('node scripts/verify-published.mjs'));assert.ok(source.indexOf('node scripts/verify-published.mjs')<source.indexOf('npm run release:github'));assert.ok(source.includes('actions/download-artifact'));
});
test('release entry script passes Node syntax validation',()=>{const r=spawnSync(process.execPath,['--check','scripts/release.mjs'],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);});
test('tag validator accepts matching stable version and rejects mismatch',async()=>{const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));const file=new URL('../scripts/verify-tag.mjs',import.meta.url);const {fileURLToPath}=await import('node:url');for(const [tag,expected]of [['v'+pkg.version,0],['v999.0.0',1],['main',1]]){const r=spawnSync(process.execPath,[fileURLToPath(file)],{env:{...process.env,GITHUB_REF_NAME:tag},encoding:'utf8'});assert.equal(r.status===0?0:1,expected);}});
