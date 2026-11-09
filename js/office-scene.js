/* Illustrated office, deliberately independent of operational data.
   Status and interactions are supplied by pages-escritorio.js. */
window.GLROfficeScene = (() => {
  const positions = {
    gerente: [184,174,'Coordenação'],
    sync: [548,150,'Coletor'], precos: [704,150,'Preços'], estoque: [860,150,'Estoque'],
    margem: [548,372,'Margem'], shopee: [704,372,'ADS Shopee'], ml: [860,372,'ADS ML'],
    oport: [113,455,'Oportunidades'], qa: [285,455,'Qualidade'],
    promo: [550,698,'Promoções'], rep: [852,698,'Atendimento'], rel: [701,810,'Redator'],
  };
  const rect=(x,y,w,h,c,extra='')=>`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${c}" ${extra}/>`;
  function plant(x,y,s=1){return `<g transform="translate(${x} ${y}) scale(${s})"><ellipse cy="19" rx="22" ry="9" fill="#141c22" opacity=".3"/>${rect(-16,0,32,23,'#313e42')}${rect(-12,5,24,17,'#617376')}${rect(-9,9,6,11,'#83918a')}<path d="M-5 7L-23-1 -21-17 -8-13 -16-30 -3-32 4-15 12-31 24-23 15-9 28-5 21 9 7 4Z" fill="#365d42"/><path d="M-3 5L-17-8 -12-19 -3-12 1-27 8-22 7-8 19-18 20-7 8 6Z" fill="#64895a"/>${rect(-4,-14,7,13,'#82a66c')}</g>`;}
  function shelf(x,y,w=100){return `<g transform="translate(${x} ${y})">${rect(0,8,w,60,'#302c2a')}${rect(0,0,w,54,'#805537')}${rect(7,6,w-14,41,'#3a302b')}${Array.from({length:Math.floor((w-20)/11)},(_,i)=>rect(11+i*11,12,7,27,['#c1aa78','#476f73','#998d67','#a6694a'][i%4])).join('')}${rect(0,44,w,8,'#bc8a58')}${rect(0,0,w,6,'#d4a778')}</g>`;}
  function sofa(x,y,w=180){return `<g transform="translate(${x} ${y})">${rect(0,8,w,60,'#171f29','rx="7"')}${rect(0,0,w,57,'#354653','rx="7"')}${rect(8,8,w-16,19,'#53636e','rx="3"')}${rect(10,30,w/2-14,23,'#64717a','rx="3"')}${rect(w/2+3,30,w/2-14,23,'#566670','rx="3"')}${rect(-5,10,13,46,'#455561','rx="3"')}${rect(w-8,10,13,46,'#455561','rx="3"')}</g>`;}
  const room=(x,y,w,h,fill)=>`${rect(x+5,y+7,w,h,'#111a23')}${rect(x,y,w,h,fill)}${rect(x,y,w,13,'#e4dfcc')}${rect(x,y+13,w,12,'#757c77')}${rect(x,y,10,h,'#c8c9b8')}${rect(x+w-10,y,10,h,'#d5d6c5')}${rect(x,y+h-10,w,10,'#e5dfca')}`;
  const label=(x,y,text)=>`<text x="${x}" y="${y}" fill="#e3ddce" font-size="14" font-family="system-ui,sans-serif" font-weight="600" letter-spacing="3">${text}</text>`;
  function floor(){return `<svg class="office-floor" viewBox="0 0 960 1000" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><defs>
    <pattern id="of-wood" width="84" height="25" patternUnits="userSpaceOnUse"><rect width="84" height="25" fill="#ac8157"/><path d="M0 0H84M0 24H84M42 0V12M0 12H84M12 12V25" stroke="#805e41" stroke-width="1"/><path d="M4 5H32M48 17H75" stroke="#d3a477" opacity=".45"/></pattern>
    <pattern id="of-tile" width="42" height="42" patternUnits="userSpaceOnUse"><rect width="42" height="42" fill="#677471"/><rect x="1" y="1" width="40" height="40" fill="none" stroke="#9ca39a" opacity=".35"/></pattern>
    <pattern id="of-stone" width="70" height="70" patternUnits="userSpaceOnUse"><rect width="70" height="70" fill="#39434c"/><path d="M0 0H70V70H0Z" stroke="#525d63" fill="none"/><path d="M0 56L23 41 41 42 70 17M23 41L19 20" stroke="#657075" opacity=".25" fill="none"/></pattern>
    <pattern id="of-rug" width="28" height="28" patternUnits="userSpaceOnUse"><rect width="28" height="28" fill="#344553"/><path d="M14 3L25 14 14 25 3 14Z" stroke="#73858a" fill="none" stroke-width="2" opacity=".5"/></pattern>
    <linearGradient id="of-light" x2="0" y2="1"><stop stop-color="#f9d698" stop-opacity=".25"/><stop offset="1" stop-color="#f9d698" stop-opacity="0"/></linearGradient>
  </defs>
  ${rect(0,0,960,1000,'#222a35','rx="16"')}${rect(16,16,928,968,'url(#of-stone)')}
  ${room(24,24,340,332,'url(#of-wood)')}${room(470,24,466,560,'url(#of-tile)')}${room(24,380,340,247,'url(#of-wood)')}${room(24,650,340,326,'url(#of-wood)')}${room(470,610,466,366,'url(#of-wood)')}
  ${rect(48,53,292,54,'#8b6547')}${rect(58,58,272,42,'#bb9366')}${rect(133,60,120,38,'#3b3542')}${rect(140,65,106,26,'#ad7871')}<path d="M140 91V83H150V75H163V86H179V72H190V82H206V70H217V87H233V78H246V91Z" fill="#3a4758"/>
  ${shelf(55,111,62)}${shelf(268,111,62)}${rect(82,175,220,153,'#20303a')}${rect(89,182,206,139,'url(#of-rug)')}${rect(100,193,184,117,'none','stroke="#a2a38c" stroke-width="2"')}
  ${sofa(113,287,143)}${plant(55,317,.75)}${plant(330,315,.8)}
  ${rect(495,55,418,60,'#384b4f')}${rect(505,63,116,43,'#1a2934')}${rect(511,69,104,30,'#2c535c')}<path d="M517 92L535 88 548 94 563 79 580 82 594 73 608 76" stroke="#76c4b4" stroke-width="2" fill="none"/>
  ${rect(638,63,116,43,'#1a2934')}${rect(645,69,102,30,'#29434b')}${Array.from({length:7},(_,i)=>rect(653+i*12,92-i%3*7,7,5+i%3*7,'#719a88')).join('')}${rect(772,63,126,43,'#182934')}${rect(779,70,112,28,'#34535b')}
  <path d="M518 284H884M518 287H884" stroke="#465654" stroke-width="2"/><path d="M899 120V535H873" stroke="#9ca9a0" stroke-width="3" fill="none"/>
  ${plant(502,542,.85)}${plant(905,542,.85)}${label(515,310,'PERFORMANCE & OPERAÇÃO')}
  ${shelf(72,398,248)}${rect(53,590,282,15,'#73533d')}
  ${rect(49,679,289,64,'#d0c5a7')}${rect(49,732,289,15,'#776e5e')}${rect(58,687,58,40,'#41484a')}${rect(64,693,46,24,'#232d34')}${rect(73,719,28,7,'#bab4a2')}${rect(141,695,16,24,'#e8dfc9')}${rect(164,701,13,18,'#c4d5d6')}${rect(219,686,82,33,'#7f8979')}${plant(284,694,.55)}
  ${rect(63,775,262,157,'#35444d')}${rect(70,782,248,143,'url(#of-rug)')}${sofa(88,788,208)}${rect(118,868,150,50,'#554333')}${rect(114,863,150,46,'#c0986a')}${rect(129,872,34,24,'#d4d3bc')}${plant(239,874,.4)}${plant(52,947,.75)}${plant(334,947,.75)}
  ${rect(581,647,247,224,'#364755','rx="100"')}${rect(590,652,229,205,'#597078','rx="100"')}${rect(598,658,213,192,'#2b4853','rx="90"')}${rect(684,688,30,54,'#cabf9e')}${rect(680,771,40,28,'#e1ddcb')}${rect(633,752,23,31,'#c9d6cf')}${rect(754,754,23,31,'#dce3d7')}${plant(702,746,.65)}
  ${rect(495,648,44,37,'#d4dacd')}${rect(499,652,36,25,'#42616b')}${plant(902,942,.9)}${plant(500,942,.9)}
  ${rect(386,77,51,120,'#252f39')}${rect(392,83,39,105,'#556870')}${rect(400,93,23,48,'#9aaf9a')}<path d="M403 127L410 110 418 120 422 101" stroke="#3b695d" fill="none" stroke-width="3"/>
  ${plant(415,288,.8)}${plant(415,607,.8)}${rect(383,853,57,94,'#26343e')}${rect(390,858,43,73,'#77948e')}${rect(395,866,33,59,'#426567')}
  ${label(73,346,'COORDENAÇÃO')}${label(504,567,'DADOS • ADS')}${label(63,616,'INTELIGÊNCIA')}${label(97,963,'CAFÉ & PAUSA')}${label(608,963,'COLABORAÇÃO')}
  ${rect(24,24,340,90,'url(#of-light)')}${rect(24,380,340,70,'url(#of-light)')}${rect(470,610,466,70,'url(#of-light)')}
  <path d="M364 278H379V365M364 540H379V635M470 490H450V597M470 851H450V973" stroke="#d9d7c9" stroke-width="8" fill="none"/>
  <path d="M382 983H450" stroke="#d7bf8e" stroke-width="12"/>
  </svg>`;}
  function avatar(color,active,meeting=false){return `<svg viewBox="0 0 120 112" aria-hidden="true" class="office-sprite ${active?'is-active':''}">
    <ellipse cx="60" cy="95" rx="43" ry="10" fill="#15222c" opacity=".3"/>
    ${!meeting?`${rect(7,31,106,42,'#594231')}${rect(4,24,112,40,'#b78d60')}${rect(8,26,104,3,'#dcb78b')}${rect(18,0,66,39,'#1e2c35','rx="2"')}${rect(23,5,56,27,'#32545e')}${rect(47,39,8,8,'#22343d')}${rect(38,46,27,4,'#2d3940')}${rect(88,36,13,17,'#d9d6c5')}${rect(91,38,8,5,'#5b4937')}<path d="M28 13H65M28 20H56M28 27H70" class="office-screen-lines" stroke="${active?'#8cd2b9':'#65878b'}" stroke-width="2"/>${rect(27,52,46,7,'#364149')}`:''}
    ${rect(37,80,46,23,'#24333e','rx="5"')}${rect(40,88,40,16,'#4c5d68','rx="3"')}
    <g class="office-human">${rect(41,64,38,27,color,'rx="5"')}${rect(34,65,10,16,'#bf9575')}${rect(77,65,10,16,'#bf9575')}${rect(46,43,28,26,'#d6b18c','rx="4"')}${rect(43,40,34,12,'#3c3535','rx="3"')}${rect(43,47,6,11,'#3c3535')}${rect(69,47,8,8,'#3c3535')}${rect(48,42,22,4,'#625044')}${rect(50,59,20,8,'#b88769')}</g>
    </svg>`;}
  return {positions,floor,avatar};
})();
