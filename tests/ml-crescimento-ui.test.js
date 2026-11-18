const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
function tela() {
 let route;const window={};
 const code=fs.readFileSync(require.resolve('../js/pages-agente-ml.js'),'utf8').replace(/  carregar\(\);\s*\}\);\s*$/, '  window.__teste={state,renderConfig,renderCrescimento,renderResultados,salvarConfig};\n});');
 vm.runInNewContext(code,{window,Router:{register:(name,fn)=>route=fn},localStorage:{getItem:()=>null},GLR:{ctx:{}},console,Date,Map,Set});
 route({}, {innerHTML:''});
 const t=window.__teste;t.state.configs=[{conta_id:'a',meta_acos:20}];t.state.planos.a={teto_tacos:8,meta_faturamento:100000,piloto:true};
 return t;
}
test('tela separa os campos ACOS, TACOS, meta financeira e piloto por conta',()=>{
 const t=tela(),html=t.renderConfig(t.state.configs[0]);
 for(const id of ['aml-meta','aml-teto-tacos','aml-meta-fat','aml-margem-reserva','aml-piloto']) assert.ok(html.includes('id="'+id+'"'));
 assert.match(html,/id="aml-meta"[^>]*value="20"/);assert.match(html,/id="aml-teto-tacos"[^>]*value="8"/);
});
test('mapa filtra grupos e escapa nomes externos',()=>{
 const t=tela();t.state.mapas.a={em:'2026-11-17',familias:[{nome:'<script>ruim</script>',grupo:'escalar',limite_acos:20,confianca:'alta',bloqueios:[],faturamento_ads:100},{nome:'Contido',grupo:'conter',bloqueios:[],faturamento_ads:5}]};
 t.state.grupoEscala='escalar';const html=t.renderCrescimento('a');assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<script>'));assert.ok(!html.includes('<td>Contido</td>'));assert.ok(html.includes('Escalar (1)'));
});
test('resultados excluem inconclusivos da taxa e permitem registrar contexto posterior',()=>{
 const t=tela();t.state.logs=['melhorou','inconclusivo'].map((v,i)=>({id:String(i),conta_id:'a',tipo:'alerta',resultado:'executado',dados:{acao:'orcamento',experimento:{},medicao:{veredito:v,aplicado_dia:'2026-11-01'}}}));
 const html=t.renderResultados('a');assert.ok(html.includes('100%'));assert.ok(html.includes('1 de 1 comparações avaliáveis; 1 inconclusivas'));assert.ok(html.includes('Registrar contexto'));
});
