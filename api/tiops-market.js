const {requireStaff}=require('./_auth');
const market=require('./_tiops-market');
module.exports=async(req,res)=>{
 res.setHeader('Cache-Control','private, no-store');
 if(!['GET','POST'].includes(req.method))return res.status(405).json({error:'Método inválido.'});
 if(!await requireStaff(req,res))return;
 if(req.method==='GET')return res.json(market.catalog);
 const b=req.body||{};
 if(b.acao==='descobrir'){try{return res.json(await market.descobrir(process.env.MCP_API_KEY,b.termo));}catch(e){return res.status(503).json({error:e.message});}}
 try{
  market.validate(b.action,b.params);
 }catch(e){return res.status(400).json({error:e.message});}
 try{return res.json(await market.consultar(process.env.MCP_API_KEY,b.action,b.params));}catch(e){return res.status(503).json({error:e.message});}
};
