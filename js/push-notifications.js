// ============================================================
// GLR Consultoria — Notificações Push de Vendas
// ============================================================

const PushNotif = {
  VAPID_PUBLIC_KEY: 'BGb5KY1fVaS3DsUM_7e_maxoPeKsSgS-IrUh6xurx9fbwMRy52lJ_tKTz4hjT835JucN0Ryv60U8Y8ZrwK0q8sk',

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

  async ativar() {
    if (!this.suportado()) {
      alert('Seu navegador não suporta notificações push. Tente pelo Chrome ou Safari (iOS 16.4+, precisa "Adicionar à Tela de Início" antes de ativar).');
      return false;
    }
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      alert('Permissão de notificação negada. Ative manualmente nas configurações do navegador se mudar de ideia.');
      return false;
    }

    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;

      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: this._urlBase64ToUint8Array(this.VAPID_PUBLIC_KEY),
        });
      }

      const r = await fetch('/api/push-subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sub),
      });
      if (!r.ok) throw new Error('Falha ao registrar no servidor');

      localStorage.setItem('glr_push_ativo', '1');
      return true;
    } catch(e) {
      console.error('[Push] erro ao ativar:', e);
      alert('Erro ao ativar notificações: ' + e.message);
      return false;
    }
  },

  async desativar() {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        await fetch('/api/push-unsubscribe', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        }).catch(()=>{});
        await sub.unsubscribe();
      }
    } catch(e) { console.warn('[Push] erro ao desativar:', e); }
    localStorage.setItem('glr_push_ativo', '0');
  },

  async toggle() {
    if (this.ativo()) { await this.desativar(); return false; }
    return await this.ativar();
  },
};
