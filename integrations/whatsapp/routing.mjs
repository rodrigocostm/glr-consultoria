export const BRIDGE_VERSION='equipe-2';
export const agents={adviser:['adviser','Adviser'],gerente:['esc:gerente','Gerente'],shopee:['esc:shopee','ADS Shopee'],ml:['esc:ml','ADS ML'],estoque:['esc:estoque','Estoque'],margem:['esc:margem','Margem'],atendimento:['esc:rep','Atendimento'],redator:['esc:rel','Redator']};
export function messageText(message){
 let body=message;
 for(let i=0;i<5;i++){
  const inner=body?.ephemeralMessage?.message||body?.viewOnceMessage?.message||body?.viewOnceMessageV2?.message||body?.viewOnceMessageV2Extension?.message||body?.documentWithCaptionMessage?.message;
  if(!inner)break;
  body=inner;
 }
 return body?.conversation||body?.extendedTextMessage?.text||'';
}
export function command(m,group,seen){if(!group?.endsWith('@g.us')||m.key?.remoteJid!==group||!m.key.id||seen.has(m.key.id))return null;const text=messageText(m.message).trim();if(text.trim().toLowerCase()==='!ping')return{alias:'ping',name:'Conexão',question:''};const match=text.match(/^!(\w+)\s+([\s\S]+)$/);if(!match||!agents[match[1].toLowerCase()])return null;const alias=match[1].toLowerCase(),question=match[2].trim();return question&&question.length<=6000?{alias,agent:agents[alias][0],name:agents[alias][1],question}:null;}

export function liveEvent(m,type,activatedAt){if(type==='notify')return true;if(type!=='append'||!activatedAt)return false;const t=Number(m.messageTimestamp);return Number.isFinite(t)&&t>=activatedAt&&t<=Date.now()/1000+60;}
