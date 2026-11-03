const {test,afterEach}=require('node:test');const assert=require('node:assert/strict');
process.env.SUPABASE_SERVICE_ROLE_KEY='mock-service';process.env.MCP_API_KEY='mock-mcp';
const handler=require('../api/mcp');const originalFetch=global.fetch;
afterEach(()=>{global.fetch=originalFetch});
const gestor={id:'22222222-2222-4222-8222-222222222222',email:'gestor@example.test',email_confirmed_at:null};
const res=()=>({code:200,setHeader(){},status(c){this.code=c;return this},json(b){this.body=b;return this},end(){return this}});
const req=params=>({method:'POST',headers:{authorization:'Bearer mock-session'},body:{action:'glr_login_portal',params:{tipo:'equipe',...params}}});
function mocks(o={}){
 const calls=[];global.fetch=async(url,init={})=>{
  calls.push({url,init});const ok=data=>({ok:true,status:200,json:async()=>data});
  if(url.endsWith('/auth/v1/user'))return ok({id:'staff-user'});
  if(url.endsWith('/rpc/glr_acesso'))return ok({role:o.role||'staff'});
  if(url.includes('/glr_storage?'))return ok([{dados:o.portal||[{email:'cliente@example.test'}]}]);
  if(url.endsWith('/auth/v1/admin/users')&&init.method==='POST')return o.existe?{ok:false,status:422,json:async()=>({})}:ok({id:gestor.id});
  if(url.includes('/admin/users?page='))return ok({users:o.existe?[gestor]:[]});
  if(init.method==='PUT')return ok({id:gestor.id});
  if(url.includes('/glr_staff?'))return ok(null);
  throw new Error('unexpected request '+url);
 };return calls;
}
const staffPost=calls=>calls.find(c=>c.url.includes('/glr_staff?')&&c.init.method==='POST');
test('novo gestor: cria login e cadastra na equipe',async()=>{
 const calls=mocks(),r=res();await handler(req({email:gestor.email,senha:'senha-forte-1'}),r);
 assert.equal(r.code,200);assert.equal(r.body.equipe,true);assert.equal(JSON.parse(staffPost(calls).init.body).user_id,gestor.id);
});
test('login já criado sem senha: só confirma e libera a equipe',async()=>{
 const calls=mocks({existe:true}),r=res();await handler(req({email:gestor.email}),r);
 assert.equal(r.code,200);assert.ok(staffPost(calls));
 assert.deepEqual(JSON.parse(calls.find(c=>c.init.method==='PUT').init.body),{email_confirm:true});
});
test('e-mail de cliente do portal nunca vira equipe',async()=>{
 const calls=mocks({portal:[{email:'Gestor@Example.test'}]}),r=res();await handler(req({email:gestor.email,senha:'senha-forte-1'}),r);
 assert.equal(r.code,400);assert.equal(staffPost(calls),undefined);
});
test('cliente do portal não consegue cadastrar equipe',async()=>{
 const calls=mocks({role:'portal'}),r=res();await handler(req({email:gestor.email,senha:'senha-forte-1'}),r);
 assert.equal(r.code,403);assert.equal(staffPost(calls),undefined);
});
