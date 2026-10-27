// Browser integration checks with fixed sample sessions (no private logs).
// Requires Google Chrome; WMAD_HEADED=1 opens visible test windows.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
process.env.WMAD_NO_UPDATE_CHECK = '1';
const { DemoWatcher } = require('../src/demo');
const { createServer } = require('../src/server');
const screenshots = process.env.WMAD_SCREENSHOTS;
async function screenshot(page, name) {
  if (!screenshots) return;
  fs.mkdirSync(screenshots, { recursive: true });
  await page.screenshot({ path: path.join(screenshots, name + '.png') });
}
const checks=[];
const check=(name)=>{checks.push(name);console.log('PASS',name)};
const sessions = [
 {key:'claude:one', id:'one', agent:'claude',project:'claude-project',status:'thinking'},
 {key:'codex:two', id:'two', agent:'codex',project:'codex-project',status:'waiting'},
 {key:'gemini:three', id:'three', agent:'gemini',project:'gemini-project',status:'tool',activity:'Read: index.js'},
 {key:'claude:done', id:'done', agent:'claude',project:'finished-project',status:'done'},
 {key:'codex:sub', id:'sub', agent:'codex',project:'sub-project',status:'thinking',subagent:true},
].map(s=>({...s,lastEventAt:Date.now(),turnStartedAt:Date.now()-1000,cwd:'/demo/'+s.project}));
async function stable(page){
 await page.waitForFunction(()=>typeof office!=='undefined' && office?.framesShown>4);
 await page.evaluate(s=>{window.__events?.close();onData({now:Date.now(),sessions:s})},sessions);
}
async function openSettings(page) {
 if (!(await page.locator('#settingsMenu').getAttribute('open') !== null)) await page.click('#settingsMenu > summary');
}
async function badges(target){
 return target.evaluate(()=>{
  const found=[];const original=office.agentBadge;
  office.agentBadge=function(a,...rest){found.push(a.short);return original.call(this,a,...rest)};
  office.frame(performance.now());office.agentBadge=original;return found;
 });
}
async function drawnLogos(target) {
 await target.waitForFunction(()=>Object.values(OFFICE_AGENT_BADGES).every(b=>b.image.complete&&b.image.naturalWidth>0));
 return target.evaluate(()=>{
  const found=new Set();const ctx=office.ctx;const original=ctx.drawImage;
  ctx.drawImage=function(img,...args){
   for(const [key,badge] of Object.entries(OFFICE_AGENT_BADGES)) if(img===badge.image) found.add(key);
   return original.call(this,img,...args);
  };
  try {office.frame(performance.now());} finally {ctx.drawImage=original;}
  return [...found].sort();
 });
}
(async()=>{
 const watcher = new DemoWatcher().start();
 const server = createServer(watcher, { demo: true, privacy: false });
 await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
 const base = `http://127.0.0.1:${server.address().port}`;
 let browser;
 const errors=[];
 try {
  const translations = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/i18n.js'), 'utf8'), translations);
  const keys = Object.keys(translations.window.I18N.en).sort();
  for (const lang of Object.values(translations.window.I18N)) assert.deepEqual(Object.keys(lang).sort(), keys);
  check('all nine languages provide every UI string');
  browser=await chromium.launch({headless:process.env.WMAD_HEADED !== '1',channel:'chrome',ignoreDefaultArgs:['--disable-background-timer-throttling','--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding'],args:['--window-size=1280,960']});
  const context=await browser.newContext({viewport:{width:1280,height:960},locale:'en-US'});
  await context.addInitScript(sessions=>{
   window.EventSource=class {constructor(){window.__events=this;setTimeout(()=>{if(!this.closed)this.onmessage?.({data:JSON.stringify({now:Date.now(),sessions})})},0)}close(){this.closed=true}};
   window.__notifications=[];
   window.Notification=class {static permission='granted';constructor(title,options){window.__notifications.push({title,options})}};
  },sessions);
  context.on('page',p=>p.on('pageerror',e=>errors.push(String(e))));
  const page=await context.newPage();await page.goto(base);await stable(page);
  assert.equal(await page.locator('h1 [data-t]').innerText(),'What are my agents doing');
  assert.equal(await page.locator('#showAgent').isChecked(),true);
  assert.deepEqual([...new Set(await badges(page))].sort(),['Cl','Cx','G']);
  assert.deepEqual(await drawnLogos(page),['claude','codex','gemini']);
  assert.equal(await page.locator('#agentLegend img').evaluateAll(imgs=>imgs.length===3&&imgs.every(img=>img.complete&&img.naturalWidth>0)),true);
  const readable=await page.evaluate(async()=>{const r=await fetch('/assets/agents/codex.svg');const c=document.createElement('canvas');c.width=c.height=20;const x=c.getContext('2d');x.drawImage(OFFICE_AGENT_BADGES.codex.image,0,0,20,20);return {type:r.headers.get('content-type'),px:x.getImageData(10,2,1,1).data[3]>0,url:office.canvas.toDataURL().length>100};});
  assert.deepEqual(readable,{type:'image/svg+xml',px:true,url:true});
  check('all local provider badges load and draw in 2D and the legend; SVG keeps the canvas readable');
  await openSettings(page);await page.check('#showSub');
  assert.equal((await badges(page)).length,5);
  check('2D badges identify all three providers and subagents without duplicate activity badges');
  const seatGap=await page.evaluate(()=>{
   const now=Date.now();
   const mk=(key,extra)=>({key,id:key.split(':')[1],agent:key.split(':')[0],project:key,status:'tool',lastEventAt:now,startedAt:now,...extra});
   office.update([
    mk('claude:parent',{startedAt:now-4000}),
    mk('claude:fill1',{startedAt:now-3000}),mk('gemini:fill2',{startedAt:now-2000}),
    mk('codex:child',{startedAt:now-1000,subagent:true,parentId:'parent',spawnedBy:'claude'}),
   ]);
   const seat=(k)=>office.plan.desks[office.deskOf.get(k)].seat;
   const a=seat('claude:parent'),b=seat('codex:child');
   return Math.hypot(a.x-b.x,a.y-b.y);
  });
  await page.evaluate(s=>onData({now:Date.now(),sessions:s}),sessions);
  assert.ok(seatGap<3,`subagent sits ${seatGap.toFixed(2)} from its parent`);
  check('a subagent takes the free desk nearest its parent');
  const offDesk=await page.evaluate(()=>{
   const now=Date.now();
   const mk=(i,status)=>({key:`claude:off${i}`,id:`off${i}`,agent:'claude',project:'p',status,lastEventAt:now-i,startedAt:now});
   office.update([...Array(10)].map((_,i)=>mk(i,i%2?'done':'idle')));
   const seats=office.plan.desks.map(d=>d.seat);
   let onDesk=0,badStay=0;
   for(let round=0;round<40;round++) for(const p of office.people.values()){
    p.path=[];p.until=0;office.wander(p,Date.now());
    if(p.poi&&seats.some(q=>Math.hypot(q.x-p.poi.x,q.y-p.poi.y)<0.05)) onDesk++;
    if(p.poi&&!(p.poi.pair?p.stay>=15000&&p.stay<=30000:p.stay>=30000&&p.stay<=90000)) badStay++;
   }
   return {onDesk,badStay,offDuty:office.offDuty};
  });
  assert.deepEqual(offDesk,{onDesk:0,badStay:0,offDuty:3});
  check('done and idle agents never take a desk, linger 30-90s (games 15-30s); past the wanderer cap they count as not shown');
  const deskless=await page.evaluate(()=>{
   const now=Date.now();
   office.plan.fixed=true;office.plan.desks=office.plan.desks.slice(0,1);office.deskOf.clear();
   office.update([1,2,3].map(i=>({key:`codex:w${i}`,id:`w${i}`,agent:'codex',project:'p',status:'tool',lastEventAt:now,startedAt:now+i})));
   return office.offDuty;
  });
  assert.equal(deskless,2);
  check('working sessions without a desk in a fixed plan count as not shown');
  await page.reload();await stable(page);
  assert.deepEqual(await page.evaluate(()=>[office.label({title:'tg2082-sql',project:'okcloud',agent:'claude'}),office.label({project:'okcloud',agent:'claude'})]),['tg2082-sql','okcloud']);
  check('name tags show the session name, falling back to the project folder');
  const hold=await page.evaluate(()=>{
   const p=[...office.people.values()][0];
   p.path=[{x:p.x+3,y:p.y}];p.leaving=false;
   const x0=p.x;office.hoverKey=p.key;office.step(0.3);
   const held={moved:p.x!==x0,pose:office.stateOf(p).pose,path:p.path.length};
   office.hoverKey=null;office.holdKey=p.key;office.step(0.3);const pinnedMoved=p.x!==x0;
   p.leaving=true;office.step(0.3);const leavingMoved=p.x!==x0;
   p.leaving=false;office.holdKey=null;office.step(0.3);
   return {...held,pinnedMoved,leavingMoved,resumed:p.x!==x0};
  });
  assert.deepEqual(hold,{moved:false,pose:'stand',path:1,pinnedMoved:false,leavingMoved:true,resumed:true});
  check('a hovered or pinned walker stops in place and resumes; leaving people are never held');
  const chips=await page.evaluate(()=>{
   const n=[...document.querySelectorAll('#summary .chip b')].map(b=>+b.textContent);
   const present=state.data.sessions.filter(s=>s.alive!==false&&(state.showSub||!s.subagent)).length;
   return {count:n.length,sum:n.reduce((a,b)=>a+b,0),present};
  });
  assert.equal(chips.count,4);assert.equal(chips.sum,chips.present);
  check('four summary chips add up to the sessions present');
  await page.click('#viewSeg [data-v=guide]');
  assert.equal(await page.locator('#officeWrap').isVisible(),false);
  assert.match(await page.locator('main .guide').textContent(),/Done vs Idle/);
  await page.waitForTimeout(1200);assert.equal(await page.locator('main .guide').count(),1);
  await openSettings(page);await page.selectOption('#langSel','zh-TW');
  assert.match(await page.locator('main .guide').textContent(),/Done 和 Idle 的差別/);
  await openSettings(page);await page.selectOption('#langSel','auto');
  await page.click('#viewSeg [data-v=office]');await stable(page);
  assert.equal(await page.locator('#officeWrap').isVisible(),true);
  check('guide tab renders, survives refreshes, follows language and switches back');
  const deleg=await page.evaluate(()=>{
   const now=Date.now();
   const base=state.data.sessions;
   const p=(over)=>({key:'claude:dp',id:'dp',agent:'claude',project:'deleg',alive:true,lastEventAt:now,startedAt:now,...over});
   const feed=(over)=>onData({now:Date.now(),sessions:[...base,p(over)]});
   const n0=window.__notifications.length;
   feed({status:'thinking'});feed({status:'tool',delegating:2});
   const seated=office.deskOf.has('claude:dp');
   const n1=window.__notifications.length;
   feed({status:'done'});const n2=window.__notifications.length;
   feed({status:'thinking'});feed({status:'waiting'});const n3=window.__notifications.length;
   feed({status:'tool',delegating:1});feed({status:'waiting'});const n4=window.__notifications.length;
   feed({status:'tool',delegating:2,reply:'all set',turnStartedAt:now-3600_000,lastEventAt:now});
   return {seated,first:n1-n0,again:n2-n1,waiting:n3-n2,fromDeleg:n4-n3};
  });
  assert.deepEqual(deleg,{seated:true,first:1,again:0,waiting:1,fromDeleg:1});
  await page.click('#viewSeg [data-v=list]');
  const card=page.locator('.card[data-key="claude:dp"]');
  assert.match(await card.locator('.act').innerText(),/waiting for 2 subagents/);
  assert.equal(await card.locator('.r').innerText(),'all set');
  assert.equal(await page.locator('section',{has:card}).locator('h2').evaluate(h=>h.textContent.startsWith(L.working)),true);
  await page.evaluate(()=>{const now=Date.now();onData({now,sessions:[...state.data.sessions.filter(s=>s.key!=='claude:dp'),{key:'claude:dp',id:'dp',agent:'claude',project:'deleg',alive:true,status:'tool',delegating:1,bgTasks:2,reply:'polling',lastEventAt:now,startedAt:now}]});});
  assert.match(await card.locator('.act').innerText(),/waiting for 1 subagent · waiting for 2 background tasks/);
  assert.equal(await card.locator('.r').innerText(),'polling');
  await page.evaluate(s=>onData({now:Date.now(),sessions:s}),sessions);
  await page.click('#viewSeg [data-v=office]');await stable(page);
  check('a parent waiting on subagents keeps its desk, counts as working and notifies once');
  const fit=async()=>page.evaluate(()=>({scroll:document.documentElement.scrollHeight<=innerHeight,office:document.getElementById('office').getBoundingClientRect().height,legendBottom:document.getElementById('agentLegend').getBoundingClientRect().bottom,inner:innerHeight}));
  let f=await fit();
  assert.equal(f.scroll,true);assert.ok(f.office>560,`office ${f.office}px should fill a 960px window`);assert.ok(f.legendBottom<=f.inner);
  await page.setViewportSize({width:1280,height:600});await page.waitForTimeout(200);
  f=await fit();assert.equal(f.scroll,true);assert.ok(f.office>=300);
  await page.setViewportSize({width:560,height:700});await page.waitForTimeout(200);
  await openSettings(page);
  const panelBottom=await page.evaluate(()=>document.getElementById('settingsPanel').getBoundingClientRect().bottom<=innerHeight&&document.documentElement.scrollHeight<=innerHeight);
  assert.equal(panelBottom,true);
  await page.keyboard.press('Escape');
  await page.setViewportSize({width:1280,height:960});await page.waitForTimeout(200);
  check('office view fills the window without a page scrollbar; settings panel stays on screen');
  await openSettings(page);await page.uncheck('#showAgent');assert.equal((await badges(page)).length,0);
  assert.equal(await page.locator('#agentLegend').isVisible(),false);
  await page.reload();await stable(page);assert.equal(await page.locator('#showAgent').isChecked(),false);
  await openSettings(page);await page.check('#showAgent');check('badge toggle hides markers and legend and persists across reload');
  await page.click('#qualSeg [data-v=high]');
  await page.waitForFunction(()=>officeKind==='high:office'&&office?.loaded&&office.framesShown>4,{},{timeout:30000});
  assert.deepEqual([...new Set(await badges(page))].sort(),['Cl','Cx','G']);
  await screenshot(page, 'office-3d');
  assert.deepEqual(await drawnLogos(page),['claude','codex','gemini']);
  check('3D renders the same provider badges');
  const other=await context.newPage();await other.goto(base);await stable(other);
  await openSettings(page);await page.click('#agentSeg [data-v=codex]');await other.waitForFunction(()=>state.agent==='codex');
  await openSettings(other);await other.click('#agentSeg [data-v=all]');await page.waitForFunction(()=>state.agent==='all');
  await other.close();await page.bringToFront();await page.keyboard.press('Escape');
  await page.waitForFunction(()=>office?.framesShown>4,{},{timeout:30000});
  check('preferences synchronize between open tabs in both directions');
  assert.equal(await page.locator('#pipBtn').count(),0);
  assert.equal(await page.evaluate(async()=>(await fetch('/popout.js')).status),404);
  check('the pop-out feature is gone');
  // Scheduler: 5fps on a timer while calm, 30fps on rAF while lively or woken.
  const rate=await page.evaluate(()=>new Promise(r=>{
   let n=0,rafs=0;const f=office.frame,ra=window.requestAnimationFrame;
   // A residual 3D camera glide would wake the scheduler; hold the view still.
   const cu=office.controls&&office.controls.update;if(cu)office.controls.update=()=>false;
   office.frame=function(t){n++;return f.call(this,t)};
   window.requestAnimationFrame=(cb)=>{rafs++;return ra(cb)};
   const dts=[];const st=office.step;office.step=function(dt){dts.push(dt);return st.call(this,dt)};
   office.lively=()=>false;office.activeUntil=0;
   setTimeout(()=>{n=0;rafs=0;dts.length=0;setTimeout(()=>{
    const calm={frames:n,rafs,dt:dts.slice(1).reduce((x,y)=>x+y,0)/Math.max(1,dts.length-1)};
    office.lively=()=>true;n=0;
    setTimeout(()=>{
     const lively=n;office.lively=()=>false;office.activeUntil=0;
     setTimeout(()=>{
      n=0;office.root.dispatchEvent(new PointerEvent('pointermove',{bubbles:true}));
      setTimeout(()=>{
       const woken=n;n=0;
       Object.defineProperty(document,'hidden',{get:()=>true,configurable:true});document.dispatchEvent(new Event('visibilitychange'));
       setTimeout(()=>{const hidden=n;delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));
        delete office.frame;delete office.step;delete office.lively;window.requestAnimationFrame=ra;if(cu)delete office.controls.update;
        r({calm,lively,woken,hidden});},700);
      },500);
     },1300);
    },1000);
   },2000);},400);
  }));
  assert.ok(rate.calm.frames>=7&&rate.calm.frames<=12,`calm drew ${rate.calm.frames} frames in 2s`);
  assert.ok(rate.calm.rafs<=rate.calm.frames+3,`calm made ${rate.calm.rafs} rAF calls for ${rate.calm.frames} frames`);
  assert.ok(rate.calm.dt>0.15&&rate.calm.dt<=0.25,`calm step dt ${rate.calm.dt}`);
  assert.ok(rate.lively>=24&&rate.lively<=32,`lively drew ${rate.lively} frames in 1s`);
  assert.ok(rate.woken>=11,`pointer wake drew ${rate.woken} frames in 0.5s`);
  assert.equal(rate.hidden,0);
  const live=await page.evaluate(()=>{
   const saved=[...office.people.values()].map(p=>({p,path:p.path,poi:p.poi,until:p.until}));
   const cat=office.cat.path;office.cat.path=[];
   for(const x of saved){x.p.path=[];x.p.until=Infinity;}
   for(const q of office.plan.pois)if(q.pair)q.__t=q.taken,q.taken=null;
   const still=office.lively();
   const p=saved[0].p;p.path=[{x:p.x+1,y:p.y}];const walk=office.lively();p.path=[];
   const pp=office.plan.pois.filter(q=>q.pair==='pp');const [a,b]=[saved[0].p,saved[1]?.p];
   let game=null;if(b){pp[0].taken=a.key;pp[1].taken=b.key;const pa=a.poi,pb=b.poi;a.poi=pp[0];b.poi=pp[1];game=office.lively();a.poi=pa;b.poi=pb;pp[0].taken=pp[1].taken=null;}
   for(const q of office.plan.pois)if(q.pair)q.taken=q.__t;
   for(const x of saved){x.p.path=x.path;x.p.poi=x.poi;x.p.until=x.until;}office.cat.path=cat;
   return {still,walk,game};
  });
  assert.deepEqual(live,{still:false,walk:true,game:true});
  // A walk spanning several waypoints in one long calm step keeps true speed.
  const stride=await page.evaluate(()=>{
   const p=[...office.people.values()][0];const save={x:p.x,y:p.y,path:p.path,mode:p.mode,poi:p.poi,until:p.until};
   p.x=1;p.y=1;p.path=[{x:1.1,y:1},{x:1.2,y:1},{x:1.6,y:1}];p.mode='work';const hover=office.hoverKey,hold=office.holdKey;
   office.hoverKey=office.holdKey=null;
   try{office.step(0.25);return p.x;}finally{Object.assign(p,save);office.hoverKey=hover;office.holdKey=hold;}
  });
  assert.ok(Math.abs(stride-1.525)<0.01,`walked to ${stride}`);
  check('animation drops to 5fps on a timer while calm, runs 30fps while lively or woken, keeps walking speed, and stops while hidden');
  const batched=await page.evaluate(()=>{
   office.frame(performance.now());
   const meshes=[];office.room.traverse(o=>{if(o.isMesh)meshes.push(o)});
   const inRoom=(o)=>{for(let x=o;x;x=x.parent)if(x===office.room)return true;return false};
   const scr=[...office.screens.values()][0];
   return {calls:office.gl.info.render.calls,meshes:meshes.length,batches:office.batches.length,
    screens:[...office.screens.values()].every(inRoom),ball:inRoom(office.ball),rods:office.rods.every(inRoom),
    leds:office.blinkers.every(b=>inRoom(b.m)),screenOwnMaterial:!!scr&&!meshes.some(m=>m!==scr&&m.material===scr.material),
    window:meshes.some(m=>m.material===office.windowMat)};
  });
  assert.ok(batched.calls<300,`${batched.calls} draw calls`);assert.ok(batched.meshes<200,`${batched.meshes} meshes`);assert.ok(batched.batches>10);
  assert.deepEqual({...batched,calls:0,meshes:0,batches:0},{calls:0,meshes:0,batches:0,screens:true,ball:true,rods:true,leds:true,screenOwnMaterial:true,window:true});
  const rebuilt=await page.evaluate(()=>{
   const seat=office.plan.desks[0].seat;const h0=office.surfaceBelow(seat.x,seat.y,0.75);
   const old=[...office.batches];let disposed=0;for(const g of old)g.addEventListener('dispose',()=>disposed++);
   office.builtPlan=null;office.frame(performance.now());
   return {seatHeight:h0>0.3&&h0<0.75,disposed:disposed===old.length,rebatched:office.batches.length===old.length&&office.batches.every(g=>!old.includes(g))};
  });
  assert.deepEqual(rebuilt,{seatHeight:true,disposed:true,rebatched:true});
  const glide=await page.evaluate(()=>{
   office.activeUntil=0;office.camera.position.x+=0.5;office.frame(performance.now());
   return office.activeUntil>performance.now()+100&&!office.lively.call({walking:()=>false,playing:()=>false});
  });
  assert.equal(glide,true,'a moving 3D camera keeps 30fps; 3D ignores the cat');
  check('3D merges static furniture (<300 draw calls) while screens, LEDs, ball, rods and the sky-tinted window stay live; seats stay measurable and rebuilds free old batches');
  await openSettings(page);await page.selectOption('#langSel','zh-TW');await page.keyboard.press('Escape');
  assert.equal(await page.locator('#focusBtn').getAttribute('aria-label'),'只看辦公室');
  await openSettings(page);await page.selectOption('#langSel','auto');await page.keyboard.press('Escape');
  assert.equal(await page.locator('#focusBtn').getAttribute('aria-label'),'Office only');
  await page.click('#focusBtn');
  const focusState=()=>page.evaluate(()=>{
   const ex=document.getElementById('focusExit').getBoundingClientRect();
   return {focus:document.body.classList.contains('focus'),header:getComputedStyle(document.querySelector('header')).display,
    legend:getComputedStyle(document.getElementById('legend')).display,ver:getComputedStyle(document.getElementById('ver')).display,
    fill:Math.abs(document.getElementById('office').getBoundingClientRect().height-innerHeight)<=2,
    canvas:office.canvas.getBoundingClientRect().bottom<=innerHeight+1,scroll:document.documentElement.scrollHeight<=innerHeight,
    active:document.activeElement.id,label:document.getElementById('focusExit').getAttribute('aria-label'),
    onTop:document.elementFromPoint(ex.x+ex.width/2,ex.y+ex.height/2)?.id};
  });
  const inFocus={focus:true,header:'none',legend:'none',ver:'none',fill:true,canvas:true,scroll:true,active:'focusExit',label:'Show everything',onTop:'focusExit'};
  assert.deepEqual(await focusState(),inFocus);
  await screenshot(page,'office-only');
  await page.reload();await stable(page);
  assert.deepEqual(await focusState(),inFocus);
  await page.setViewportSize({width:320,height:200});await page.waitForTimeout(300);
  const tiny=await focusState();assert.equal(tiny.fill&&tiny.canvas&&tiny.scroll&&tiny.onTop==='focusExit',true,JSON.stringify(tiny));
  await screenshot(page,'office-only-tiny');
  // The 2D office labels switch to screen space when the room is scaled down.
  await page.evaluate(()=>{state.quality='mid';store.set('quality','mid');makeOffice()});
  await page.waitForFunction(()=>officeKind==='mid'&&office.framesShown>4);
  const tiny2d=await page.evaluate(()=>{office.frame(performance.now());return {zoom:office.cam.zoom<1,canvas:office.canvas.getBoundingClientRect().bottom<=innerHeight+1,scroll:document.documentElement.scrollHeight<=innerHeight}});
  assert.deepEqual(tiny2d,{zoom:true,canvas:true,scroll:true});
  await screenshot(page,'office-only-tiny-2d');
  await page.setViewportSize({width:1280,height:960});await page.waitForTimeout(200);
  check('office only fills the window down to 320x200, persists across reload, and its exit button sits above the canvas');
  await page.evaluate(()=>officeOpts.onHover(state.data.sessions[0],{x:200,y:200},true));
  assert.equal(await page.evaluate(()=>tipPinned),true);
  await page.keyboard.press('Escape');
  assert.deepEqual(await page.evaluate(()=>({tip:tipKey,focus:document.body.classList.contains('focus')})),{tip:null,focus:true});
  await page.keyboard.press('Escape');
  assert.deepEqual(await page.evaluate(()=>({focus:document.body.classList.contains('focus'),active:document.activeElement.id,header:getComputedStyle(document.querySelector('header')).display!=='none'})),{focus:false,active:'focusBtn',header:true});
  check('Escape closes a pinned tooltip first, then leaves office only and returns focus to its button');
  await page.click('#focusBtn');
  await page.evaluate(()=>onData({now:Date.now(),sessions:[]}));
  assert.deepEqual(await page.evaluate(()=>({wrap:document.getElementById('officeWrap').style.display,empty:!document.getElementById('officeEmpty').hidden,exit:document.getElementById('focusExit').getBoundingClientRect().width>0})),{wrap:'',empty:true,exit:true});
  await page.click('#focusExit');
  assert.equal(await page.evaluate(()=>document.getElementById('officeWrap').style.display),'none');
  // The toolbar is hidden in office only, so switch views the way a stored preference would.
  await page.click('#focusBtn');await page.evaluate(()=>{state.view='list';syncControls();render()});
  assert.equal(await page.evaluate(()=>document.body.classList.contains('focus')||!document.getElementById('focusBtn').hidden),false);
  await page.evaluate(()=>{state.view='office';state.focus=false;store.set('focus',false);store.set('view','office');syncControls()});
  await page.evaluate(s=>onData({now:Date.now(),sessions:s}),sessions);
  check('office only keeps an empty office and its exit button on screen, and does not apply to the list');
  await openSettings(page);
  await page.locator('#settingsMenu > summary').press('Escape');
  assert.equal(await page.locator('#settingsPanel').isVisible(),false);
  assert.equal(await page.locator('#settingsMenu > summary').evaluate(el=>el===document.activeElement),true);
  await openSettings(page);await page.click('h1');
  assert.equal(await page.locator('#settingsPanel').isVisible(),false);
  for (const width of [320,390,768,1280]) {
   await page.setViewportSize({width,height:800});
   for (const colorScheme of ['light','dark']) {
    await page.emulateMedia({colorScheme});
    await openSettings(page);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    const panel=await page.locator('#settingsPanel').boundingBox();
    assert.ok(panel.x>=0 && panel.x+panel.width<=width);
    await page.locator('#settingsMenu > summary').press('Escape');
    await screenshot(page,`toolbar-${width}-${colorScheme}`);
   }
  }
  check('settings close with Escape/outside click, restore focus, and fit narrow and wide screens in both themes');
  assert.deepEqual(errors,[]);check('no uncaught browser errors');
  console.log('TOTAL',checks.length);
 } finally {
  await browser?.close();
  watcher.stop();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
 }
})().catch(e=>{console.error(e);process.exitCode=1});
