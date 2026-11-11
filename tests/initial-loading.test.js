const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync('js/supabase-init.js','utf8');
function setup({sessionHang=false,role='staff',permissionError=false,syncError=false}={}){
 const timers=new Map(),events={},nodes=new Map(),store=new Map([['glr_acoes','[{"id":1,"descricao":"Lançamento pendente"}]']]);
 let next=0,signouts=0,reads=0,renders=0,portal=0;
 const element=id=>({id,style:{visibility:'hidden'},innerHTML:'',textContent:'',remove(){nodes.delete(this.id)},querySelector(){return{ textContent:'' }},focus(){}});
 nodes.set('app',element('app'));nodes.set('glr-loading-inicial',element('glr-loading-inicial'));
 const client={auth:{getSession:()=>sessionHang?new Promise(()=>{}):Promise.resolve({data:{session:{user:{email:'staff@example.test'}}}}),onAuthStateChange(){},signOut:async()=>{signouts++},getUser:async()=>({data:{user:{email:'staff@example.test'}}})},rpc:async()=>({data:{role,portal:role==='portal'?{clienteId:1}:undefined},error:permissionError?{message:'timeout'}:null}),from(){reads++;return{select:async()=>({data:[{chave:'glr_acoes',dados:[{id:1,descricao:'Lançamento pendente'}]}],error:syncError?{message:'timeout'}:null})}},channel:()=>({on(){return this},subscribe(){}})};
 const context={console:{log(){},warn(){},error(){}},URL,Headers,AbortController,fetch:async()=>({ok:true}),Map,Set,Promise,
 setTimeout(fn,ms){timers.set(++next,{fn,ms});return next},clearTimeout(id){timers.delete(id)},
 localStorage:{getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)},
 location:{origin:'https://consultoriaglr.com.br',hash:'',search:'',replace(){throw Error('unexpected redirect')},reload(){throw Error('automatic reload forbidden')}},
 document:{addEventListener:(name,cb)=>events[name]=cb,getElementById:id=>nodes.get(id)||null,querySelector:()=>null,createElement:()=>element(''),body:{appendChild:n=>nodes.set(n.id,n)}},
 supabase:{createClient:(u,k,options)=>{context.options=options;return client}},Router:{resolve(){renders++},navigate(){renders++}},
 _initPortalCliente:async()=>{portal++},addEventListener(){},GLR:{}};
 context.window=context;vm.runInNewContext(source,context);
 return{context,events,nodes,store,timers,run:()=>events.DOMContentLoaded(),counts:()=>({signouts,reads,renders,portal}),flush:async()=>{for(let i=0;i<15;i++)await Promise.resolve()}};
}
test('session stall stops loading with explicit retry and no automatic reload',async()=>{
 const x=setup({sessionHang:true}),work=x.run();await x.flush();
 const timer=[...x.timers.values()].find(t=>t.ms===12000);assert.ok(timer);timer.fn();await work;
 assert.equal(x.nodes.has('glr-loading-inicial'),false);assert.equal(x.nodes.get('app').style.visibility,'hidden');
 assert.match(x.nodes.get('glr-login-overlay').innerHTML,/Conexão indisponível/);assert.match(x.nodes.get('glr-login-overlay').innerHTML,/Tentar novamente/);
 assert.equal(x.counts().renders,0);assert.equal(x.context._glrAcessoPronto,false);
});
test('database auth failure preserves session and local reports; does not treat outage as access revocation',async()=>{
 const x=setup({permissionError:true});await x.run();
 assert.equal(x.counts().signouts,0);assert.ok(x.store.has('glr_acoes'));assert.equal(x.counts().reads,0);assert.equal(x.counts().renders,0);
 assert.match(x.nodes.get('glr-login-overlay').innerHTML,/lançamentos locais foram mantidos/);
});
test('initial sync error never opens an empty or stale staff app',async()=>{
 const x=setup({syncError:true});await x.run();assert.equal(x.context._glrAcessoPronto,false);assert.equal(x.counts().renders,0);assert.equal(x.nodes.get('app').style.visibility,'hidden');
});
test('successful staff boot unlocks routing after data sync; transient retries disabled',async()=>{
 const x=setup();await x.run();assert.equal(x.context._glrAcessoPronto,true);assert.equal(x.counts().reads,1);assert.equal(x.counts().renders,1);assert.equal(x.context.options.db.retry,false);
 assert.equal(x.nodes.get('app').style.visibility,'visible');
});
test('verified portal boot never reads staff storage',async()=>{
 const x=setup({role:'portal'});await x.run();assert.equal(x.counts().reads,0);assert.equal(x.counts().portal,1);assert.equal(x.context._glrAcessoPronto,true);
});
test('router does not start network-heavy pages while permissions are pending',()=>{
 const ctx={window:{_glrAcessoPronto:false}};vm.runInNewContext(fs.readFileSync('js/router.js','utf8')+'\nRouter.resolve();',ctx);
 // No document or data access exists in this context: resolve must return before using either.
});
test('network deadline cancels reads but does not abort report writes',async()=>{
 const x=setup();let signal;
 x.context.fetch=(url,init)=>{signal=init.signal;return new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true})})};
 const read=x.context._glrFetchLimitado('https://db.example/rest/v1/glr_storage',{method:'GET'});
 const timer=[...x.timers.values()].find(t=>t.ms===20000);assert.ok(timer);timer.fn();await assert.rejects(read,/aborted/);assert.equal(signal.aborted,true);
 x.context.fetch=async(url,init)=>({ok:true,signal:init.signal});
 const write=await x.context._glrFetchLimitado('https://db.example/rest/v1/glr_storage',{method:'POST',body:'report'});
 assert.equal(write.ok,true);assert.equal(write.signal,undefined);assert.equal(x.timers.size,0);
});
