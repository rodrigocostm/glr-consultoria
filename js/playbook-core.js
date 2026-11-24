// GLR Playbook — pure planning and validation primitives. No writes or marketplace calls.
(function(root){
  'use strict';
  const channels=Object.freeze(['shopee','mercado-livre','tiktok-shop','amazon','magalu']);
  const valid=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0;
  function scenarios(base,rates){
    if(!valid(base)||!Array.isArray(rates)||rates.length!==3||rates.some(r=>typeof r!=='number'||!Number.isFinite(r)||r< -1)||rates[0]>rates[1]||rates[1]>rates[2]) throw new Error('Cenários inválidos');
    return ['conservador','realista','agressivo'].map((name,i)=>({name,growth:rates[i],target:Math.round(base*(1+rates[i])*100)/100}));
  }
  function tacos(revenue,ads){return valid(revenue)&&revenue>0&&valid(ads)?ads/revenue:null;}
  function adsCapacity(margin,target){return valid(margin)&&valid(target)&&margin<=1&&target<=1?Math.max(0,margin-target):null;}
  function assess(before,after,{comparable=false,confounded=false}={}){
    if(!comparable||confounded||!before||!after||![before.profit,after.profit].every(Number.isFinite))return 'inconclusiva';
    return after.profit>before.profit?'positiva':after.profit<before.profit?'negativa':'inconclusiva';
  }
  const api=Object.freeze({channels,scenarios,tacos,adsCapacity,assess});
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  else root.GLRPlaybook=api;
})(typeof globalThis!=='undefined'?globalThis:this);
