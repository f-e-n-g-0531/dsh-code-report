import {build} from 'esbuild';
import {readFile,writeFile} from 'node:fs/promises';
import {sha256,sourceProvenance} from './scripts/provenance.mjs';

const provenance=await sourceProvenance();
const buildInfo=JSON.stringify({version:provenance.version,sourceHash:provenance.sourceHash});
await build({
 entryPoints:['src/client.jsx'],outfile:'dist/client.js',bundle:true,minify:true,
 target:'es2022',format:'cjs',external:['react'],loader:{'.css':'text'},
 banner:{js:'window.__ModuleLoader__.load({id:"@feng0531/dsh-code-report",buildInfo:'+buildInfo+',factory(require){var module={exports:{}};var exports=module.exports;'},
 footer:{js:'return module.exports;}});'}
});
if((await sourceProvenance()).sourceHash!==provenance.sourceHash)throw new Error('Build inputs changed during compilation; rebuild before packaging');
await writeFile('dist/build-provenance.json',JSON.stringify({...provenance,clientHash:sha256(await readFile('dist/client.js'))},null,2)+'\n');
