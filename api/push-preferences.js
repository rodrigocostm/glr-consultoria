const {db,vapid}=require('./_push-db');const {preferencias}=require('./_push-core');
module.exports=async(req,res)=>{
 if(!['GET','POST'].includes(req.method))return res.status(405).json({error:'Método inválido'});
 const user=await require('./_auth').requireStaff(req,res);if(!user)return;
 try{
  const endpoint=req.method==='GET'?req.query?.endpoint:req.body?.endpoint;
  if(!endpoint||typeof endpoint!=='string')return res.status(400).json({error:'Dispositivo não informado'});
  const path='push_subscriptions?user_id=eq.'+user.id+'&endpoint=eq.'+encodeURIComponent(endpoint);
  const rows=await db(path+'&select=endpoint,preferencias');
  if(!rows?.length)return res.status(404).json({error:'Ative as notificações neste dispositivo primeiro'});
  if(req.method==='GET')return res.json({preferencias:preferencias(rows[0].preferencias)});
  if(req.body.testar){
   const [s]=await db(path+'&select=endpoint,p256dh,auth');
   await vapid().sendNotification({endpoint:s.endpoint,keys:{p256dh:s.p256dh,auth:s.auth}},JSON.stringify({title:'GLR · Notificações funcionando',body:'Este é um teste do seu dispositivo. Vendas e alertas seguem suas preferências.',url:'/index.html',tag:'glr-teste'}),{TTL:300});
   return res.json({ok:true,enviado:true});
  }
  const p=preferencias(req.body.preferencias);await db(path,{method:'PATCH',body:JSON.stringify({preferencias:p})});return res.json({ok:true,preferencias:p});
 }catch(e){console.error('[push-preferences]',e.message);return res.status(503).json({error:'Não foi possível concluir. Confira a ativação e tente novamente.'});}
};
