import {build} from 'esbuild';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import assert from 'node:assert/strict';
const version='2.117.3';
const manifest=JSON.parse(readFileSync('node_modules/@supabase/supabase-js/package.json','utf8'));
assert.equal(manifest.version,version,'Unexpected Supabase SDK version');
const target=`assets/vendor/supabase-${version}.min.js`;
const result=await build({stdin:{contents:"export {createClient} from '@supabase/supabase-js';",resolveDir:process.cwd()},bundle:true,format:'iife',globalName:'supabase',platform:'browser',target:'safari15.4',minify:true,write:false,legalComments:'inline',banner:{js:`/* Supabase JS ${version}; bundled locally. Rebuild with node scripts/build-sdk.mjs. */`}});
const output=result.outputFiles[0].text;
if(process.argv.includes('--check')){
 assert.equal(readFileSync(target,'utf8'),output,'Rebuild the local Supabase SDK');
 console.log('Pinned local Supabase SDK matches installed package');
}else{
 mkdirSync('assets/vendor',{recursive:true});writeFileSync(target,output);
 const license=readFileSync('node_modules/@supabase/supabase-js/LICENSE');
 writeFileSync('assets/vendor/SUPABASE-LICENSE.txt',license);
 console.log(`Built ${target} (${Buffer.byteLength(output)} bytes)`);
}
