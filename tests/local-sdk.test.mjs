import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';
test('production browser SDK is pinned, local and initializes without a CDN or network',async()=>{
 const html=readFileSync('index.html','utf8');
 const manifest=JSON.parse(readFileSync('package.json','utf8'));
 assert.equal(manifest.dependencies['@supabase/supabase-js'],'2.117.3');
 assert(!html.includes('cdn.jsdelivr.net'));
 assert(html.includes('src="assets/vendor/supabase-2.117.3.min.js"'));
 const dom=new JSDOM('',{url:'https://love.invalid',runScripts:'outside-only'});
 let fetches=0;
 try{
  dom.window.fetch=async()=>{fetches++;throw Error('Network must not be needed to load the SDK');};
  dom.window.Headers=Headers;dom.window.Request=Request;dom.window.Response=Response;
  vm.runInContext(readFileSync('assets/vendor/supabase-2.117.3.min.js','utf8'),dom.getInternalVMContext());
  assert.equal(typeof dom.window.supabase.createClient,'function');
  const client=dom.window.supabase.createClient('https://test.supabase.co','public-test',{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
  const result=await client.auth.getSession();
  assert.equal(result.error,null);assert.equal(result.data.session,null);
  assert.equal(fetches,0);
  // Exercise the actual bundled Auth API, using only a synthetic token/user.
  const user={id:'00000000-0000-4000-8000-000000000001',aud:'authenticated'};
  const payload=Buffer.from(JSON.stringify({sub:user.id,exp:Math.floor(Date.now()/1000)+3600})).toString('base64url');
  const access=`eyJhbGciOiJIUzI1NiJ9.${payload}.test`;
  dom.window.fetch=async(url,options)=>{
   fetches++;assert.equal(String(url),'https://test.supabase.co/auth/v1/user');
   assert.equal(options.headers.Authorization,`Bearer ${access}`);
   return Response.json(user);
  };
  const login=await client.auth.setSession({access_token:access,refresh_token:'test-refresh'});
  assert.equal(login.error,null);assert.equal(login.data.user.id,user.id);
  assert.equal((await client.auth.getSession()).data.session.user.id,user.id);
  assert.equal(fetches,1);
 }finally{dom.window.close()}
});
