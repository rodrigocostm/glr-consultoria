// Run from the repository root with Playwright installed. Optional GLR_BROWSER_PATH selects a local Chromium.
const {chromium}=require('playwright');
const fs=require('fs'),assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.GLR_BROWSER_PATH ? {executablePath:process.env.GLR_BROWSER_PATH} : {}),args:['--no-sandbox']});
 const page=await browser.newPage({viewport:{width:1440,height:1050}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const html=fs.readFileSync('index.html','utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
 await page.route('**/*',r=>{
  const u=new URL(r.request().url()),p=u.pathname;
  if(u.origin!=='http://glr.test')return r.abort();
  if(p==='/')return r.fulfill({contentType:'text/html',body:html});
  if(['/css/styles.css','/css/apple-interface.css','/logo.png'].includes(p))return r.fulfill({contentType:p.endsWith('.css')?'text/css':'image/png',body:fs.readFileSync('.'+p)});
  return r.fulfill({status:404,body:''});
 });
 await page.goto('http://glr.test/');
 await page.evaluate(()=>{
  document.body.classList.add('light');document.querySelector('#glr-loading-inicial').remove();document.querySelector('#app').style.visibility='visible';
  const actions=[{id:'a',conta:'A',loja:'Shopee · Conta de demonstração',titulo:'Recuperar a conversão dos produtos mais visitados',tipo:'funil',peso:900,quando:'hoje',quem:'analista',porque:'Visitas estáveis e conversão abaixo do período anterior. Validar preço, frete e disponibilidade.',impacto:'Impacto a validar',tela:'vendas'},
   {id:'b',conta:'A',loja:'Shopee · Conta de demonstração',titulo:'Conferir reposição antes de ampliar campanhas',tipo:'estoque',peso:500,quando:'semana',quem:'cliente',porque:'Verificar o saldo disponível e o prazo de reposição.',impacto:'Proteger as vendas'}];
  window.fixture={em:Date.now(),cliente:{id:1,nome:'Conta de demonstração',gestor:'Rodrigo',gestorId:1},semaforo:'amarelo',metricas:{tacos:6,projecao:200000,faturamento:100000,varMes:12,dia:1,diasMes:30},acoes:actions,oportunidades:actions,resultados:{medidas:0}};
  localStorage.setItem('glr_mc_vinculos',JSON.stringify({1:[{external_id:'A'}]}));
  window.GLR={clientes:[{id:1,nome:'Conta de demonstração',gestorId:1}],gestores:[{id:1,nome:'Rodrigo'}],tarefas:[],nextId:()=>1,ctx:{cliente:()=> '1',definir:()=>{}}};
  window.Router={register:(key,fn)=>window.planHandler=fn,navigate:()=>{}};
  window._sb={from:()=>({select(){return this},eq(){return this},then(resolve){resolve({data:[{cursor:window.fixture}]})}}),auth:{getUser:async()=>({data:{user:{email:'test@example.test'}}})}};
  document.querySelector('#page-title').textContent='Plano de ação';document.querySelector('#page-crumb').textContent='Hoje';
  document.querySelector('[data-page="plano-acao"]').classList.add('active');
 });
 for(const name of ['plano-oportunidades','pages-plano','nav'])await page.addScriptTag({content:fs.readFileSync(`js/${name}.js`,'utf8')});
 await page.evaluate(()=>planHandler({embed:true,clienteId:1},document.querySelector('#page-content')));
 await page.getByRole('heading',{name:'Oportunidades para vender com lucro'}).waitFor();
 await page.screenshot({path:'/tmp/glr-design-light.png',fullPage:true});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2),false,'desktop overflow');
 const light=await page.evaluate(()=>getComputedStyle(document.body).getPropertyValue('--accent').trim());assert.equal(light,'#0066cc');
 await page.evaluate(()=>document.body.classList.remove('light'));await page.waitForTimeout(300);await page.screenshot({path:'/tmp/glr-design-dark.png',fullPage:true});
 assert.equal(await page.evaluate(()=>getComputedStyle(document.body).getPropertyValue('--accent').trim()),'#409cff');
 await page.evaluate(()=>document.body.classList.add('light','sidebar-mini'));await page.waitForTimeout(300);
 assert.equal(await page.locator('#sidebar').evaluate(e=>Math.round(e.getBoundingClientRect().width)),72,'collapsed sidebar width');
 await page.evaluate(()=>document.body.classList.remove('sidebar-mini'));
 await page.setViewportSize({width:390,height:844});await page.waitForTimeout(350);assert.ok(await page.locator('#sidebar').evaluate(e=>e.getBoundingClientRect().right)<=1,'mobile sidebar hidden');await page.screenshot({path:'/tmp/glr-design-mobile.png',fullPage:true});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2),false,'mobile overflow');
 await page.getByRole('button',{name:'Abrir ou fechar menu'}).click();assert.equal(await page.locator('#sidebar').evaluate(e=>e.classList.contains('open')),true);
 const auth=fs.readFileSync('js/supabase-init.js','utf8');
 const login=auth.slice(auth.indexOf('function mostrarLogin('),auth.indexOf('// ── Fazer Login'));
 const recovery=auth.slice(auth.indexOf('function mostrarNovaSenha('),auth.indexOf('window.salvarNovaSenha ='));
 await page.addScriptTag({content:login+'\n'+recovery});
 await page.evaluate(()=>mostrarLogin('<img src=x onerror=alert(1)>'));
 assert.equal(await page.locator('.glr-auth-error').innerText(),'<img src=x onerror=alert(1)>');assert.equal(await page.locator('.glr-auth-error img').count(),0);
 assert.equal(await page.getByLabel('E-mail',{exact:true}).count(),1);assert.equal(await page.getByLabel('Senha',{exact:true}).count(),1);
 await page.screenshot({path:'/tmp/glr-design-login-mobile.png',fullPage:false});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2),false,'login overflow');
 await page.setViewportSize({width:1440,height:1000});await page.evaluate(()=>mostrarLogin());await page.screenshot({path:'/tmp/glr-design-login.png',fullPage:false});
 await page.evaluate(()=>mostrarNovaSenha('Confira a senha'));assert.equal(await page.getByLabel('Nova senha',{exact:true}).count(),1);
 assert.equal(await page.getByLabel('Confirme a senha',{exact:true}).count(),1);
 await page.emulateMedia({reducedMotion:'reduce'});
 assert.equal(await page.locator('.glr-auth-card').first().evaluate(e=>getComputedStyle(e).animationName),'none');
 assert.deepEqual(errors,[]);console.log('PASS: actual Chromium render, light/dark, desktop/mobile overflow, collapsed sidebar, mobile menu, accessible auth fields, literal error text, recovery, reduced motion');
 await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
