const {test,afterEach}=require('node:test');const assert=require('node:assert/strict');
const {progresso,SYSTEM}=require('../api/_adviser');const handler=require('../api/adviser');
const original=global.fetch;process.env.SUPABASE_SERVICE_ROLE_KEY='mock';afterEach(()=>global.fetch=original);
const res=()=>({status(n){this.code=n;return this},setHeader(){},json(b){this.body=b;return this}});
test('unknown revenue is unknown, never a false zero or milestone',()=>{assert.equal(progresso().receita,null);assert.equal(progresso().falta,null);assert.ok(progresso().marcos.every(m=>!m.atingido));});
test('130, 150, 170 milestones always retain the 200k destination',()=>{for(const v of [130000,150000,170000,200000]){const p=progresso(v);assert.equal(p.meta,200000);assert.equal(p.falta,200000-v);assert.equal(p.marcos.filter(m=>m.atingido).length,[130000,150000,170000,200000].indexOf(v)+1)}assert.equal(progresso(170000).proximo,200000);assert.equal(progresso(250000).pct,100)});
test('portal cannot read company revenue or invoke Adviser',async()=>{let calls=0;global.fetch=async u=>{calls++;return {ok:true,json:async()=>u.endsWith('/auth/v1/user')?{id:'p'}:{role:'portal'}}};const r=res();await handler({method:'GET',headers:{authorization:'Bearer mock'},query:{mes:'2026-11'}},r);assert.equal(r.code,403);assert.equal(calls,2)});
test('anonymous cannot read strategy',async()=>{global.fetch=()=>{throw Error('unexpected')};const r=res();await handler({method:'GET',headers:{},query:{mes:'2026-11'}},r);assert.equal(r.code,401)});
function fixture(){const writes=[];global.fetch=async(u,init)=>{if(u.endsWith('/auth/v1/user'))return{ok:true,json:async()=>({id:'s',email:'staff@example.test'})};if(u.endsWith('/rpc/glr_acesso'))return{ok:true,json:async()=>({role:'staff'})};if(init?.method==='POST'){writes.push(JSON.parse(init.body));return{ok:true,status:204}}return{ok:true,json:async()=>u.includes('chave=in.')?[
 {chave:'glr_clientes',dados:[{id:1,nome:'Cliente',valorPorVenda:2}]},
 {chave:'glr_projecoes',dados:[{chave:1,dataBase:'2026-11-10',diasDecorridos:10,diasNoMes:30,plataformas:[{contaId:'A',vendasBase:1000,fatBase:200000}]}]},
 {chave:'glr_mc_vinculos',dados:{1:[{external_id:'A'}]}}
 ]:u.includes('glr_sync_estado')?[]:[{dados:{receitas:{'2026-11':{valor:199999}},missoes:[]}}]}};return writes}
test('stored projection replaces manually entered Adviser revenue',async()=>{fixture();const r=res();await handler({method:'GET',headers:{authorization:'Bearer mock'},query:{mes:'2026-11'}},r);assert.equal(r.body.progresso.receita,6000);assert.equal(r.body.receita.base,2000);assert.equal(r.body.receitas,undefined)});
test('previous month never silently becomes current projection',async()=>{fixture();const r=res();await handler({method:'GET',headers:{authorization:'Bearer mock'},query:{mes:'2026-12'}},r);assert.equal(r.body.progresso.receita,null);assert.equal(r.body.receita.parcial,true)});
test('manual revenue endpoint is removed',async()=>{const writes=fixture();const r=res();await handler({method:'POST',headers:{authorization:'Bearer mock'},body:{mes:'2026-11',acao:'receita',valor:200000}},r);assert.equal(r.code,400);assert.equal(writes.length,0)});
test('strategy explicitly distinguishes GMV and prohibits unapproved execution',()=>{assert.match(SYSTEM,/GMV, NÃO receita/);assert.match(SYSTEM,/Não execute campanhas/);assert.match(SYSTEM,/nunca por projeção/)});
