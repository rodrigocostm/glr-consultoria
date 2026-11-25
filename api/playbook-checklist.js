const core=require('../js/playbook-checklist-core');
module.exports=async(req,res)=>{
 res.setHeader('Cache-Control','private, no-store');const user=await require('./_auth').requireStaff(req,res);if(!user)return;
 try{const ctx=await require('./_playbook').contexto(),{db,listar}=require('./_push-db');
 if(req.method==='POST'){const row=core.validar(req.body||{},ctx);await db('glr_playbook_checklist',{method:'POST',body:JSON.stringify({...row,autor:user.id})});return res.json({ok:true});}
 if(req.method!=='GET')return res.status(405).json({error:'Método inválido'});
 const ciclo=req.query?.ciclo||new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit'}).format(new Date());if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(ciclo))return res.status(400).json({error:'Ciclo inválido'});
 const rows=await listar('glr_playbook_checklist?ciclo=eq.'+ciclo+'&select=*&order=criado_em.desc,id.desc',100000);
 return res.json({...ctx,ciclo,rows:rows.filter(r=>ctx.contas.some(c=>c.key===r.conta&&c.cliente_id===r.cliente_id))});
 }catch(e){console.error('[checklist]',e.message);return res.status(400).json({error:e.message});}
};
