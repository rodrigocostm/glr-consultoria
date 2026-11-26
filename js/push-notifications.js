// ============================================================
// GLR Consultoria — Notificações Push de Vendas
// ============================================================

const PushNotif = {
  VAPID_PUBLIC_KEY: '',

  suportado() {
    return ('Notification' in window) && ('serviceWorker' in navigator) && ('PushManager' in window);
  },

  ativo() {
    return this.suportado() && Notification.permission === 'granted' && localStorage.getItem('glr_push_ativo') === '1';
  },

  _urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
  },

  async _headers() {
    const {data}=await _sb.auth.getSession();
    if (!data?.session?.access_token) throw new Error('Entre novamente na sua conta para ativar notificações.');
    return {'Content-Type':'application/json',Authorization:'Bearer '+data.session.access_token};
  },
  async ativar() {
    if (!this.suportado()) {
      GLR.avisar('Seu navegador não suporta notificações push. Tente pelo Chrome ou Safari (iOS 16.4+, precisa "Adicionar à Tela de Início" antes de ativar).', 'info');
      return false;
    }
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      GLR.avisar('Permissão de notificação negada. Ative manualmente nas configurações do navegador se mudar de ideia.', 'info');
      return false;
    }

    try {
      const cfgResponse=await fetch('/api/push-subscribe',{headers:await this._headers()});
      const cfg=await cfgResponse.json();
      if(!cfgResponse.ok || !cfg.pronto) throw new Error(cfg.error || 'Envio push ainda não configurado no servidor');
      this.VAPID_PUBLIC_KEY=cfg.publicKey;
      const reg = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;

      let sub = await reg.pushManager.getSubscription();
      if (sub) {
        const atual=sub.options?.applicationServerKey;
        const nova=this._urlBase64ToUint8Array(this.VAPID_PUBLIC_KEY);
        if(!atual || new Uint8Array(atual).some((v,i)=>v!==nova[i]) || atual.byteLength!==nova.length){await sub.unsubscribe();sub=null;}
      }
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: this._urlBase64ToUint8Array(this.VAPID_PUBLIC_KEY),
        });
      }

      const r = await fetch('/api/push-subscribe', {
        method: 'POST',
        headers: await this._headers(),
        body: JSON.stringify(sub),
      });
      if (!r.ok) { const erro=await r.json().catch(()=>({})); throw new Error(erro.error || 'Falha ao registrar no servidor ('+r.status+')'); }

      localStorage.setItem('glr_push_ativo', '1');
      return true;
    } catch(e) {
      console.error('[Push] erro ao ativar:', e);
      GLR.avisar('Erro ao ativar notificações: ' + e.message, 'erro');
      return false;
    }
  },

  async desativar() {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        await fetch('/api/push-unsubscribe', {
          method: 'POST', headers: await this._headers(),
          body: JSON.stringify({ endpoint: sub.endpoint }),
        }).catch(()=>{});
        await sub.unsubscribe();
      }
    } catch(e) { console.warn('[Push] erro ao desativar:', e); }
    localStorage.setItem('glr_push_ativo', '0');
  },

  async _sub() { return (await navigator.serviceWorker.getRegistration())?.pushManager.getSubscription(); },
  async _api(body) {
    const r=await fetch('/api/push-preferences',{method:'POST',headers:await this._headers(),body:JSON.stringify(body)});
    const d=await r.json();if(!r.ok)throw new Error(d.error || 'Falha ao salvar');return d;
  },
  async abrir() {
    let perfil;
    try{const r=await fetch('/api/push-subscribe',{headers:await this._headers()});perfil=await r.json();if(!r.ok)throw Error(perfil.error || 'Não foi possível verificar seu perfil');}catch(e){GLR.avisar(e.message, 'erro');return;}
    const portal=perfil.perfil==='portal';
    const opcoes=portal?[['vendas','Vendas das minhas contas'],['saldo','Saldo de Ads das minhas contas'],['metas','Minhas metas'],['resumo_diario','Resumo do dia anterior · 0h'],['projecao','Minha projeção entrou em queda'],['curva_a','Produto curva A sem estoque']]:[['vendometro','Resumo geral do Vendômetro · 9h, 13h, 18h e 22h'],['saldo','Saldo de Ads baixo ou zerado · identifica a conta'],['oscilacao','Oscilação de Ads · identifica a conta (50% e R$ 100)'],['resumo_diario','Resumo do dia anterior · 0h'],['gestores','Gestor bateu a meta diária'],['projecao','Cliente entrou com projeção em queda'],['curva_a','Produto curva A sem estoque'],['prejuizo','Produto vendido com prejuízo']];
    document.getElementById('glr-push-panel')?.remove();
    const d=document.createElement('dialog');d.id='glr-push-panel';
    d.style.cssText='width:min(480px,92vw);max-height:85vh;overflow:auto;padding:24px;border-radius:18px;border:1px solid var(--border);background:var(--bg-card,#fff);color:var(--text-primary,#111)';
    d.innerHTML=`<h2 style="margin-top:0">Notificações · ${portal?'Portal do cliente':'Consultoria GLR'}</h2><p>${portal?'Avisos somente das contas autorizadas do seu portal.':'Resultado geral da carteira no Vendômetro. Resumos gerais e exceções por cliente para Ads, queda de projeção e ruptura de curva A.'} Checagem a cada 5 minutos, conforme a atualização da base.</p>
    ${opcoes.map(([k,t])=>`<label style="display:block;margin:12px 0"><input type="checkbox" data-push="${k}" checked> ${t}</label>`).join('')}
    <label style="display:block;margin-top:16px">Contas <select id="push-contas" multiple size="5" style="display:block;width:100%;margin-top:8px"></select></label><small>Sem seleção = ${portal?'todas as suas contas autorizadas':'toda a carteira vinculada da consultoria'}. Toque nas contas para filtrar.</small>
    <label style="display:block;margin:16px 0"><input type="checkbox" data-push="silencio" checked> Horário de silêncio (Brasília)</label><label>Das <input id="push-inicio" type="number" min="0" max="23" value="23" style="width:60px"> às <input id="push-fim" type="number" min="0" max="23" value="7" style="width:60px"> horas</label>
    <p id="push-status" role="status">Carregando preferências…</p><div style="display:flex;gap:8px;flex-wrap:wrap"><button id="push-save" class="btn btn-primary">Ativar e salvar</button><button id="push-test" class="btn btn-secondary">Enviar teste</button><button id="push-off" class="btn btn-secondary">Desativar</button><button id="push-close" class="btn btn-secondary">Fechar</button></div>`;
    document.body.append(d);d.showModal();
    const status=d.querySelector('#push-status'),statusMsg=t=>status.textContent=t;
    d.querySelector('#push-close').onclick=()=>d.close();
    let pronto=false;
    try {
      const contas=await MarketplaceAPI.listAccounts();const select=d.querySelector('#push-contas');
      const ids=new Set();for(const c of contas || []){const id=String(c.param_to_use?.shopId || c.param_to_use?.meliUserId || c.param_to_use?.amazon_account_id || c.external_id);if(!id||ids.has(id)||(portal&&!(perfil.contasPermitidas||[]).map(String).includes(id)))continue;ids.add(id);const o=document.createElement('option');o.value=id;o.textContent=(c.nickname || c.shop_name || id)+' · '+(c.marketplace||'');select.append(o);}
      const sub=await this._sub();
      if(sub){const r=await fetch('/api/push-preferences?endpoint='+encodeURIComponent(sub.endpoint),{headers:await this._headers()});const data=await r.json();if(!r.ok && r.status!==404)throw Error(data.error || 'Falha ao carregar preferências');if(r.ok){const p=data.preferencias;for(const el of d.querySelectorAll('[data-push]'))el.checked=p[el.dataset.push]!==false;for(const o of select.options)o.selected=p.contas.includes(o.value);d.querySelector('#push-inicio').value=p.inicio;d.querySelector('#push-fim').value=p.fim;}}
      pronto=true;statusMsg('Escolha os alertas e salve. O resumo de 0h e o teste ignoram o horário de silêncio. Os demais avisos respeitam o silêncio.');
    } catch(e){statusMsg('Não foi possível carregar as preferências. Feche e tente novamente.');}
    d.querySelector('#push-save').onclick=async()=>{
      if(!pronto)return;
      const p={contas:[...d.querySelector('#push-contas').selectedOptions].map(o=>o.value),inicio:+d.querySelector('#push-inicio').value,fim:+d.querySelector('#push-fim').value};for(const el of d.querySelectorAll('[data-push]'))p[el.dataset.push]=el.checked;
      if(!Number.isInteger(p.inicio)||p.inicio<0||p.inicio>23||!Number.isInteger(p.fim)||p.fim<0||p.fim>23){statusMsg('Informe horas de 0 a 23.');return;}
      try{if(!await this.ativar())return;const sub=await this._sub();await this._api({endpoint:sub.endpoint,preferencias:p});statusMsg('Notificações ativas e preferências salvas neste dispositivo.');if(typeof _atualizarIconePush==='function')_atualizarIconePush();}catch(e){statusMsg(e.message);}
    };
    d.querySelector('#push-test').onclick=async()=>{try{const sub=await this._sub();if(!sub || !this.ativo())throw Error('Ative e salve primeiro.');await this._api({endpoint:sub.endpoint,testar:true});statusMsg('Teste enviado. Confira a notificação no iPhone.');}catch(e){statusMsg(e.message);}};
    d.querySelector('#push-off').onclick=async()=>{await this.desativar();statusMsg('Notificações desativadas neste dispositivo.');if(typeof _atualizarIconePush==='function')_atualizarIconePush();};
  },
  async toggle() {
    if (this.ativo()) { await this.desativar(); return false; }
    return await this.ativar();
  },
};




