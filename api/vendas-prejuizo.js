module.exports=async(req,res)=>{
 if(req.method!=='GET')return res.status(405).json({error:'Método inválido'});
 if(!await require('./_auth').requireStaff(req,res))return;
 res.setHeader('Cache-Control','no-store');
 const {inicio,fim,conta,gestor}=req.query||{};
 const data=s=>Number.isFinite(Date.parse(s+'T12:00:00Z'))&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&new Date(s+'T12:00:00Z').toISOString().slice(0,10)===s;
 if((inicio&&!data(inicio))||(fim&&!data(fim))||!!inicio!==!!fim||(inicio&&(fim<inicio||Date.parse(fim)-Date.parse(inicio)>92*864e5))||(conta&&!/^(ml|shopee|amazon|tiktok|magalu|shein):[^:&?=]{1,150}$/.test(conta))||(gestor&&!/^[\w-]{1,100}$/.test(gestor)))return res.status(400).json({error:'Informe um período válido de até 93 dias e filtros válidos.'});
 try{const d=await require('./_vendas-prejuizo').carregar({inicio,fim,conta,gestor});delete d.cache;if(req.query?.resumo==='1')d.rows=[];return res.json(d);}catch(e){console.error('[vendas-prejuizo]',e.message);return res.status(503).json({error:'Não foi possível apurar as vendas. Reduza o período ou selecione uma conta e tente novamente.'});}
};
