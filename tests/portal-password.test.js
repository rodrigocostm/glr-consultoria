const {test,afterEach}=require('node:test');const assert=require('node:assert/strict');
process.env.SUPABASE_SERVICE_ROLE_KEY='mock-service';
const handler=require('../api/portal-password');const originalFetch=global.fetch;
afterEach(()=>{global.fetch=originalFetch});
const cfg={id:'portal-demo',email:'client@example.test',ativo:true};
const target={id:'11111111-1111-4111-8111-111111111111',email:cfg.email,email_confirmed_at:'2026-01-01'};
const res=()=>({code:200,setHeader(){},status(c){this.code=c;return this},json(b){this.body=b;return this}});
const req=(body={portalId:cfg.id,password:'test-password-only'})=>({method:'POST',headers:{authorization:'Bearer mock-session'},body});
function mocks(options={}){
 const calls=[];global.fetch=async(url,init={})=>{
  calls.push({url,init});const ok=data=>({ok:true,status:200,json:async()=>data});
  if(url.endsWith('/auth/v1/user'))return ok({id:'staff-user'});
  if(url.endsWith('/rpc/glr_acesso'))return ok({role:options.role||'staff'});
  if(url.includes('/glr_storage?'))return ok([{dados:options.configs||[cfg]}]);
  if(url.includes('/admin/users?page='))return ok({users:options.users||[target]});
  if(url.includes('/glr_staff?'))return ok(options.staff?[{user_id:target.id}]:[]);
  if(init.method==='PUT')return options.reject?{ok:false,status:400,json:async()=>({message:'raw provider '+req().body.password})}:ok({id:target.id});
  throw new Error('unexpected request');
 };return calls;
}
test('anonymous caller cannot reset any password',async()=>{
 let calls=0;global.fetch=async()=>{calls++};const r=res();await handler({...req(),headers:{}},r);assert.equal(r.code,401);assert.equal(calls,0);
});
test('portal session cannot reset another portal password',async()=>{
 const calls=mocks({role:'portal'}),r=res();await handler(req(),r);assert.equal(r.code,403);assert.equal(calls.length,2);
});
for(const [name,opt,status] of [
 ['missing portal',{configs:[]},404],['disabled portal',{configs:[{...cfg,ativo:false}]},404],
 ['staff identity',{staff:true},403],['unconfirmed identity',{users:[{...target,email_confirmed_at:null}]},403],
 ['missing Auth user',{users:[]},404]
])test(`${name} never triggers a password write`,async()=>{const calls=mocks(opt),r=res();await handler(req(),r);assert.equal(r.code,status);assert.equal(calls.some(x=>x.init.method==='PUT'),false)});
test('valid staff request updates only the config-matched portal password',async()=>{
 const calls=mocks(),r=res();await handler(req({...req().body,email:'attacker@example.test',userId:'other-user',role:'staff'}),r);
 assert.equal(r.code,200);const write=calls.find(x=>x.init.method==='PUT');assert.ok(write.url.endsWith('/'+target.id));
 assert.deepEqual(JSON.parse(write.init.body),{password:req().body.password});assert.deepEqual(r.body,{ok:true});
});
test('invalid new password never reaches Auth admin',async()=>{const calls=mocks(),r=res();await handler(req({portalId:cfg.id,password:'short'}),r);assert.equal(r.code,400);assert.equal(calls.length,2)});
test('provider rejection is not reported as success and secrets stay out of response',async()=>{
 mocks({reject:true});const r=res();await handler(req(),r);assert.equal(r.code,400);assert.ok(!JSON.stringify(r.body).includes(req().body.password));assert.ok(!JSON.stringify(r.body).includes('mock-service'));
});
test('editing portal access sends the password to the protected endpoint and reports failures',async()=>{
 const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
 const elements={'pm-msg':{style:{}},'pm-email':{value:cfg.email},'pm-senha':{value:'test-password-only'},'pm-cliente':{value:'8'}};
 let stored=JSON.stringify([{...cfg,clienteId:'8',contaIds:['A']}]);const sent=[];let fail=true,writes=0;
 const ctx={console,setTimeout(){},GLR:{clientes:[{id:8,nome:'Demo'}]},Router:{register(){}},localStorage:{getItem:()=>stored,setItem:(k,v)=>stored=v},document:{getElementById:k=>elements[k]||null,querySelectorAll:()=>[{value:'A'}]},_sb:{from:()=>({upsert:async()=>{writes++;return {error:null}}})},glrApiFetch:async(path,init)=>{sent.push({path,body:JSON.parse(init.body)});return {ok:!fail,json:async()=>fail?{error:'Falha ao redefinir'}:{ok:true}}}};
 ctx.window=ctx;vm.createContext(ctx);vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/pages-portal-admin.js'),'utf8'),ctx);
 await ctx._portalAdminSalvar(cfg.id);assert.equal(elements['pm-msg'].textContent,'❌ Erro: Falha ao redefinir');assert.equal(writes,0);
 fail=false;await ctx._portalAdminSalvar(cfg.id);assert.match(elements['pm-msg'].textContent,/Senha atualizada/);assert.equal(elements['pm-senha'].value,'');assert.equal(writes,1);
 assert.equal(sent[1].path,'/api/portal-password');assert.equal(sent[1].body.portalId,cfg.id);assert.equal(sent[1].body.password,'test-password-only');assert.ok(!stored.includes('test-password-only'));
});
