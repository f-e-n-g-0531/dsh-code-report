import {build} from 'esbuild';
await build({entryPoints:['src/client.jsx'],outfile:'dist/client.js',bundle:true,minify:true,target:'es2022',format:'cjs',external:['react'],loader:{'.css':'text'},banner:{js:'window.__ModuleLoader__.load({id:"@feng0531/dsh-code-report",factory(require){var module={exports:{}};var exports=module.exports;'},footer:{js:'return module.exports;}});'}});
