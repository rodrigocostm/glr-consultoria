const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const source=fs.readFileSync('js/pages-vendometro.js','utf8');
const NOW=Date.parse('2026-11-11T14:20:00Z');
const order=(id,date,value,account='A')=>({pedido_id:id,marketplace:'ml',conta_id:account,criado_em:date,situacao:'valido',valor_bruto:value,itens:[{qtd:2}]});
const orders=[order('midnight','2026-11-10T02:59:59Z',999),order('early','2026-11-10T03:00:00Z',100),order('late','2026-11-11T02:59:59Z',200),order('today','2026-11-11T12:00:00Z',50),order('prior','2026-11-09T13:00:00Z',20),order('prior-late','2026-11-10T01:00:00Z',30),order('unlinked','2026-11-10T12:00:00Z',900,'OUT')];
async function setup({slowVisits=false, uncovered=false, remoteFailure=false}={}){
 const nodes=new Map(),queries=[],visits=[],pending=[];
 const node=id=>{if(!nodes.has(id))nodes.set(id,{innerHTML:'',textContent:'',classList:{toggle(){}},value:'',canvas:id});return nodes.get(id)};
 class FixedDate extends Date {constructor(...args){super(...(args.length?args:[NOW]))}static now(){return NOW}}
 let handler;
 const context={Date:FixedDate,console,Map,Set,performance:{now:()=>0},requestAnimationFrame:cb=>cb(Infinity),setInterval:()=>1,clearInterval(){},getComputedStyle:()=>({getPropertyValue:()=>''}),
 document:{getElementById:node,querySelectorAll:()=>[],addEventListener(){}},
 localStorage:{getItem:key=>key==='glr_mc_vinculos'?JSON.stringify({1:[{marketplace:'ml',external_id:'A',nickname:'Loja A',param_to_use:{meliUserId:'A'}}]}):null,setItem(){}},
 VendometroHistorico:{buscar:async(call,conta,dia)=>{if(remoteFailure)throw Error('Histórico não disponível no conector.');return [order('remote',dia+'T13:00:00Z',250)]}},
 GLR:{clientes:[{id:1,nome:'Cliente A'}],ctx:{cliente:()=>'',definir(){}}},BaseDados:{mktDe:m=>m,carregar:async()=>({}),cobre:(_,dia)=>!uncovered || dia!=='2026-07-07'},Router:{register:(_,fn)=>handler=fn},
 MarketplaceAPI:{call:async(action,args)=>{visits.push(args);if(slowVisits)return new Promise(resolve=>pending.push(resolve));return{total_visits:100}}},
 Chart:class{constructor(canvas,config){this.canvas=canvas;this.data=config.data}stop(){}update(){}destroy(){}},
 _sb:{from(table){const filters=[];const q={select(){return q},gte(k,v){filters.push(r=>r[k]>=v);return q},lt(k,v){filters.push(r=>r[k]<v);return q},eq(k,v){filters.push(r=>r[k]===v);return q},order(){return q},range(a,b){queries.push({table,filters});return Promise.resolve({data:orders.filter(r=>filters.every(f=>f(r))).slice(a,b+1)})},then(resolve,reject){queries.push({table,filters});return Promise.resolve({data:[{marketplace:'ml',conta_id:'A',data:'2026-11-10',gasto:10},{marketplace:'ml',conta_id:'A',data:'2026-11-11',gasto:5}].filter(r=>filters.every(f=>f(r)))}).then(resolve,reject)}};return q}},
 addEventListener(){},removeEventListener(){}};
 context.window=context;vm.runInNewContext(source,context);handler({}, {innerHTML:''});
 const flush=async()=>{for(let i=0;i<25;i++)await Promise.resolve()};await flush();
 return{context,nodes,queries,visits,pending,flush};
}
test('historical day includes all 24 hours, bounds BRT, ADS and ranking follow the selected date',async()=>{
 const x=await setup();x.context._vmData('data','2026-11-10');await x.flush();
 assert.equal(x.nodes.get('vm-total').textContent,'300,00');
 assert.match(x.nodes.get('vm-ranking').innerHTML,/300,00/);
 assert.doesNotMatch(x.nodes.get('vm-ranking').innerHTML,/900,00/);
 assert.match(x.nodes.get('vm-metricas').innerHTML,/R\$ 10/);
 assert.equal(x.context._vmSt.grafico.data.datasets[0].data[23],200);
 assert.match(x.nodes.get('vm-var').innerHTML,/dia completo/);
 assert.equal(x.visits.at(-1).date_from,'2026-11-10');
});
test('custom comparison updates query, graph and full-day comparison; today compares at the same hour',async()=>{
 const x=await setup();x.context._vmData('comparar','2026-11-09');await x.flush();
 assert.match(x.nodes.get('vm-var').innerHTML,/até esta hora \(R\$ 20\)/);
 assert.equal(x.context._vmSt.grafico.data.datasets[1].label,'09/11/2026');
 assert.equal(x.context._vmSt.grafico.data.datasets[0].data[23],null);
 x.context._vmData('data','2026-11-10');await x.flush();x.context._vmData('comparar','2026-11-09');await x.flush();
 // 999 just before midnight belongs to 09/11, plus 20 and 30.
 assert.match(x.nodes.get('vm-var').innerHTML,/1\.049/);
 x.context._vmData('hoje');await x.flush();assert.equal(x.nodes.get('vm-data').value,'2026-11-11');assert.equal(x.nodes.get('vm-comparar').value,'2026-11-10');
});
test('future and invalid dates cannot launch queries',async()=>{
 const x=await setup(),before=x.queries.length;
 for(const d of ['2026-11-12','2026-02-30','<script>',''])x.context._vmData('data',d);
 await x.flush();assert.equal(x.queries.length,before);assert.equal(x.nodes.get('vm-data').value,'2026-11-11');
});
test('late visits from previous date cannot contaminate the new date',async()=>{
 const x=await setup({slowVisits:true});assert.equal(x.pending.length,1);
 x.context._vmData('data','2026-11-10');await x.flush();x.pending.shift()({total_visits:9999});await x.flush();
 assert.equal(x.context._vmSt.visitas['ml:A'],undefined);assert.equal(x.visits.at(-1).date_from,'2026-11-10');
 x.pending.shift()({total_visits:40});await x.flush();assert.equal(x.context._vmSt.visitas['ml:A'],40);
});

test('uncovered historical date is fetched and included in comparison',async()=>{
 const x=await setup({uncovered:true});x.context._vmData('comparar','2026-07-07');await x.flush();
 assert.match(x.nodes.get('vm-var').innerHTML,/R\$ 250/);
 assert.equal(x.context._vmSt.grafico.data.datasets[1].data[10],250);
 assert.doesNotMatch(x.nodes.get('vm-var').innerHTML,/Sem vendas|indisponível/);
});
test('connector failure never becomes zero sales or a zero comparison line',async()=>{
 const x=await setup({uncovered:true,remoteFailure:true});x.context._vmData('comparar','2026-07-07');await x.flush();
 assert.match(x.nodes.get('vm-var').innerHTML,/histórico incompleto/);
 assert.match(x.nodes.get('vm-historico-status').innerHTML,/não significa zero vendas/);
 assert.ok(x.context._vmSt.grafico.data.datasets[1].data.every(v=>v===null));
});
