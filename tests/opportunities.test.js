const {test}=require('node:test');
const assert=require('node:assert/strict');
const {build}=require('../js/plano-oportunidades');
test('ranking preserves urgency and does not sum incomparable impact periods',()=>{
 const p={acoes:[{id:'a',peso:1,valor:300,impacto:'R$ 300/mês'},{id:'b',peso:9,valor:100,impacto:'R$ 100/sem'},{id:'b',peso:9}],cliente:{gestor:'Maria'}};
 const result=build(p); assert.deepEqual(result.map(x=>x.id),['b','a']);assert.equal(result[0].responsavel,'Maria');assert.equal(result[1].impacto,p.acoes[0].impacto);
});
test('observed loss stays separate from a hypothesis and has no guaranteed recovery',()=>{
 const p={acoes:[{id:'fat:A:SKU',conta:'A',tipo:'faturamento'}],raioX:{periodo:{antes:'01–14',agora:'15–28'},caiu:[{conta:'A',id:'SKU',antes:500,agora:200,perdaSem:300,causas:[{t:'preço aumentou'}]}]}};
 const [o]=build(p);assert.match(o.evidencia,/500/);assert.equal(o.hipotese,'preço aumentou');assert.match(o.impactoNatureza,/não garantida/);assert.equal(o.confianca,'média');
});
test('missing cost/stock does not become a recommendation to blindly increase Ads',()=>{
 const [o]=build({acoes:[{id:'ad',tipo:'ads',valor:NaN}]});assert.equal(o.impactoValor,null);assert.match(o.faltantes.join(),/estoque e margem/);assert.equal(o.confianca,'a validar');
});
test('actions beyond daily top seven remain available and plans stay isolated',()=>{
 const candidates=Array.from({length:12},(_,i)=>({id:`A:${i}`,conta:'A',peso:i}));
 assert.equal(build({acoes:[]},candidates).length,12);
 assert.equal(build({cliente:{id:'B'},acoes:[]}).length,0);
});
test('legacy and malformed empty plans render an empty list safely',()=>{
 assert.deepEqual(build({}),[]);assert.deepEqual(build({oportunidades:{}}),[]);
});
test('plan UI filters accounts, keeps assigned actions open and persists task/outcome context', async()=>{
 const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
 const storage=new Map([['glr_mc_vinculos',JSON.stringify({1:[{external_id:'A'},{external_id:'B'}]})]]);
 const root={innerHTML:''},el={innerHTML:''};let handler;const answers=[];
 const actions=[{id:'a',conta:'A',loja:'Loja A',titulo:'Repor móvel',tipo:'estoque',peso:900,quando:'hoje',quem:'cliente'}, {id:'b',conta:'B',loja:'Loja B',titulo:'Rever <script>bad</script>',tipo:'ads',peso:500,quando:'semana',quem:'analista'}];
 const p={em:Date.now(),cliente:{id:1,nome:'Cliente',gestor:'Maria',gestorId:1},semaforo:'amarelo',metricas:{tacos:8,projecao:3000},acoes:actions,oportunidades:actions,resultados:{medidas:0}};
 const ctx={console,Date,Map,Set,JSON,Number,String,Math,Array,parseFloat,parseInt,setTimeout,
  localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},
  document:{getElementById:id=>id==='pl-root'?root:null},prompt:()=>answers.shift(),
  GLR:{clientes:[{id:1,nome:'Cliente',gestorId:1}],gestores:[{id:1,nome:'Maria'}],tarefas:[],nextId:()=>1},
  Router:{register:(k,fn)=>handler=fn,navigate:()=>{}},
  _sb:{from:()=>({select(){return this},eq(){return this},then(resolve){resolve({data:[{cursor:p}]})}}),auth:{getUser:async()=>({data:{user:{email:'test@example.test'}}})}}
 };
 ctx.window=ctx;
 vm.createContext(ctx);
 for(const name of ['plano-oportunidades','pages-plano']) vm.runInContext(fs.readFileSync(path.join(__dirname,`../js/${name}.js`),'utf8'),ctx);
 handler({embed:true,clienteId:1},el);await new Promise(resolve=>setImmediate(resolve));
 assert.match(root.innerHTML,/Oportunidades para vender com lucro/);
 assert.match(root.innerHTML,/Repor móvel/);
 ctx._plOpConta('B');assert.doesNotMatch(root.innerHTML,/Repor móvel/);assert.match(root.innerHTML,/Rever &lt;script&gt;bad&lt;\/script&gt;/);
 answers.push('Ana');ctx._plOpAcao(1,'responsavel');assert.match(root.innerHTML,/Virar tarefa/);
 ctx._plOpAcao(1,'tarefa');assert.equal(ctx.GLR.tarefas.length,1);assert.equal(ctx.GLR.tarefas[0].responsavel,'Ana');
 ctx._plOpAcao(1,'tarefa');assert.equal(ctx.GLR.tarefas.length,1);
 answers.push('7 dias: conversão 2% para 3%');ctx._plOpAcao(1,'resultado');assert.match(root.innerHTML,/conversão 2% para 3%/);
 ctx._plOpAcao(1,'reabrir');ctx._plOpAcao(1,'feito');assert.match(root.innerHTML,/Contexto ao concluir/);
 const saved=JSON.parse(storage.get('glr_plano_status'));assert.equal(saved.b.st,'feito');assert.equal(saved.b.baseline.tacos,8);assert.equal(saved.b.responsavel,'Ana');
});
