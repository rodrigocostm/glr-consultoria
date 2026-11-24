// Playbook: calculadora de cenários, sem persistência ou alterações em contas.
Router.register('playbook-glr', function(params, el) {
  if(window._portalConfig){el.textContent='Acesso restrito à equipe.';return;}
  el.innerHTML='<h2>Playbook GLR — Planejamento estratégico</h2><p>Simulação de metas por operação. Não altera campanhas nem salva metas.</p><form id="glr-pb-form" style="display:grid;gap:12px;max-width:560px"><label>Cliente <select name="client" required></select></label><label>Marketplace <select name="channel">'+GLRPlaybook.channels.map(c=>'<option>'+c+'</option>').join('')+'</select></label><label>Faturamento de referência (R$) <input name="base" type="number" min="0" step="0.01" required></label><label>Crescimento conservador (%) <input name="low" type="number" min="-100" step="0.1" required></label><label>Crescimento realista (%) <input name="mid" type="number" min="-100" step="0.1" required></label><label>Crescimento agressivo (%) <input name="high" type="number" min="-100" step="0.1" required></label><button type="submit">Calcular cenários</button></form><div id="glr-pb-result" aria-live="polite" style="margin-top:16px"></div><p><button id="glr-pb-decisions">Abrir caixa de decisões</button></p>';
  const select=el.querySelector('[name="client"]');
  select.add(new Option('Selecione o cliente',''));
  const clients=(typeof GLR!=='undefined' && Array.isArray(GLR.clientes))?GLR.clientes:[];
  clients.forEach(c=>{if(c.id!=null)select.add(new Option(String(c.nome||c.id),String(c.id)));});
  if(!clients.length)el.querySelector('button[type="submit"]').disabled=true;
  el.querySelector('#glr-pb-decisions').onclick=()=>Router.navigate('decisoes');
  el.querySelector('form').onsubmit=e=>{
    e.preventDefault();
    const f=new FormData(e.currentTarget), out=el.querySelector('#glr-pb-result');
    try {
      const rows=GLRPlaybook.scenarios(Number(f.get('base')),['low','mid','high'].map(k=>Number(f.get(k))/100));
      out.textContent=select.selectedOptions[0].text+' — '+f.get('channel')+' — '+rows.map(r=>r.name+': '+r.target.toLocaleString('pt-BR',{style:'currency',currency:'BRL'})).join(' | ');
    } catch(err){out.textContent='Confira os valores e a ordem dos três cenários.';}
  };
});
