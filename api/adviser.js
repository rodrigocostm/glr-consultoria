const {requireStaff}=require('./_auth');
const {progresso,SYSTEM}=require('./_adviser');
const {receitaProjecao}=require('./_adviser-revenue');
const BASE='https://rrodqlejqyaoomutriiw.supabase.co/rest/v1';
async function db(path,init={}) {
 const key=process.env.SUPABASE_SERVICE_ROLE_KEY;
 const r=await fetch(`${BASE}/${path}`,{...init,headers:{apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json',...(init.headers||{})},signal:AbortSignal.timeout(15000)});
 if(!r.ok)throw Error('Não foi possível acessar os dados do Adviser.');
 if(r.status===204)return null;
 if(typeof r.text!=='function')return r.json();
 const t=await r.text();return t?JSON.parse(t):null; // gravação (return=minimal) volta 201 sem corpo
}
async function ler(){const rows=await db('glr_storage?chave=eq.glr_adviser&select=dados');return rows[0]?.dados||{receitas:{},missoes:[]};}
module.exports=async(req,res)=>{
 res.setHeader('Cache-Control','private, no-store');
 if(!['GET','POST'].includes(req.method))return res.status(405).json({error:'Método não permitido.'});
 const user=await requireStaff(req,res);if(!user)return;
 try{
  const state=await ler();state.receitas ||= {};state.missoes ||= [];
  const mes=req.method==='GET'?req.query?.mes:req.body?.mes;
  if(!/^20\d{2}-(0[1-9]|1[0-2])$/.test(mes||''))return res.status(400).json({error:'Informe o mês de referência.'});
  const [storage,base]=await Promise.all([db('glr_storage?chave=in.(glr_clientes,glr_projecoes,glr_mc_vinculos,glr_comissao_contas)&select=chave,dados'),db('glr_sync_estado?recurso=in.(resumo,pedidos)&marketplace=neq.sistema&select=marketplace,conta_id,recurso,cursor,ultimo_sucesso&limit=1000')]);
  const valores=Object.fromEntries(storage.map(r=>[r.chave,r.dados]));
  const receita=receitaProjecao({clientes:valores.glr_clientes,projecoes:valores.glr_projecoes,vinculos:valores.glr_mc_vinculos,excecoes:valores.glr_comissao_contas,base},mes);
  if(req.method==='POST'){
   const b=req.body||{};
   if(b.acao==='gerar'){
    if(!process.env.ANTHROPIC_API_KEY)return res.status(503).json({error:'IA não configurada. O acompanhamento de metas continua disponível.'});
    const rows=await db('glr_sync_estado?marketplace=eq.sistema&recurso=eq.plano&select=cursor,ultimo_sucesso&limit=200');
    const planos=rows.map(r=>{const p=r.cursor||{};return {cliente:p.cliente,em:r.ultimo_sucesso,semaforo:p.semaforo,metricas:p.metricas,acoes:(p.acoes||[]).slice(0,7)}});
    const r=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':process.env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01'},body:JSON.stringify({model:'claude-haiku-4-5-20251001',max_tokens:3500,system:SYSTEM,messages:[{role:'user',content:JSON.stringify({mes,receitaGLR:receita,progresso:progresso(receita.projetada),missoes:state.missoes.filter(m=>m.status!=='concluida').slice(0,30),planosClientesGMV:planos}).slice(0,120000)}]}),signal:AbortSignal.timeout(45000)});
    if(!r.ok)throw Error('Não foi possível gerar a estratégia. Tente novamente.');
    const data=await r.json();const texto=(data.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('\n');
    if(!texto)throw Error('A IA não retornou uma estratégia.');
    state.estrategia={mes,texto,em:new Date().toISOString(),receitaBase:receita.projetada};
   }else if(b.acao==='missao'){
    if(typeof b.titulo!=='string'||!b.titulo.trim()||b.titulo.length>240||typeof b.responsavel!=='string'||!b.responsavel.trim()||b.responsavel.length>100||typeof b.indicador!=='string'||!b.indicador.trim()||b.indicador.length>500||!/^20\d{2}-\d{2}-\d{2}$/.test(b.prazo||''))return res.status(400).json({error:'Preencha missão, responsável, indicador e prazo.'});
    if(state.missoes.length>=200)return res.status(400).json({error:'Limite de 200 missões atingido.'});
    state.missoes.push({id:require('node:crypto').randomUUID(),titulo:b.titulo.trim(),responsavel:b.responsavel.trim(),indicador:b.indicador.trim(),prazo:b.prazo,status:'pendente',mes,em:new Date().toISOString()});
   }else if(b.acao==='status'){
    const m=state.missoes.find(m=>m.id===b.id);if(!m||!['pendente','em_andamento','concluida'].includes(b.status))return res.status(400).json({error:'Missão ou status inválido.'});
    m.status=b.status;m.atualizadoEm=new Date().toISOString();
   }else return res.status(400).json({error:'Ação inválida.'});
   await db('glr_storage?on_conflict=chave',{method:'POST',headers:{Prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify({chave:'glr_adviser',dados:state,atualizado_em:new Date().toISOString()})});
  }
  return res.status(200).json({missoes:state.missoes,estrategia:state.estrategia,receita,progresso:progresso(receita.projetada)});
 }catch(e){return res.status(503).json({error:e.message||'Adviser indisponível.'});}
};
