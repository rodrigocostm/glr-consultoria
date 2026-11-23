const {test}=require('node:test');const assert=require('node:assert/strict');
process.env.SUPABASE_SERVICE_ROLE_KEY='server-test';
const subscribe=require('../api/push-subscribe');const unsubscribe=require('../api/push-unsubscribe');
function res(){return {code:200,setHeader(){},status(c){this.code=c;return this;},json(b){this.body=b;return this;},end(){}};}
const body={endpoint:'https://web.push.apple.com/test',keys:{p256dh:'test-key',auth:'test-auth'}};
test('registro exige sessão e não grava sem autenticação',async()=>{let calls=0;global.fetch=async()=>{calls++;};const r=res();await subscribe({method:'POST',body},r);assert.equal(r.code,401);assert.equal(calls,0);});
test('registro usa identidade validada e credencial do servidor',async()=>{let written;global.fetch=async(url,opt)=>{if(url.includes('/auth/'))return {ok:true,json:async()=>({id:'user-1'})};if(url.includes('/rpc/'))return {ok:true,json:async()=>({role:'staff'})};written=opt;return {ok:true};};const r=res();await subscribe({method:'POST',headers:{authorization:'Bearer session'},body},r);assert.equal(r.code,200);assert.equal(JSON.parse(written.body).user_id,'user-1');assert.equal(written.headers.Authorization,'Bearer server-test');});
test('portal pode registrar seu dispositivo autenticado',async()=>{global.fetch=async(url)=>({ok:true,json:async()=>url.includes('/auth/')?{id:'portal'}:{role:'portal'}});const r=res();await subscribe({method:'POST',headers:{authorization:'Bearer session'},body},r);assert.equal(r.code,200);});
test('exclusão fica restrita ao usuário autenticado',async()=>{let deleted;global.fetch=async(url)=>{if(url.includes('/auth/'))return {ok:true,json:async()=>({id:'user-1'})};if(url.includes('/rpc/'))return {ok:true,json:async()=>({role:'staff'})};deleted=url;return {ok:true};};const r=res();await unsubscribe({method:'POST',headers:{authorization:'Bearer session'},body:{endpoint:body.endpoint}},r);assert.match(deleted,/user_id=eq.user-1/);});

