const {db}=require('./_push-db');
const ACOES={read:'lida_em',unread:'lida_em',done:'tratada_em',reopen:'tratada_em'};
module.exports=async(req,res)=>{
 if(!['GET','POST'].includes(req.method))return res.status(405).json({error:'Método inválido'});
 const identity=await require('./_auth').requireEquipeOuPortal(req,res);if(!identity)return;const uid=identity.user.id,perfil=identity.role==='portal'?'portal':'consultoria',contas=(identity.portal?.contaIds||[]).map(String);
 const base='glr_notifications?user_id=eq.'+uid+'&perfil=eq.'+perfil+(perfil==='portal'?'&contas=cd.'+encodeURIComponent(JSON.stringify(contas))+'&contas=neq.%5B%5D':'');
 try{
  if(req.method==='GET'){
   await db('glr_notification_readers?on_conflict=user_id',{method:'POST',headers:{Prefer:'resolution=ignore-duplicates'},body:JSON.stringify({user_id:uid})});
   if(req.query?.counts==='1')return res.json({totais:await db('rpc/glr_notification_totals',{method:'POST',body:JSON.stringify({p_user:uid,p_perfil:perfil,p_contas:perfil==='portal'?contas:null})})});
   const filtro={unread:'&lida_em=is.null',pending:'&tratada_em=is.null',done:'&tratada_em=not.is.null',all:''}[req.query?.filter||'all'];
   if(filtro===undefined)return res.status(400).json({error:'Filtro inválido'});
   const offset=Math.max(0,Math.min(100000,parseInt(req.query?.offset,10)||0));
   const cat=String(req.query?.category||'');if(cat&&!/^[a-z_]{1,30}$/.test(cat))return res.status(400).json({error:'Categoria inválida'});

   const [rows,totais]=await Promise.all([db(base+filtro+(cat?'&categoria=eq.'+cat:'')+'&select=*&order=criado_em.desc,id&limit=50&offset='+offset),db('rpc/glr_notification_totals',{method:'POST',body:JSON.stringify({p_user:uid,p_perfil:perfil,p_contas:perfil==='portal'?contas:null})})]);
   return res.json({rows,totais,mais:rows.length===50});
  }
  const action=req.body?.action;
  if(action==='read_all'){await db(base+'&lida_em=is.null',{method:'PATCH',body:JSON.stringify({lida_em:new Date().toISOString()})});return res.json({ok:true});}
  if(!ACOES[action]||!/^[a-f0-9-]{36}$/i.test(String(req.body?.id||'')))return res.status(400).json({error:'Ação inválida'});
  const agora=new Date().toISOString(),dados={[ACOES[action]]:['unread','reopen'].includes(action)?null:agora};if(action==='done')dados.lida_em=agora;
  const rows=await db(base+'&id=eq.'+req.body.id,{method:'PATCH',headers:{Prefer:'return=representation'},body:JSON.stringify(dados)});
  if(!rows?.length)return res.status(404).json({error:'Notificação não encontrada'});return res.json({ok:true});
 }catch(e){console.error('[notifications]',e.message);return res.status(503).json({error:'Não foi possível carregar ou atualizar as notificações. Tente novamente.'});}
};
