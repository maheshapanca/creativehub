const CFG=window.CREATIVE_HUB_CONFIG||{};
const SUPABASE_URL=CFG.supabaseUrl||'';
const SUPABASE_ANON_KEY=CFG.supabasePublishableKey||'';
const TABLES=CFG.tables||{};
const OWNER_EMAIL=String(CFG.ownerEmail||'').trim();
const CALENDAR_FUNCTION=CFG.calendarFunctionName||'google-calendar';
const APP_DATA_VERSION=Number(CFG.appVersion)||4;
const PAGE_SIZE=1000;
const SYNC_DEBOUNCE_MS=450;
const LOCAL_SYNCED_CACHE_KEY='creative_hub_v4_last_synced';
const LOCAL_PENDING_CACHE_KEY='creative_hub_v4_pending_changes';
const THEME_STORAGE_KEY="creative_hub_theme";

let supabaseClient=null;
let supabaseReady=false;
let initStarted=false;
let saveTimer=null;
let syncInFlight=false;
let cloudLoadComplete=false;
let currentUser=null;
let mutationVersion=0;
let localDirty=false;
let remoteReloadTimer=null;
let realtimeChannel=null;
let pendingLocalRecovery=null;
let legacyStateAvailable=false;
let baseline=createEmptyBaseline();

class ConflictError extends Error{
  constructor(message='Data changed on another device'){super(message);this.name='ConflictError'}
}

function createEmptyBaseline(){
  return {umbrellas:new Map(),projects:new Map(),milestones:new Map(),yearPlans:new Map(),notes:new Map(),settings:new Map()};
}
let appSettings={theme:(()=>{try{return localStorage.getItem(THEME_STORAGE_KEY)||"light"}catch(e){return "light"}})()};
const MONTH_NAMES=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MILESTONE_STATUS=['Progress','Review','Done'];
const DEFAULT_MILESTONE_NAMES=['Concept','Packaging Design','KV','Delegasi'];
const LEGACY_STAGE_MAP={planned:'',progress:'Progress',review:'Review',done:'Done',blocked:'',concept:'',design:'Progress',launch:'Done'};
const LEGACY_MILESTONE_MAP={'Concept/Brief':'Concept','Visual Guideline':'Packaging Design','Delegasi Design':'Delegasi'};
const DAY_LABELS=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
const DEFAULT_UMBRELLAS=[
  {name:'Nutriflakes',color:'#338A57'},
  {name:'Naisly',color:'#2F76BC'}
];
const today=new Date(); today.setHours(0,0,0,0);
let startDate=new Date(today), rangeDays=14, timelineView='timeline', selectedId=null, selectedMonth=new Date(today.getFullYear(),today.getMonth(),1), selectedYear=today.getFullYear(), doneProjectsOpen=false;

function iso(d){const x=new Date(d);x.setMinutes(x.getMinutes()-x.getTimezoneOffset());return x.toISOString().slice(0,10)}
function addDays(d,n){const x=new Date(d);x.setDate(x.getDate()+n);return x}
function dateObj(v){const d=new Date(String(v||'')+'T00:00:00');return isNaN(d)?new Date():d}
function dateText(v,year=false){return new Intl.DateTimeFormat('id-ID',{day:'numeric',month:'short',...(year?{year:'numeric'}:{})}).format(dateObj(v))}
function rangeText(a,b){return dateText(iso(a))+' – '+dateText(iso(b),true)}
function monthText(d){return new Intl.DateTimeFormat('id-ID',{month:'long',year:'numeric'}).format(d)}
function clamp(n,min,max){return Math.max(min,Math.min(max,n))}
function uid(prefix='id'){return prefix+'-'+Math.random().toString(36).slice(2,10)+Date.now().toString(36).slice(-4)}
function esc(v=''){return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function hash(s){let h=0;for(let i=0;i<s.length;i++)h=((h<<5)-h)+s.charCodeAt(i)|0;return Math.abs(h)}
function safeFileName(v){return String(v||'project').replace(/[\\/:*?"<>|]+/g,'-').replace(/\s+/g,'-').replace(/-+/g,'-').slice(0,75)}
function hexToHsl(hex){let s=String(hex||'#64748b').replace('#','');if(s.length===3)s=s.split('').map(x=>x+x).join('');const r=parseInt(s.slice(0,2),16)/255,g=parseInt(s.slice(2,4),16)/255,b=parseInt(s.slice(4,6),16)/255;const max=Math.max(r,g,b),min=Math.min(r,g,b);let h=0,sl=0,l=(max+min)/2;if(max!==min){const d=max-min;sl=l>.5?d/(2-max-min):d/(max+min);switch(max){case r:h=(g-b)/d+(g<b?6:0);break;case g:h=(b-r)/d+2;break;default:h=(r-g)/d+4}h/=6}return {h:Math.round(h*360),s:Math.round(sl*100),l:Math.round(l*100)}}
function autoColor(name){const hue=hash(name)%360;return `hsl(${hue} 52% 45%)`}
function asHexOrHsl(color){return color&&String(color).startsWith('#')?color:color||'#64748b'}
function colorToHsl(color){return String(color||'').startsWith('#')?hexToHsl(color):{h:hash(color)%360,s:50,l:45}}
function normalizeUmbrella(u){return {id:String(u?.id||uid('u')),name:String(u?.name||'Untitled'),color:String(u?.color||autoColor(u?.name||'Other'))}}
function loadUmbrellas(){return DEFAULT_UMBRELLAS.map(normalizeUmbrella)}
let umbrellas=loadUmbrellas();
function normalizeYearPlan(n){return {id:n?.id||uid('yp'),brand:String(n?.brand||'Nutriflakes'),year:Number(n?.year)||today.getFullYear(),month:clamp(Number(n?.month),0,11),title:String(n?.title||''),note:String(n?.note||'')}}
function yearOverviewSeed(){return []}
function loadYearPlans(){return yearOverviewSeed()}
function persistYearPlans(){yearPlans=yearPlans.map(normalizeYearPlan);yearPlans.forEach(n=>ensureUmbrella(n.brand)); if(cloudLoadComplete) scheduleCloudSave()}

let yearPlans=loadYearPlans();
function noteDateFrom(value){const raw=String(value||'');const hit=raw.match(/^\d{4}-\d{2}-\d{2}/);if(hit)return hit[0];const d=new Date(raw);return isNaN(d)?iso(today):iso(d)}
function normalizeNote(n){const content=String(n?.content||'');const found=content.match(/(?:https?:\/\/|www\.)[^\s<]+|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}(?:[/?#][^\s<]*)?/i);const fallback=n?.updatedAt||n?.createdAt||iso(today);return {id:n?.id||uid('note'),brand:String(n?.brand||'Nutriflakes'),title:String(n?.title||''),content,link:String(n?.link||found?.[0]||''),date:noteDateFrom(n?.date||fallback),createdAt:String(n?.createdAt||new Date().toISOString()),updatedAt:String(n?.updatedAt||n?.createdAt||new Date().toISOString())}}
function loadNotes(){return []}
function persistNotes(){notes=notes.map(normalizeNote);notes.forEach(n=>ensureUmbrella(n.brand)); if(cloudLoadComplete) scheduleCloudSave()}
let notes=loadNotes();

function umbrellaFor(name){return umbrellas.find(x=>x.name===name)}
function ensureUmbrella(name){if(!name)return; if(!umbrellaFor(name)){umbrellas.push(normalizeUmbrella({name,color:autoColor(name)}));persistUmbrellas()}}
function persistUmbrellas(){if(cloudLoadComplete) scheduleCloudSave()}
function colorFor(p){const entry=umbrellaFor(p.brand)||{color:autoColor(p.brand||'Other')};const c=colorToHsl(entry.color);const lights=[34,40,46,52,37];return `hsl(${c.h} ${Math.max(42,c.s)}% ${lights[hash(p.id||p.name)%lights.length]}%)`}
function baseColor(brand){return asHexOrHsl((umbrellaFor(brand)||{color:autoColor(brand||'Other')}).color)}
function isDone(p){const list=p?.milestones||[];return list.length>0&&list.every(m=>m.status==='Done')}
function defaultLinks(){return {Brief:'', 'Master Drive':'','Working File':'','Final Output':''}}
function normalizedLink(value=''){
  const raw=String(value||'').trim();
  if(!raw) return '';
  if(/^https?:\/\//i.test(raw)) return raw;
  // Domain-only links are allowed: drive.google.com, figma.com, rubahbahasa.id, etc.
  if(/^(?:www\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)+(?:[/?#][^\s]*)?$/i.test(raw)) return 'https://'+raw;
  return '';
}
function isClickableLink(value){return !!normalizedLink(value)}
function linkifyText(value=''){
  const escaped=esc(value||'');
  const pattern=/((?:https?:\/\/|www\.)[^\s<]+|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}(?:[/?#][^\s<]*)?)/gi;
  return escaped.replace(pattern,(match)=>{
    const clean=match.replace(/[),.;!?]+$/,'');
    const suffix=match.slice(clean.length);
    const href=normalizedLink(clean);
    return href?`<a href="${esc(href)}" target="_blank" rel="noopener">${clean}</a>${suffix}`:match;
  });
}
function firstLiveLink(p){return Object.values(p?.links||{}).find(v=>isClickableLink(v))||''}
function milestoneLinkForTable(p){
  const ordered=orderMilestones(p);
  const current=currentMilestone(p);
  if(current && isClickableLink(current.drive)) return {url:normalizedLink(current.drive), milestone:current, label:'Current'};
  if(isDone(p)){
    const latestWithLink=[...ordered].reverse().find(m=>isClickableLink(m.drive));
    if(latestWithLink) return {url:normalizedLink(latestWithLink.drive), milestone:latestWithLink, label:'Last'};
  }
  return null;
}
function normalizeMilestone(m,fallbackSequence=0){
  const raw=String(m?.status||'').trim();
  const lower=raw.toLowerCase();
  const status=MILESTONE_STATUS.includes(raw)?raw:(LEGACY_STAGE_MAP[lower]??'');
  const name=LEGACY_MILESTONE_MAP[String(m?.name||'')]||String(m?.name||'Milestone');
  const rawSequence=Number(m?.sequence);
  return {id:m?.id||uid('m'),name,start:m?.start||iso(today),end:m?.end||m?.start||iso(today),status,note:String(m?.note||''),pic:String(m?.pic||''),picNote:String(m?.picNote||''),drive:String(m?.drive||''),sequence:Number.isFinite(rawSequence)?rawSequence:fallbackSequence}
}
function standardMilestoneRanges(deadline){
  const d=dateObj(deadline||iso(today));
  return [
    {name:'Concept',start:addDays(d,-56),end:addDays(d,-43)},
    {name:'Packaging Design',start:addDays(d,-42),end:addDays(d,-29)},
    {name:'KV',start:addDays(d,-28),end:addDays(d,-15)},
    {name:'Delegasi',start:addDays(d,-14),end:addDays(d,-1)}
  ]
}
function makeProjectMilestones(deadline){
  return standardMilestoneRanges(deadline).map((r,i)=>({id:uid('m'),name:r.name,start:iso(r.start),end:iso(r.end),status:i===0?'Progress':'',note:'',pic:'',picNote:'',drive:'',sequence:i}))
}
function orderMilestones(p){return [...(p?.milestones||[])].sort((a,b)=>{
  const sa=Number.isFinite(Number(a.sequence))?Number(a.sequence):9999;
  const sb=Number.isFinite(Number(b.sequence))?Number(b.sequence):9999;
  return sa-sb||a.start.localeCompare(b.start)||a.end.localeCompare(b.end)||a.name.localeCompare(b.name)
})}
function ensureMilestoneFlow(p){
  const ordered=orderMilestones(p);
  const current=ordered.find(m=>m.status!=='Done');
  if(current&&!MILESTONE_STATUS.includes(current.status))current.status='Progress';
  return p
}
function currentMilestone(p){return orderMilestones(p).find(m=>m.status!=='Done')||null}
function milestoneSummary(p){
  const ordered=orderMilestones(p),total=ordered.length,done=ordered.filter(m=>m.status==='Done').length;
  return {total,done,percent:total?Math.round((done/total)*100):0,current:currentMilestone(p)}
}
function deriveProjectFromMilestones(p){
  p.milestones=orderMilestones(p).map((m,i)=>({...normalizeMilestone(m,i),sequence:i}));
  ensureMilestoneFlow(p);
  const summary=milestoneSummary(p);
  p.deadline=summary.total?p.milestones[p.milestones.length-1].end:p.deadline||iso(today);
  p.progress=summary.percent;
  p.currentMilestoneId=summary.current?.id||'';
  p.currentMilestoneName=summary.current?.name||(summary.total?'Done':'No milestone');
  delete p.status;
  return p
}
function normalizeProject(p){
  p.links=p.links&&typeof p.links==='object'?{...defaultLinks(),...(p.links||{})}:defaultLinks();
  p.milestones=Array.isArray(p.milestones)?p.milestones.map((m,i)=>normalizeMilestone(m,i)):[];
  p.brand=p.brand||'Nutriflakes';p.type=p.type||'General Project';
  return deriveProjectFromMilestones(p)
}
function stagedProject(brand,type,name,deadline,doneCount=0,currentStatus='Progress'){
  const milestones=makeProjectMilestones(deadline);
  milestones.forEach((m,i)=>{if(i<doneCount)m.status='Done'; else if(i===doneCount)m.status=currentStatus; else m.status=''})
  return deriveProjectFromMilestones({id:uid('seed'),brand,type,name,deadline,pic:'',note:'',links:defaultLinks(),milestones})
}
function seed(){return []}
function load(){return seed().map(normalizeProject)}
let projects=load();selectedId=projects[0]?.id||null;
function save(){projects=projects.map(normalizeProject);persistYearPlans();persistNotes();persistUmbrellas();scheduleCloudSave()}
function findProject(id){return projects.find(p=>p.id===id)}
function findMilestone(p,id){return p?.milestones.find(m=>m.id===id)}
function showToast(msg){const e=document.getElementById('toast');e.textContent=msg;e.classList.add('show');clearTimeout(window.__toast);window.__toast=setTimeout(()=>e.classList.remove('show'),2200)}
function sortProjects(arr){return [...arr].sort((a,b)=>{const activeA=isDone(a)?1:0,activeB=isDone(b)?1:0;if(activeA!==activeB)return activeA-activeB;return a.deadline.localeCompare(b.deadline)||a.name.localeCompare(b.name)})}
function orderedBrandNames(projectList=projects){const discovered=[...new Set(projectList.map(p=>p.brand))];return [...umbrellas.map(x=>x.name).filter(x=>discovered.includes(x)),...discovered.filter(x=>!umbrellas.some(u=>u.name===x)).sort()]}
function laneMilestones(ms){const sorted=[...ms].sort((a,b)=>a.start.localeCompare(b.start)||a.end.localeCompare(b.end));const laneEnds=[];const laneById={};for(const m of sorted){let lane=0;while(lane<laneEnds.length&&laneEnds[lane]>=m.start)lane++;if(lane===laneEnds.length)laneEnds.push(m.end);else laneEnds[lane]=m.end;laneById[m.id]=lane}return {laneById,count:Math.max(1,laneEnds.length)}}
function syncBrandControls(){const filter=document.getElementById('brandFilter');if(!filter)return;const existing=filter.value||'all';filter.innerHTML='<option value="all">All umbrella brands</option>'+umbrellas.map(u=>`<option value="${esc(u.name)}">${esc(u.name)}</option>`).join('');filter.value=umbrellas.some(u=>u.name===existing)?existing:'all'}
function populateBrandSelect(selected){const select=document.getElementById('projectBrand');select.innerHTML=umbrellas.map(u=>`<option value="${esc(u.name)}" ${u.name===selected?'selected':''}>${esc(u.name)}</option>`).join('');if(selected&&!umbrellas.some(u=>u.name===selected)){ensureUmbrella(selected);populateBrandSelect(selected)}}
function filteredProjects(){const f=document.getElementById('brandFilter')?.value||'all';return projects.filter(p=>f==='all'||p.brand===f)}
function milestoneDueItems(){return projects.flatMap(p=>p.milestones.map(m=>({p,m,due:m.end||m.start}))).filter(x=>x.due)}
function deadlineInfo(m){
  if(!m)return {kind:'',label:''};
  if(m.status==='Done')return {kind:'',label:''};
  const diff=Math.round((dateObj(m.end||m.start)-today)/86400000);
  if(diff<0)return {kind:'overdue',label:`Overdue ${Math.abs(diff)}d`};
  if(diff===0)return {kind:'soon',label:'Due today'};
  if(diff<=3)return {kind:'soon',label:`H-${diff}`};
  return {kind:'',label:''};
}
function deadlineBadge(m){const d=deadlineInfo(m);return d.label?`<span class="deadline-badge ${d.kind}">${esc(d.label)}</span>`:''}
function loadLastBackup(){return ''}
function backupDay(value){return String(value||'').slice(0,10)}
let lastBackup=loadLastBackup();
function backupStatusHtml(){
  if(!lastBackup)return `<div><b>Belum ada backup</b><div>Export Backup untuk menyimpan salinan data dashboard.</div></div><button class="btn mini" id="backupNowBtn">Backup now</button>`;
  const day=backupDay(lastBackup),days=Math.max(0,Math.floor((today-dateObj(day))/86400000));
  const warning=days>=7;
  const label=days===0?'hari ini':`${days} hari lalu`;
  return `<div><b>Last backup: ${dateText(day,true)}</b><div>${warning?'Sudah lebih dari 7 hari sejak backup terakhir.':`Backup terakhir ${label}.`}</div></div><button class="btn mini" id="backupNowBtn">Backup now</button>`;
}
function openProjectFromHome(id){selectedId=id;switchMainView('detailView')}
function renderHome(){
  const active=projects.filter(p=>!isDone(p));const done=projects.filter(isDone);const queue=milestoneDueItems().filter(x=>x.m.status==='Review').sort((a,b)=>a.due.localeCompare(b.due));
  const upcoming=milestoneDueItems().filter(x=>x.due>=iso(today)&&!isDone(x.p)).sort((a,b)=>a.due.localeCompare(b.due)).slice(0,6);
  const thisMonth=milestoneDueItems().filter(x=>{const d=dateObj(x.due);return d.getFullYear()===today.getFullYear()&&d.getMonth()===today.getMonth()&&!isDone(x.p)});
  document.getElementById('homeStats').innerHTML=[['Active Projects',active.length],['Need Review',queue.length],['This Month',thisMonth.length],['Archived',done.length]].map(([l,n])=>`<div class="home-stat"><span>${l}</span><b>${n}</b></div>`).join('');
  const q=document.getElementById('reviewQueue');q.innerHTML=queue.length?queue.slice(0,6).map(x=>`<button class="review-row" data-home-project="${x.p.id}"><span><b>${esc(x.p.name)}</b><small>${esc(x.m.name)}${x.m.pic?` · PIC: ${esc(x.m.pic)}`:''} · ${dateText(x.due,true)}</small></span><em class="queue-badge">Review</em></button>`).join(''):'<div class="home-empty">Belum ada item yang menunggu review.</div>';
  const u=document.getElementById('upcomingDeadlines');u.innerHTML=upcoming.length?upcoming.map(x=>`<button class="deadline-row" data-home-project="${x.p.id}"><span><b>${esc(x.p.name)}</b><small>${esc(x.m.name)}${x.m.pic?` · ${esc(x.m.pic)}`:''} · ${dateText(x.due,true)}</small>${deadlineBadge(x.m)}</span><span class="note-brand-chip"><i class="note-brand-dot" style="background:${baseColor(x.p.brand)}"></i>${esc(x.p.brand)}</span></button>`).join(''):'<div class="home-empty">Tidak ada deadline aktif dalam waktu dekat.</div>';
  const heat=document.getElementById('deadlineHeatmap');let cells='';for(let i=0;i<14;i++){const d=addDays(today,i),key=iso(d),count=milestoneDueItems().filter(x=>x.due===key&&!isDone(x.p)).length,klass=count>=4?'heat-4':count===3?'heat-3':count===2?'heat-2':count===1?'heat-1':'';cells+=`<div class="heat-day ${klass}"><span class="h-num">${dateText(key)}</span><span class="h-count">${count?count+' deadline'+(count>1?'s':''):'Clear'}</span></div>`}heat.innerHTML=cells;
  document.getElementById('archiveSnapshot').innerHTML=`<div><b>${done.length}</b><div class="muted" style="font-size:11px">completed project${done.length!==1?'s':''} tersimpan di Done</div></div><button class="btn mini" id="openArchiveBtn">View Done Projects</button>`;
  const backup=document.getElementById('backupStatus');if(backup){const age=lastBackup?Math.max(0,Math.floor((today-dateObj(backupDay(lastBackup)))/86400000)):999;backup.classList.toggle('warning',age>=7);backup.innerHTML=backupStatusHtml()}
  document.querySelectorAll('[data-home-project]').forEach(el=>el.addEventListener('click',()=>openProjectFromHome(el.dataset.homeProject)));
  document.getElementById('openArchiveBtn')?.addEventListener('click',()=>{doneProjectsOpen=true;switchMainView('projectsView')});
  document.getElementById('backupNowBtn')?.addEventListener('click',exportData)
}
function switchMainView(id){document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('active',x.dataset.view===id));document.querySelectorAll('.view').forEach(x=>x.classList.toggle('active',x.id===id));if(id==='homeView')renderHome();if(id==='timelineView')renderTimelineSection();if(id==='projectsView')renderProjects();if(id==='detailView')renderDetail();if(id==='notesView')renderNotes();window.scrollTo({top:0,behavior:'smooth'})}
function setTimelineView(view){timelineView=view;document.querySelectorAll('[data-timeline-view]').forEach(b=>b.classList.toggle('active',b.dataset.timelineView===view));document.getElementById('timelineMode').classList.toggle('hidden',view!=='timeline');document.getElementById('calendarMode').classList.toggle('hidden',view!=='calendar');document.getElementById('yearMode').classList.toggle('hidden',view!=='year');document.getElementById('rangeButtons').classList.toggle('hidden',view!=='timeline');const tips={timeline:'<b>Timeline view:</b> klik ruang kosong di baris project untuk tambah milestone. Milestone baru otomatis masuk ke Project Detail dan memperbarui current milestone serta progress di All Projects. Klik milestone untuk edit tanggal, status, catatan, PIC note, atau link Drive.',calendar:'<b>Full calendar:</b> satu project tampil satu kali per bulan agar tidak penuh. Di dalam kartu terlihat milestone yang terkait. Klik kartu untuk membuka Project Detail.',year:'<b>Year overview:</b> planning canvas terpisah dari project milestone. Setiap umbrella punya baris sendiri; klik bulan untuk menyimpan catatan, fokus, atau timeline besar brand tersebut.'};document.getElementById('timelineTip').innerHTML=tips[view];renderTimelineSection()}
function renderTimelineSection(){syncBrandControls();if(timelineView==='timeline')renderTimeline();else if(timelineView==='calendar')renderCalendar();else renderYearTimeline()}
function yearClass(monthIndex){return 'q'+(Math.floor(monthIndex/3)+1)}
function renderYearTimeline(){
  const holder=document.getElementById('yearTimeline'),year=selectedYear,monthNames=MONTH_NAMES;
  document.getElementById('rangeTitle').textContent=String(year);
  const selectedBrand=document.getElementById('brandFilter').value;
  const visibleUmbrellas=umbrellas.filter(u=>selectedBrand==='all'||u.name===selectedBrand);
  let html=`<div class="year-quarter-head"><div class="year-corner">Umbrella / annual notes</div>${[0,1,2,3].map(q=>`<div class="quarter-head q${q+1}">Q${q+1}<small>${monthNames[q*3]}–${monthNames[q*3+2]}</small></div>`).join('')}</div><div class="year-month-head"><div class="year-corner">${year}</div>${monthNames.map((m,i)=>`<div class="year-month ${yearClass(i)} ${today.getFullYear()===year&&today.getMonth()===i?'current-month':''}">${m}</div>`).join('')}</div>`;
  if(!visibleUmbrellas.length) html+='<div class="empty-line">Tidak ada umbrella brand pada filter ini.</div>';
  for(const umbrella of visibleUmbrellas){
    const notes=yearPlans.filter(n=>n.year===year&&n.brand===umbrella.name);
    html+=`<div class="year-brand-row"><i style="background:${baseColor(umbrella.name)}"></i>${esc(umbrella.name)} <span class="year-note-count">· ${notes.length} annual note${notes.length!==1?'s':''}</span></div>`;
    html+=`<div class="year-umbrella-row"><button class="year-umbrella-label" data-open-umbrella-projects="1" data-umbrella-name="${esc(umbrella.name)}"><i class="project-swatch" style="background:${baseColor(umbrella.name)}"></i><span><b>${esc(umbrella.name)}</b><small>Click a month to add a planning note.</small></span></button>`;
    for(let month=0;month<12;month++){
      const entries=notes.filter(n=>n.month===month);
      html+=`<div class="year-month-cell ${yearClass(month)}" data-new-year-plan="1" data-year-plan-brand="${esc(umbrella.name)}" data-year-plan-year="${year}" data-year-plan-month="${month}"><div class="year-plan-stack">${entries.map(n=>`<button class="year-plan-card" style="--plan-color:${baseColor(umbrella.name)}" data-edit-year-plan="${n.id}"><b>${esc(n.title)}</b>${n.note?`<span>${esc(n.note)}</span>`:''}</button>`).join('')}${!entries.length?'<div class="year-plan-empty">Click to add note</div>':''}</div><button class="year-plus" title="Add planning note">+</button></div>`;
    }
    html+='</div>';
  }
  holder.innerHTML=html;
  bindTimelineInteractions();
}
function bindTimelineInteractions(){
  document.querySelectorAll('[data-open-project]').forEach(el=>el.addEventListener('click',()=>{selectedId=el.dataset.openProject;switchMainView('detailView')}));
  document.querySelectorAll('[data-new-milestone-project]').forEach(el=>el.addEventListener('click',e=>{if(e.target.closest('.plus,.year-plus')||e.currentTarget===e.target)openMilestoneModal(null,el.dataset.newMilestoneProject,el.dataset.newMilestoneDate)}));
  document.querySelectorAll('[data-open-milestone]').forEach(el=>el.addEventListener('click',e=>{e.stopPropagation();const [p,m]=el.dataset.openMilestone.split('|');openMilestoneModal(m,p)}));
  document.querySelectorAll('[data-new-year-plan]').forEach(el=>el.addEventListener('click',e=>{if(e.target.closest('[data-edit-year-plan]'))return;openYearPlanModal(null,el.dataset.yearPlanBrand,Number(el.dataset.yearPlanYear),Number(el.dataset.yearPlanMonth))}));
  document.querySelectorAll('[data-edit-year-plan]').forEach(el=>el.addEventListener('click',e=>{e.stopPropagation();openYearPlanModal(el.dataset.editYearPlan)}));
  document.querySelectorAll('[data-open-umbrella-projects]').forEach(el=>el.addEventListener('click',()=>{const brand=el.dataset.umbrellaName;document.getElementById('brandFilter').value=brand;setTimelineView('timeline');showToast('Showing '+brand+' projects')}));
}
function renderTimeline(){
  const holder=document.getElementById('timeline'),ps=filteredProjects(),days=Array.from({length:rangeDays},(_,i)=>addDays(startDate,i));
  document.getElementById('rangeTitle').textContent=rangeText(startDate,days[days.length-1]);holder.style.setProperty('--days',rangeDays);
  let html=`<div class="timeline-head"><div class="corner">Project / Milestones</div>${days.map(d=>`<div class="dayhead ${iso(d)===iso(today)?'today':''}"><span class="dow">${DAY_LABELS[(d.getDay()+6)%7]}</span><span class="num">${d.getDate()}</span></div>`).join('')}</div>`;
  const byBrand={};ps.forEach(p=>(byBrand[p.brand]??=[]).push(p));
  if(!ps.length)html+='<div class="empty-line">Tidak ada project pada filter ini.</div>';
  for(const brand of orderedBrandNames(ps)){
    const arr=sortProjects(byBrand[brand]||[]);if(!arr.length)continue;
    html+=`<div class="brand-row"><i style="background:${baseColor(brand)}"></i>${esc(brand)}</div>`;
    for(const p of arr){
      const visible=p.milestones.filter(m=>m.end>=iso(days[0])&&m.start<=iso(days[days.length-1]));
      const lanes=laneMilestones(visible);const rowh=Math.max(104,28+(lanes.count*72));
      html+=`<div class="project-row" style="--days:${rangeDays};--rowh:${rowh}px"><button class="project-label" data-open-project="${p.id}"><span class="project-name"><i class="project-swatch" style="background:${colorFor(p)}"></i>${esc(p.name)}</span><span class="project-meta"><span class="type-tag">${esc(p.type)}</span><span class="stage-tag">${esc(currentMilestone(p)?.name||'Done')} · ${milestoneSummary(p).done}/${milestoneSummary(p).total} done</span></span></button>${days.map(d=>`<div class="daycell ${[0,6].includes(d.getDay())?'weekend':''}" data-new-milestone-project="${p.id}" data-new-milestone-date="${iso(d)}"><button class="plus" title="Add milestone">+</button></div>`).join('')}<div class="row-overlay">${visible.map(m=>{
        const lane=lanes.laneById[m.id]||0;const start=Math.max(0,Math.round((dateObj(m.start)-days[0])/86400000));const end=Math.min(rangeDays-1,Math.round((dateObj(m.end)-days[0])/86400000));const width=end-start+1;const due=deadlineInfo(m);
        const info=[m.note,m.pic?`PIC: ${m.pic}`:'',m.picNote?`PIC note: ${m.picNote}`:'',due.kind==='overdue'||due.kind==='soon'?due.label:''].filter(Boolean);
        return `<button class="milestone-bar ${due.kind==='overdue'?'overdue':due.kind==='soon'?'soon':''}" data-open-milestone="${p.id}|${m.id}" style="left:calc(${start} * var(--dayw) + 3px);top:${11+lane*72}px;width:calc(${width} * var(--dayw) - 6px);background:${colorFor(p)}">${esc(m.name)}${m.status?` <span class="m-status">${esc(m.status)}</span>`:''}</button>${info.map((item,i)=>`<span class="milestone-info ${i===1?'pic':''} ${item===due.label?'warning':''}" style="left:calc(${start} * var(--dayw) + 5px);top:${39+lane*72+i*12}px;width:calc(${width} * var(--dayw) - 10px);color:${item===due.label?(due.kind==='overdue'?'#b22947':'#9a6808'):baseColor(p.brand)}">${esc(item)}</span>`).join('')}`
      }).join('')}</div></div>`
    }
  }
  holder.innerHTML=html;bindTimelineInteractions()
}
function renderCalendar(){
  const holder=document.getElementById('calendar');document.getElementById('rangeTitle').textContent=monthText(selectedMonth);
  const first=new Date(selectedMonth.getFullYear(),selectedMonth.getMonth(),1), firstOffset=(first.getDay()+6)%7, gridStart=addDays(first,-firstOffset), last=new Date(selectedMonth.getFullYear(),selectedMonth.getMonth()+1,0), lastOffset=6-((last.getDay()+6)%7), gridEnd=addDays(last,lastOffset), days=[];
  for(let d=new Date(gridStart);d<=gridEnd;d=addDays(d,1))days.push(new Date(d));
  const monthStart=iso(first),monthEnd=iso(last),byDate={};
  filteredProjects().forEach(p=>{
    const overlaps=p.milestones.filter(m=>m.end>=monthStart&&m.start<=monthEnd);
    if(!overlaps.length)return;
    const startsInside=overlaps.filter(m=>m.start>=monthStart&&m.start<=monthEnd).sort((a,b)=>a.start.localeCompare(b.start));
    const deadlineInside=p.deadline>=monthStart&&p.deadline<=monthEnd;
    const anchor=deadlineInside?p.deadline:(startsInside[0]?.start||monthStart);
    (byDate[anchor]??=[]).push({p,milestones:p.milestones.map(m=>m.name)});
  });
  Object.values(byDate).forEach(arr=>arr.sort((a,b)=>a.p.deadline.localeCompare(b.p.deadline)));
  let html=`<div class="calendar-weekdays">${DAY_LABELS.map(x=>`<div>${x}</div>`).join('')}</div><div class="calendar-grid">`;
  for(const d of days){
    const key=iso(d),inMonth=d.getMonth()===selectedMonth.getMonth(),items=byDate[key]||[];
    html+=`<div class="cal-day ${!inMonth?'outside':''} ${[0,6].includes(d.getDay())?'weekend':''} ${key===iso(today)?'today':''}" data-calendar-date="${key}"><div class="cal-top"><span class="cal-num">${d.getDate()}</span><button class="cal-add" title="Add project" data-new-project-date="${key}">+</button></div>${items.map(({p,milestones})=>`<button class="cal-project-chip" data-open-project="${p.id}" style="background:${isDone(p)?'#a9afb8':colorFor(p)}"><span class="cal-project-title">${esc(p.name)}</span><span class="cal-project-meta">${esc(currentMilestone(p)?.name||'Done')} · ${milestoneSummary(p).done}/${milestoneSummary(p).total} done</span><span class="cal-project-milestones">${esc(milestones.join(' · '))}</span></button>`).join('')}</div>`;
  }
  holder.innerHTML=html+'</div>';
  document.querySelectorAll('[data-new-project-date]').forEach(el=>el.addEventListener('click',e=>{e.stopPropagation();openProjectModal(null,el.dataset.newProjectDate)}));
  document.querySelectorAll('.cal-day').forEach(el=>el.addEventListener('dblclick',()=>openProjectModal(null,el.dataset.calendarDate)));
  document.querySelectorAll('[data-open-project]').forEach(el=>el.addEventListener('click',()=>{selectedId=el.dataset.openProject;switchMainView('detailView')}));
}
function projectTableRow(p){
  const summary=milestoneSummary(p),current=summary.current;
  const milestoneLink=milestoneLinkForTable(p);
  const currentHtml=current?`<div><b>${esc(current.name)}</b><div class="muted">Due ${dateText(current.end)}${current.pic?` · PIC: ${esc(current.pic)}`:''}</div>${deadlineBadge(current)}</div>`:`<span class="muted">Done</span>`;
  const quickHtml=current?`<select class="quick-status ${String(current.status||'Progress').toLowerCase()}" data-quick-milestone="${p.id}|${current.id}" aria-label="Update status ${esc(current.name)}"><option value="Progress" ${current.status==='Progress'?'selected':''}>Progress</option><option value="Review" ${current.status==='Review'?'selected':''}>Review</option><option value="Done" ${current.status==='Done'?'selected':''}>Done</option></select>`:`<span class="muted">All milestones done</span>`;
  const linkHtml=milestoneLink
    ? `<a class="link" href="${esc(milestoneLink.url)}" target="_blank" rel="noopener">${esc(milestoneLink.milestone.name)} ↗</a><div class="muted" style="margin-top:3px">${milestoneLink.label} milestone</div>`
    : `<span class="muted">No ${current?'current milestone':''} link</span>`;
  return `<tr class="${isDone(p)?'done-row':''}"><td><div class="name-cell"><i class="table-color" style="background:${isDone(p)?'#a9afb8':colorFor(p)}"></i><div>${esc(p.name)}<div class="muted">${summary.done}/${summary.total} milestone done · ${esc(p.pic||'No PIC')}</div></div></div></td><td>${esc(p.brand)}</td><td>${esc(p.type)}</td><td>${currentHtml}</td><td>${quickHtml}</td><td><div class="muted"><b style="color:var(--ink)">${summary.done} / ${summary.total}</b> done</div></td><td>${dateText(p.deadline,true)}</td><td>${linkHtml}</td><td><button class="btn mini" data-edit-project="${p.id}">Edit</button></td></tr>`
}
function updateMilestoneFromAllProjects(projectId,milestoneId,status){
  const p=findProject(projectId),m=findMilestone(p,milestoneId);
  if(!p||!m||!MILESTONE_STATUS.includes(status))return;
  m.status=status;
  deriveProjectFromMilestones(p);
  refreshProjectViews();
  const next=currentMilestone(p);
  if(status==='Done'&&next)showToast(`${m.name} selesai · lanjut ke ${next.name}`);
  else if(status==='Done')showToast(`${p.name} selesai dan dipindahkan ke Done`);
  else showToast(`${m.name} diperbarui ke ${status}`);
}
function bindProjectTableActions(){
  document.querySelectorAll('[data-edit-project]').forEach(el=>el.addEventListener('click',()=>openProjectModal(el.dataset.editProject)));
  document.querySelectorAll('[data-quick-milestone]').forEach(el=>el.addEventListener('change',()=>{const [pid,mid]=el.dataset.quickMilestone.split('|');updateMilestoneFromAllProjects(pid,mid,el.value)}));
  document.querySelector('[data-toggle-done]')?.addEventListener('click',()=>{doneProjectsOpen=!doneProjectsOpen;renderProjects()})
}
function renderProjects(){const body=document.getElementById('projectsBody'),q=(document.getElementById('projectSearch').value||'').toLowerCase(),filtered=projects.filter(p=>[p.name,p.brand,p.type,p.pic,currentMilestone(p)?.name||'Done'].join(' ').toLowerCase().includes(q)),active=filtered.filter(p=>!isDone(p)),done=sortProjects(filtered.filter(isDone)),byBrand={};active.forEach(p=>(byBrand[p.brand]??=[]).push(p));let html='';for(const brand of orderedBrandNames(active)){const rows=sortProjects(byBrand[brand]||[]);if(!rows.length)continue;html+=`<tr class="umbrella-group"><td colspan="9"><span style="background:${baseColor(brand)}"></span>${esc(brand)}<small>${rows.length} active project${rows.length>1?'s':''} · sorted by closest deadline</small></td></tr>`;html+=rows.map(projectTableRow).join('')}if(done.length){html+=`<tr class="done-folder"><td colspan="9"><button data-toggle-done>${doneProjectsOpen?'⌄':'›'} Done <span class="done-count">${done.length} completed project${done.length!==1?'s':''}</span></button></td></tr>`;if(doneProjectsOpen)html+=done.map(projectTableRow).join('')}body.innerHTML=html||'<tr><td colspan="9" class="empty">Tidak ada project yang cocok.</td></tr>';bindProjectTableActions()}
function refreshProjectViews(){save();renderTimelineSection();renderProjects();renderHome();if(document.getElementById('detailView').classList.contains('active'))renderDetail()}
function renderDetail(){
  const p=findProject(selectedId)||sortProjects(projects)[0];
  if(!p){document.getElementById('pickerList').innerHTML='';document.getElementById('detailContent').innerHTML='<div class="panel empty">Belum ada project.</div>';return}
  selectedId=p.id;
  const q=(document.getElementById('pickerSearch').value||'').toLowerCase(),matches=projects.filter(x=>[x.name,x.brand,x.type,currentMilestone(x)?.name||'Done'].join(' ').toLowerCase().includes(q)),active=matches.filter(x=>!isDone(x)),done=sortProjects(matches.filter(isDone)),grouped={};active.forEach(x=>(grouped[x.brand]??=[]).push(x));
  const pickerItem=x=>{const s=milestoneSummary(x),c=s.current;return `<button class="picker-item ${isDone(x)?'done-item':''} ${x.id===p.id?'active':''}" data-pick-project="${x.id}"><i class="picker-color" style="background:${isDone(x)?'#a9afb8':colorFor(x)}"></i><span><b>${esc(x.name)}</b><small>${esc(x.type)} · ${esc(c?.name||'Done')} · ${s.done}/${s.total} done</small></span></button>`};
  let picker='';for(const brand of orderedBrandNames(active)){const arr=sortProjects(grouped[brand]||[]);if(arr.length)picker+=`<div class="picker-brand"><i class="umbrella-dot" style="background:${baseColor(brand)}"></i>${esc(brand)}</div>${arr.map(pickerItem).join('')}`}if(done.length)picker+=`<details class="picker-done" ${isDone(p)?'open':''}><summary>Done · ${done.length} project${done.length!==1?'s':''}</summary>${done.map(pickerItem).join('')}</details>`;
  document.getElementById('pickerList').innerHTML=picker||'<div class="empty" style="padding:18px">Tidak ada project yang cocok.</div>';
  document.querySelectorAll('[data-pick-project]').forEach(el=>el.addEventListener('click',()=>{selectedId=el.dataset.pickProject;renderDetail()}));
  const ordered=orderMilestones(p),summary=milestoneSummary(p),current=summary.current;
  const mileHtml=ordered.length?ordered.map((m,index)=>`<div class="journey-item milestone-item"><span><b><i class="mile-dot" style="background:${isDone(p)?'#a8afb7':colorFor(p)}"></i>${esc(m.name)}${m.status?` <small style="color:#7b8796;font-weight:800">${esc(m.status)}</small>`:''}</b>${deadlineBadge(m)}${m.pic?`<p class="pic-note"><span>PIC</span>${esc(m.pic)}</p>`:''}${m.note?`<p>${esc(m.note)}</p>`:`<p class="muted">No milestone note yet.</p>`}${m.picNote?`<p class="pic-note"><span>PIC note</span>${esc(m.picNote)}</p>`:''}${isClickableLink(m.drive)?`<a class="milestone-drive-link" href="${esc(normalizedLink(m.drive))}" target="_blank" rel="noopener">Open milestone link ↗</a>`:`<p class="milestone-no-link">No milestone link yet.</p>`}</span><span style="display:flex;align-items:center;gap:8px"><time>${dateText(m.start)} – ${dateText(m.end,true)}</time><span class="milestone-order-actions"><button class="milestone-order-btn" data-move-milestone="${p.id}|${m.id}|up" ${index===0?'disabled':''} title="Move up">↑</button><button class="milestone-order-btn" data-move-milestone="${p.id}|${m.id}|down" ${index===ordered.length-1?'disabled':''} title="Move down">↓</button></span><button class="milestone-edit-btn" data-open-milestone="${p.id}|${m.id}">Edit</button></span></div>`).join(''):'<div class="empty" style="padding:22px">Belum ada milestone.</div>';
  const linkEntries=Object.entries(p.links||{});
  document.getElementById('detailContent').innerHTML=`<section class="panel detail-card ${isDone(p)?'done-project':''}"><div class="project-header"><div><div class="subline">${esc(p.brand)} · ${esc(p.type)}${isDone(p)?' · Done':''}</div><h2>${esc(p.name)}</h2><div class="subline">Current milestone: <b>${esc(current?.name||'Done')}</b>${current?.status?` · ${esc(current.status)}`:''}${current?.pic?` · PIC ${esc(current.pic)}`:''} · ${summary.done}/${summary.total} done · Deadline ${dateText(p.deadline,true)}${p.pic?' · PIC '+esc(p.pic):''}</div><div class="print-only report-note">Creative Hub Dashboard · @artdirector</div></div><div class="detail-actions"><button class="btn mini" data-export-project-pdf="${p.id}">Export PDF</button><button class="btn mini" data-edit-project="${p.id}">Edit project</button><button class="btn primary" data-add-milestone-project="${p.id}">+ Milestone</button></div></div><div class="quick-grid"><div class="quick"><span>Current milestone</span><b>${esc(current?.name||'Done')}</b>${current?.pic?`<small class="muted">PIC: ${esc(current.pic)}</small>`:''}${current?deadlineBadge(current):''}</div><div class="quick"><span>Progress</span><b>${summary.done} / ${summary.total} done</b></div><div class="quick"><span>Milestones</span><b>${summary.total}</b></div><div class="quick"><span>Deadline</span><b>${dateText(p.deadline)}</b></div></div><div class="dependency-flow">${ordered.map((m,i)=>{const cls=m.status==='Done'?'done':m.id===current?.id?'current':'locked';return `<span class="dep-step ${cls}">${esc(m.name)}</span>${i<ordered.length-1?'<span class="dep-arrow">→</span>':''}`}).join('')}</div><p class="dep-caption">Current milestone mengikuti urutan ini. Gunakan tombol ↑ / ↓ pada setiap milestone untuk mengubah urutan kerja.</p></section><section class="panel detail-card ${isDone(p)?'done-project':''}"><div class="subheading"><h3>Project note</h3><button class="btn mini" data-save-project-note="${p.id}">Save note</button></div><textarea class="note-area" id="projectOverviewNote">${esc(p.note||'')}</textarea></section><section class="panel detail-card ${isDone(p)?'done-project':''}"><div class="subheading"><h3>Milestones</h3><span class="muted">Catatan dan link terlihat langsung</span></div><div class="journey">${mileHtml}</div></section><section class="panel detail-card ${isDone(p)?'done-project':''}"><div class="subheading"><h3>Google Drive & working links</h3><button class="btn mini" data-add-link="${p.id}">+ Custom link</button></div><div class="links-grid">${linkEntries.map(([label,url])=>`<div class="link-edit"><b>${esc(label)}</b><div class="link-row"><input class="link-input" data-link-input="${p.id}|${esc(label)}" value="${esc(url)}" placeholder="drive.google.com/... atau https://..."/><button class="save-mini" data-save-link="${p.id}|${esc(label)}">Save</button>${isClickableLink(url)?`<a class="save-mini" href="${esc(normalizedLink(url))}" target="_blank" rel="noopener">Open ↗</a>`:''}${!['Brief','Master Drive','Working File','Final Output'].includes(label)?`<button class="remove-link" title="Remove" data-remove-link="${p.id}|${esc(label)}">×</button>`:''}</div></div>`).join('')}</div></section>`;
  document.querySelectorAll('[data-open-milestone]').forEach(el=>el.addEventListener('click',()=>{const [project,mile]=el.dataset.openMilestone.split('|');openMilestoneModal(mile,project)}));
  document.querySelectorAll('[data-move-milestone]').forEach(el=>el.addEventListener('click',()=>{const [project,mile,direction]=el.dataset.moveMilestone.split('|');moveMilestone(project,mile,direction)}));
  document.querySelector('[data-edit-project]')?.addEventListener('click',()=>openProjectModal(p.id));
  document.querySelector('[data-export-project-pdf]')?.addEventListener('click',()=>exportProjectPdf(p));
  document.querySelector('[data-add-milestone-project]')?.addEventListener('click',()=>openMilestoneModal(null,p.id,iso(today)));
  document.querySelector('[data-save-project-note]')?.addEventListener('click',()=>{p.note=document.getElementById('projectOverviewNote').value;save();showToast('Project note saved')});
  document.querySelectorAll('[data-save-link]').forEach(el=>el.addEventListener('click',()=>{const [pid,label]=el.dataset.saveLink.split('|');const proj=findProject(pid),input=document.querySelector(`[data-link-input="${CSS.escape(pid+'|'+label)}"]`);proj.links[label]=input.value.trim();save();showToast('Link saved')}));
  document.querySelectorAll('[data-remove-link]').forEach(el=>el.addEventListener('click',()=>{const [pid,label]=el.dataset.removeLink.split('|');delete findProject(pid).links[label];save();renderDetail();showToast('Link removed')}));
  document.querySelector('[data-add-link]')?.addEventListener('click',()=>addCustomLink(p.id));
}
function clearProjectMilestonePlanner(){
  const rows=document.getElementById('projectMilestoneRows');
  if(rows)rows.innerHTML='';
  syncProjectMilestonePlanner();
}
function addProjectMilestoneRow(data={}){
  const rows=document.getElementById('projectMilestoneRows');
  if(!rows)return;
  const defaultDate=data.deadline||data.end||document.getElementById('projectDeadline')?.value||iso(addDays(today,7));
  const row=document.createElement('div');
  row.className='project-milestone-row';
  row.innerHTML=`<input class="planned-milestone-name" list="milestoneSuggestions" value="${esc(data.name||'')}" placeholder="Milestone name"/><input class="planned-milestone-date" type="date" value="${esc(defaultDate)}" aria-label="Milestone deadline"/><input class="planned-milestone-pic" value="${esc(data.pic||'')}" placeholder="PIC (optional)" aria-label="Milestone PIC"/><button class="remove-planned-milestone" type="button" title="Remove milestone">×</button>`;
  rows.appendChild(row);
  row.querySelector('.planned-milestone-date').addEventListener('change',syncProjectMilestonePlanner);
  row.querySelector('.remove-planned-milestone').addEventListener('click',()=>{row.remove();syncProjectMilestonePlanner()});
  syncProjectMilestonePlanner();
}
function syncProjectMilestonePlanner(){
  const rows=[...document.querySelectorAll('#projectMilestoneRows .project-milestone-row')];
  const empty=document.getElementById('projectMilestoneEmpty');
  if(empty)empty.classList.toggle('hidden',rows.length>0);
  const dates=rows.map(row=>row.querySelector('.planned-milestone-date')?.value).filter(Boolean);
  const deadline=document.getElementById('projectDeadline');
  if(deadline&&dates.length)deadline.value=dates[dates.length-1];
}
function collectPlannedMilestones(){
  const rows=[...document.querySelectorAll('#projectMilestoneRows .project-milestone-row')];
  if(!rows.length)return {items:[],error:'Tambahkan minimal satu milestone untuk project ini.'};
  const items=[];
  for(const row of rows){
    const name=row.querySelector('.planned-milestone-name')?.value.trim();
    const date=row.querySelector('.planned-milestone-date')?.value;
    if(!name||!date)return {items:[],error:'Lengkapi nama dan deadline untuk setiap milestone.'};
    const pic=row.querySelector('.planned-milestone-pic')?.value.trim()||'';
    items.push({id:uid('m'),name,start:date,end:date,status:'',note:'',pic,picNote:'',drive:'',sequence:items.length});
  }
  return {items,error:''};
}
function openProjectModal(id=null,presetDate=null){
  const existing=id?findProject(id):null;
  document.getElementById('projectModalTitle').textContent=existing?'Edit project':'New project';
  document.getElementById('projectId').value=existing?.id||'';
  populateBrandSelect(existing?.brand||'Nutriflakes');
  document.getElementById('projectType').value=existing?.type||'Sub-brand / Product';
  document.getElementById('projectName').value=existing?.name||'';
  document.getElementById('projectDeadline').value=existing?.deadline||presetDate||iso(addDays(today,7));
  document.getElementById('projectPic').value=existing?.pic||'';
  document.getElementById('projectNote').value=existing?.note||'';
  document.getElementById('projectMilestonePlanField').classList.toggle('hidden',!!existing);
  document.getElementById('projectMilestoneEditHint').classList.toggle('hidden',!existing);
  clearProjectMilestonePlanner();
  if(!existing)addProjectMilestoneRow({deadline:presetDate||iso(addDays(today,7))});
  document.getElementById('deleteProjectBtn').classList.toggle('hidden',!existing);
  document.getElementById('projectModal').classList.add('open')
}
function closeModal(id){document.getElementById(id).classList.remove('open')}
function saveProject(){
  const id=document.getElementById('projectId').value,existing=id?findProject(id):null,name=document.getElementById('projectName').value.trim();
  if(!name){showToast('Project name is required');return}
  const brand=document.getElementById('projectBrand').value;ensureUmbrella(brand);
  let milestones=existing?.milestones||[];
  if(!existing){
    const planned=collectPlannedMilestones();
    if(planned.error){showToast(planned.error);return}
    milestones=planned.items;
  }
  const deadline=milestones.length?milestones[milestones.length-1].end:document.getElementById('projectDeadline').value;
  const data={id:existing?.id||uid('p'),brand,type:document.getElementById('projectType').value,name,deadline,pic:document.getElementById('projectPic').value.trim(),note:document.getElementById('projectNote').value.trim(),links:existing?.links||defaultLinks(),milestones};
  if(!existing){projects.push(data);selectedId=data.id}else Object.assign(existing,data);
  deriveProjectFromMilestones(existing||data);refreshProjectViews();closeModal('projectModal');if(!existing)data.milestones.forEach(m=>queueMilestoneCalendarSync('upsert',data,m));showToast(existing?'Project updated':'Project added')
}
function deleteProject(){const id=document.getElementById('projectId').value;if(!id||!confirm('Hapus project ini beserta semua milestone?'))return;const deletedProject=findProject(id);projects=projects.filter(p=>p.id!==id);selectedId=projects[0]?.id||null;save();closeModal('projectModal');renderTimelineSection();renderProjects();renderHome();renderDetail();if(deletedProject)deletedProject.milestones.forEach(m=>queueMilestoneCalendarSync('delete',deletedProject,m));showToast('Project deleted')}
function populateMilestoneProjects(selected){document.getElementById('milestoneProject').innerHTML=sortProjects(projects).map(p=>`<option value="${p.id}" ${p.id===selected?'selected':''}>${esc(p.brand)} · ${esc(p.name)}</option>`).join('')}
function openMilestoneModal(mid=null,pid=null,presetDate=null){const p=findProject(pid)||findProject(selectedId)||projects[0];if(!p)return;const m=mid?findMilestone(p,mid):null;populateMilestoneProjects(p.id);document.getElementById('milestoneModalTitle').textContent=m?'Edit milestone':'Add milestone';document.getElementById('milestoneId').value=m?.id||'';document.getElementById('milestoneProjectId').value=p.id;document.getElementById('milestoneName').value=m?.name||'';document.getElementById('milestoneStatus').value=m?.status||'Progress';document.getElementById('milestoneStart').value=m?.start||presetDate||iso(today);document.getElementById('milestoneEnd').value=m?.end||presetDate||iso(today);document.getElementById('milestoneNote').value=m?.note||'';document.getElementById('milestonePic').value=m?.pic||'';document.getElementById('milestonePicNote').value=m?.picNote||'';document.getElementById('milestoneDrive').value=m?.drive||'';document.getElementById('deleteMilestoneBtn').classList.toggle('hidden',!m);document.getElementById('milestoneModal').classList.add('open')}
function saveMilestone(){
  const originalPid=document.getElementById('milestoneProjectId').value,id=document.getElementById('milestoneId').value,targetPid=document.getElementById('milestoneProject').value,name=document.getElementById('milestoneName').value.trim(),start=document.getElementById('milestoneStart').value,end=document.getElementById('milestoneEnd').value;
  if(!name||!start||!end){showToast('Milestone, start date, and due date are required');return}
  if(end<start){showToast('Due date cannot be before start date');return}
  const data={id:id||uid('m'),name,start,end,status:document.getElementById('milestoneStatus').value,note:document.getElementById('milestoneNote').value.trim(),pic:document.getElementById('milestonePic').value.trim(),picNote:document.getElementById('milestonePicNote').value.trim(),drive:document.getElementById('milestoneDrive').value.trim(),sequence:0};
  let previousSequence=0;
  if(id){const old=findProject(originalPid);const existingMilestone=findMilestone(old,id);previousSequence=existingMilestone?.sequence??0;old.milestones=old.milestones.filter(x=>x.id!==id);deriveProjectFromMilestones(old)}
  const target=findProject(targetPid);data.sequence=id&&targetPid===originalPid?previousSequence:target.milestones.length;target.milestones.push(data);deriveProjectFromMilestones(target);selectedId=targetPid;
  refreshProjectViews();closeModal('milestoneModal');queueMilestoneCalendarSync('upsert',target,data);showToast(id?'Milestone updated':'Milestone added to project')
}
function deleteMilestone(){const pid=document.getElementById('milestoneProjectId').value,mid=document.getElementById('milestoneId').value;if(!pid||!mid||!confirm('Hapus milestone ini?'))return;const p=findProject(pid),deleted=findMilestone(p,mid);p.milestones=p.milestones.filter(m=>m.id!==mid);deriveProjectFromMilestones(p);refreshProjectViews();closeModal('milestoneModal');if(deleted)queueMilestoneCalendarSync('delete',p,deleted);showToast('Milestone deleted')}
function moveMilestone(projectId,milestoneId,direction){
  const p=findProject(projectId);if(!p)return;
  const ordered=orderMilestones(p),index=ordered.findIndex(m=>m.id===milestoneId),target=direction==='up'?index-1:index+1;
  if(index<0||target<0||target>=ordered.length)return;
  [ordered[index],ordered[target]]=[ordered[target],ordered[index]];
  p.milestones=ordered.map((m,i)=>({...m,sequence:i}));
  deriveProjectFromMilestones(p);refreshProjectViews();showToast('Milestone order updated')
}
function populateYearPlanBrands(selected){document.getElementById('yearPlanBrand').innerHTML=umbrellas.map(u=>`<option value="${esc(u.name)}" ${u.name===selected?'selected':''}>${esc(u.name)}</option>`).join('')}
function populateYearPlanMonths(selected){document.getElementById('yearPlanMonth').innerHTML=MONTH_NAMES.map((m,i)=>`<option value="${i}" ${i===Number(selected)?'selected':''}>${m}</option>`).join('')}
function openYearPlanModal(id=null,brand=null,year=null,month=null){const existing=id?yearPlans.find(n=>n.id===id):null;const activeYear=existing?.year??year??selectedYear,activeBrand=existing?.brand??brand??umbrellas[0]?.name??'Nutriflakes',activeMonth=existing?.month??month??0;populateYearPlanBrands(activeBrand);populateYearPlanMonths(activeMonth);document.getElementById('yearPlanModalTitle').textContent=existing?'Edit year note':'Add year note';document.getElementById('yearPlanId').value=existing?.id||'';document.getElementById('yearPlanYear').value=activeYear;document.getElementById('yearPlanTitle').value=existing?.title||'';document.getElementById('yearPlanNote').value=existing?.note||'';document.getElementById('deleteYearPlanBtn').classList.toggle('hidden',!existing);document.getElementById('yearPlanModal').classList.add('open')}
function saveYearPlan(){const id=document.getElementById('yearPlanId').value,title=document.getElementById('yearPlanTitle').value.trim();if(!title){showToast('Planning title is required');return}const existing=id?yearPlans.find(n=>n.id===id):null,data={id:existing?.id||uid('yp'),brand:document.getElementById('yearPlanBrand').value,year:Number(document.getElementById('yearPlanYear').value||selectedYear),month:Number(document.getElementById('yearPlanMonth').value),title,note:document.getElementById('yearPlanNote').value.trim()};if(existing)Object.assign(existing,data);else yearPlans.push(data);persistYearPlans();persistUmbrellas();closeModal('yearPlanModal');renderTimelineSection();showToast(existing?'Year note updated':'Year note added')}
function deleteYearPlan(){const id=document.getElementById('yearPlanId').value;if(!id||!confirm('Hapus catatan tahunan ini?'))return;yearPlans=yearPlans.filter(n=>n.id!==id);persistYearPlans();closeModal('yearPlanModal');renderTimelineSection();showToast('Year note deleted')}
function noteHtml(value){return linkifyText(value)}
function populateNoteBrands(selected){const select=document.getElementById('noteBrand');if(!select)return;const value=selected||select.value||umbrellas[0]?.name||'Nutriflakes';select.innerHTML=umbrellas.map(u=>`<option value="${esc(u.name)}" ${u.name===value?'selected':''}>${esc(u.name)}</option>`).join('')}
function syncNotesControls(){const brandFilter=document.getElementById('notesBrandFilter');if(!brandFilter)return;const current=brandFilter.value||'all';brandFilter.innerHTML='<option value="all">All umbrella brands</option>'+umbrellas.map(u=>`<option value="${esc(u.name)}">${esc(u.name)}</option>`).join('');brandFilter.value=umbrellas.some(u=>u.name===current)?current:'all'}
function clearNoteComposer(){const id=document.getElementById('noteId');if(!id)return;id.value='';populateNoteBrands();document.getElementById('noteTitle').value='';document.getElementById('noteContent').value='';document.getElementById('noteLink').value='';document.getElementById('noteDate').value=iso(today);document.getElementById('noteComposerTitle').textContent='New note';document.getElementById('saveNoteBtn').textContent='Save note'}
function loadNoteIntoComposer(id){const n=notes.find(x=>x.id===id);if(!n)return;document.getElementById('noteId').value=n.id;populateNoteBrands(n.brand);document.getElementById('noteTitle').value=n.title;document.getElementById('noteContent').value=n.content;document.getElementById('noteLink').value=n.link||'';document.getElementById('noteDate').value=noteDateFrom(n.date);document.getElementById('noteComposerTitle').textContent='Edit note';document.getElementById('saveNoteBtn').textContent='Update note';document.getElementById('noteTitle').focus()}
function saveNote(){const id=document.getElementById('noteId').value,title=document.getElementById('noteTitle').value.trim(),content=document.getElementById('noteContent').value.trim(),link=document.getElementById('noteLink').value.trim(),brand=document.getElementById('noteBrand').value,date=document.getElementById('noteDate').value||iso(today);if(!title&&!content&&!link){showToast('Isi judul, catatan, atau link terlebih dahulu');return}const existing=id?notes.find(n=>n.id===id):null,now=new Date().toISOString(),data={id:existing?.id||uid('note'),brand,title:title||'Untitled note',content,link,date,createdAt:existing?.createdAt||now,updatedAt:now};if(existing)Object.assign(existing,data);else notes.unshift(data);persistNotes();renderNotes();clearNoteComposer();showToast(existing?'Note updated':'Note saved')}
function deleteNote(id){if(!confirm('Hapus note ini?'))return;notes=notes.filter(n=>n.id!==id);persistNotes();renderNotes();showToast('Note deleted')}
function renderNotes(){const holder=document.getElementById('notesList');if(!holder)return;populateNoteBrands();syncNotesControls();const brand=document.getElementById('notesBrandFilter')?.value||'all',sortMode=document.getElementById('notesSort')?.value||'newest';const filtered=notes.filter(n=>brand==='all'||n.brand===brand);const sorted=[...filtered].sort((a,b)=>sortMode==='oldest'?String(a.date).localeCompare(String(b.date)):String(b.date).localeCompare(String(a.date)));if(!sorted.length){holder.innerHTML='<div class="notes-empty">Belum ada note pada filter ini. Tulis catatan pertama di panel kanan.</div>';return}const dateFmt=new Intl.DateTimeFormat('id-ID',{day:'numeric',month:'short',year:'numeric'});holder.innerHTML=`<div class="notes-table-wrap"><table class="notes-table"><thead><tr><th>Title</th><th>Note</th><th>Link</th><th>Umbrella</th><th>Date</th><th></th></tr></thead><tbody>${sorted.map(n=>{const long=n.content.length>220;const body=n.content?long?`<details class="note-body-details"><summary><div class="note-body note-body-preview">${noteHtml(n.content)}</div></summary><div class="note-body">${noteHtml(n.content)}</div></details>`:`<div class="note-body">${noteHtml(n.content)}</div>`:'<span class="muted">—</span>';const link=isClickableLink(n.link)?`<a class="note-link" href="${esc(normalizedLink(n.link))}" target="_blank" rel="noopener">Open ↗</a>`:'<span class="muted">—</span>';return `<tr><td class="note-title">${esc(n.title)}</td><td>${body}</td><td>${link}</td><td><span class="note-brand-chip"><i class="note-brand-dot" style="background:${baseColor(n.brand)}"></i>${esc(n.brand)}</span></td><td class="note-date">${dateFmt.format(dateObj(n.date))}</td><td><div class="note-actions"><button data-note-edit="${n.id}">Edit</button><button class="delete-note" data-note-delete="${n.id}">Delete</button></div></td></tr>`}).join('')}</tbody></table></div>`;document.querySelectorAll('[data-note-edit]').forEach(el=>el.addEventListener('click',()=>loadNoteIntoComposer(el.dataset.noteEdit)));document.querySelectorAll('[data-note-delete]').forEach(el=>el.addEventListener('click',()=>deleteNote(el.dataset.noteDelete)))}
function renderUmbrellaList(){
  const holder=document.getElementById('umbrellaList');
  if(!holder)return;
  if(!umbrellas.length){holder.innerHTML='<div class="empty">Belum ada umbrella brand.</div>';return}
  holder.innerHTML=umbrellas.map((u,i)=>`<div class="umbrella-row"><strong><span class="umbrella-dot" style="background:${esc(asHexOrHsl(u.color))}"></span>${esc(u.name)}</strong><div style="display:flex;align-items:center;gap:7px"><input type="color" value="${esc(String(u.color||autoColor(u.name)).startsWith('#')?u.color:'#64748b')}" data-umbrella-color="${i}" style="width:38px;height:32px;border:1px solid var(--line);border-radius:8px;background:#fff"><button type="button" class="mini" data-umbrella-update="${i}">Update</button><button type="button" class="mini danger" data-umbrella-delete="${i}">Delete</button></div></div>`).join('');
  holder.querySelectorAll('[data-umbrella-update]').forEach(btn=>btn.addEventListener('click',()=>{
    const i=Number(btn.dataset.umbrellaUpdate); const input=holder.querySelector(`[data-umbrella-color="${i}"]`);
    if(!umbrellas[i]||!input)return;
    umbrellas[i].color=input.value;
    persistUmbrellas(); syncBrandControls(); renderAll(); openUmbrellaModal(); showToast('Umbrella color updated');
  }));
  holder.querySelectorAll('[data-umbrella-delete]').forEach(btn=>btn.addEventListener('click',()=>{
    const i=Number(btn.dataset.umbrellaDelete); const u=umbrellas[i]; if(!u)return;
    const used=projects.some(p=>p.brand===u.name)||yearPlans.some(n=>n.brand===u.name)||notes.some(n=>n.brand===u.name);
    if(used){showToast('Umbrella masih dipakai project/note');return}
    if(!confirm('Hapus umbrella brand ini?'))return;
    umbrellas.splice(i,1); persistUmbrellas(); syncBrandControls(); renderUmbrellaList(); renderAll(); showToast('Umbrella deleted');
  }));
}
function openUmbrellaModal(){renderUmbrellaList();document.getElementById('umbrellaName').value='';document.getElementById('umbrellaColor').value='#B86A3C';document.getElementById('umbrellaModal').classList.add('open')}
function saveUmbrella(){const name=document.getElementById('umbrellaName').value.trim(),color=document.getElementById('umbrellaColor').value;if(!name){showToast('Umbrella name is required');return}if(umbrellas.some(u=>u.name.toLowerCase()===name.toLowerCase())){showToast('Umbrella brand already exists');return}umbrellas.push(normalizeUmbrella({name,color}));persistUmbrellas();syncBrandControls();renderUmbrellaList();populateBrandSelect(name);document.getElementById('umbrellaName').value='';showToast('Umbrella brand added')}
function exportProjectPdf(p){const previous=document.title;document.title=`${safeFileName(p.brand)}-${safeFileName(p.name)}-Project-Report`;const restore=()=>{document.title=previous;document.body.classList.remove('printing-project')};document.body.classList.add('printing-project');window.addEventListener('afterprint',restore,{once:true});window.print()}

function applyTheme(theme){
  const next=theme==='dark'?'dark':'light';
  appSettings.theme=next;
  document.body.dataset.theme=next;
  const btn=document.getElementById('themeToggleBtn');
  if(btn) btn.textContent=next==='dark'?'Light mode':'Dark mode';
  try{localStorage.setItem(THEME_STORAGE_KEY,next)}catch(e){}
}
function toggleTheme(){
  applyTheme(appSettings.theme==='dark'?'light':'dark');
  if(supabaseClient) scheduleCloudSave();
}

function isSupabaseConfigured(){
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY && TABLES.projects && !SUPABASE_URL.includes('PASTE_') && !SUPABASE_ANON_KEY.includes('PASTE_'));
}
function setCloudStatus(text,kind='warn'){
  const el=document.getElementById('cloudStatus'); if(!el)return;
  el.textContent=text; el.className='cloud-status '+kind;
}
function currentStatePayload(){
  return {
    version:APP_DATA_VERSION,
    updatedAt:new Date().toISOString(),
    appSettings:{...appSettings,legacyImported:!!appSettings.legacyImported},
    umbrellas:umbrellas.map(normalizeUmbrella),
    projects:projects.map(normalizeProject),
    yearPlans:yearPlans.map(normalizeYearPlan),
    notes:notes.map(normalizeNote),
    lastBackup:String(lastBackup||'')
  };
}
function migrateStatePayload(data={}){
  const source=data&&typeof data==='object'?data:{};
  const version=Number(source.version)||1;
  const migrated={...source,version:APP_DATA_VERSION};
  if(!Array.isArray(migrated.umbrellas)||!migrated.umbrellas.length) migrated.umbrellas=DEFAULT_UMBRELLAS.map(normalizeUmbrella);
  if(!Array.isArray(migrated.projects)) migrated.projects=[];
  if(!Array.isArray(migrated.yearPlans)) migrated.yearPlans=[];
  if(!Array.isArray(migrated.notes)) migrated.notes=[];
  if(!migrated.appSettings||typeof migrated.appSettings!=="object") migrated.appSettings={};
  migrated.appSettings.theme=migrated.appSettings.theme==="dark"?"dark":"light";
  migrated.appSettings.legacyImported=!!migrated.appSettings.legacyImported;
  migrated.umbrellas=migrated.umbrellas.filter(u=>u&&u.name).map(normalizeUmbrella);
  migrated.projects=migrated.projects.map(normalizeProject);
  migrated.yearPlans=migrated.yearPlans.map(normalizeYearPlan);
  migrated.notes=migrated.notes.map(normalizeNote);
  const referencedBrands=new Set([
    ...migrated.projects.map(p=>p.brand),
    ...migrated.yearPlans.map(n=>n.brand),
    ...migrated.notes.map(n=>n.brand)
  ].filter(Boolean));
  for(const brand of referencedBrands)if(!migrated.umbrellas.some(u=>u.name===brand))migrated.umbrellas.push(normalizeUmbrella({name:brand,color:autoColor(brand)}));
  migrated.lastBackup=String(migrated.lastBackup||'');
  migrated.migratedFrom=version;
  return migrated;
}
function applyStatePayload(data={},preserveSelection=false){
  const oldSelection=selectedId;
  const migrated=migrateStatePayload(data);
  umbrellas=migrated.umbrellas;
  projects=migrated.projects;
  yearPlans=migrated.yearPlans;
  notes=migrated.notes;
  appSettings={...appSettings,...migrated.appSettings};
  applyTheme(appSettings.theme);
  lastBackup=migrated.lastBackup;
  selectedId=preserveSelection&&projects.some(p=>p.id===oldSelection)?oldSelection:(projects[0]?.id||null);
}

function canonicalize(value){
  if(Array.isArray(value)) return value.map(canonicalize);
  if(value&&typeof value==='object') return Object.keys(value).sort().reduce((out,key)=>{out[key]=canonicalize(value[key]);return out},{});
  return value;
}
function fingerprint(value){return JSON.stringify(canonicalize(value))}
function stateFingerprint(value){
  const s=migrateStatePayload(value);
  return fingerprint({
    appSettings:{theme:s.appSettings?.theme||'light',legacyImported:!!s.appSettings?.legacyImported},
    umbrellas:s.umbrellas.map(u=>({id:u.id,name:u.name,color:u.color})),
    projects:s.projects.map(p=>({id:p.id,brand:p.brand,type:p.type,name:p.name,deadline:p.deadline,pic:p.pic||'',note:p.note||'',links:p.links||{},milestones:orderMilestones(p).map(m=>({id:m.id,name:m.name,start:m.start,end:m.end,status:m.status||'',note:m.note||'',pic:m.pic||'',picNote:m.picNote||'',drive:m.drive||'',sequence:m.sequence}))})),
    yearPlans:s.yearPlans.map(n=>({id:n.id,brand:n.brand,year:n.year,month:n.month,title:n.title,note:n.note})),
    notes:s.notes.map(n=>({id:n.id,brand:n.brand,title:n.title,content:n.content,link:n.link,date:n.date})),
    lastBackup:s.lastBackup
  });
}
function safeLocalRead(key){try{const raw=localStorage.getItem(key);return raw?JSON.parse(raw):null}catch(e){return null}}
function safeLocalWrite(key,value){try{localStorage.setItem(key,JSON.stringify(value));return true}catch(e){return false}}
function safeLocalRemove(key){try{localStorage.removeItem(key)}catch(e){}}
function writePendingCache(){
  if(!cloudLoadComplete)return;
  safeLocalWrite(LOCAL_PENDING_CACHE_KEY,{savedAt:new Date().toISOString(),state:currentStatePayload()});
}
function writeSyncedCache({clearPending=true}={}){
  safeLocalWrite(LOCAL_SYNCED_CACHE_KEY,{savedAt:new Date().toISOString(),state:currentStatePayload()});
  if(clearPending){safeLocalRemove(LOCAL_PENDING_CACHE_KEY);pendingLocalRecovery=null;}
}
function readPendingCache(){return safeLocalRead(LOCAL_PENDING_CACHE_KEY)}
function readSyncedCache(){return safeLocalRead(LOCAL_SYNCED_CACHE_KEY)}
function hasMeaningfulState(data){
  const s=migrateStatePayload(data||{});
  return s.projects.length>0||s.yearPlans.length>0||s.notes.length>0||s.umbrellas.some(u=>!DEFAULT_UMBRELLAS.some(d=>d.name===u.name));
}

function serializeUmbrella(u){
  const x=normalizeUmbrella(u);
  return {id:x.id,user_id:currentUser.id,name:x.name,color:x.color};
}
function serializeProject(p){
  const x=normalizeProject(p);
  return {id:String(x.id),user_id:currentUser.id,brand:String(x.brand),type:String(x.type||'General Project'),name:String(x.name||'Untitled'),deadline:x.deadline||null,pic:String(x.pic||''),note:String(x.note||''),links:x.links&&typeof x.links==='object'?x.links:{}};
}
function serializeMilestone(m,projectId){
  const x=normalizeMilestone(m);
  return {id:String(x.id),user_id:currentUser.id,project_id:String(projectId),name:String(x.name),start_date:x.start,due_date:x.end,status:String(x.status||''),note:String(x.note||''),pic:String(x.pic||''),pic_note:String(x.picNote||''),drive_url:String(x.drive||''),sequence:Number(x.sequence)||0};
}
function serializeYearPlan(n){
  const x=normalizeYearPlan(n);
  return {id:String(x.id),user_id:currentUser.id,brand:x.brand,year:x.year,month:x.month,title:x.title,note:x.note};
}
function serializeNote(n){
  const x=normalizeNote(n);
  return {id:String(x.id),user_id:currentUser.id,brand:x.brand,title:x.title||'Untitled note',content:x.content,link:x.link,note_date:x.date};
}
function serializeSettings(){
  return {user_id:currentUser.id,theme:appSettings.theme==='dark'?'dark':'light',last_backup_at:lastBackup||null,legacy_imported:!!appSettings.legacyImported};
}
function buildCurrentRows(){
  return {
    umbrellas:umbrellas.map(serializeUmbrella),
    projects:projects.map(serializeProject),
    milestones:projects.flatMap(p=>orderMilestones(p).map(m=>serializeMilestone(m,p.id))),
    yearPlans:yearPlans.map(serializeYearPlan),
    notes:notes.map(serializeNote),
    settings:[serializeSettings()]
  };
}
function rowId(tableKey,row){return tableKey==='settings'?row.user_id:row.id}
function comparableRow(row){
  const copy={...row};
  delete copy.created_at;delete copy.updated_at;delete copy.deleted_at;
  return copy;
}
function setBaselineFromDb(dbRows){
  baseline=createEmptyBaseline();
  const current=buildCurrentRows();
  for(const key of Object.keys(baseline)){
    const currentMap=new Map((current[key]||[]).map(r=>[rowId(key,r),r]));
    for(const dbRow of dbRows[key]||[]){
      const id=rowId(key,dbRow),local=currentMap.get(id);
      baseline[key].set(id,{updatedAt:dbRow.updated_at||null,fingerprint:fingerprint(local||comparableRow(dbRow))});
    }
  }
}

async function fetchAllRows(tableKey,{deleted='active',order='created_at'}={}){
  const table=TABLES[tableKey];
  if(!table)throw new Error(`Missing table config: ${tableKey}`);
  const rows=[];
  for(let from=0;;from+=PAGE_SIZE){
    let query=supabaseClient.from(table).select('*').eq('user_id',currentUser.id);
    if(deleted==='active')query=query.is('deleted_at',null);
    if(deleted==='deleted')query=query.not('deleted_at','is',null);
    if(order)query=query.order(order,{ascending:true});
    const {data,error}=await query.range(from,from+PAGE_SIZE-1);
    if(error)throw error;
    rows.push(...(data||[]));
    if(!data||data.length<PAGE_SIZE)break;
  }
  return rows;
}
async function fetchSettingsRow(){
  const {data,error}=await supabaseClient.from(TABLES.settings).select('*').eq('user_id',currentUser.id).maybeSingle();
  if(error)throw error;
  return data;
}

function stateFromDbRows(db){
  const projectMap=new Map((db.projects||[]).map(r=>[r.id,{id:r.id,brand:r.brand,type:r.type,name:r.name,deadline:r.deadline||iso(today),pic:r.pic||'',note:r.note||'',links:r.links&&typeof r.links==='object'?r.links:defaultLinks(),milestones:[]} ]));
  for(const r of db.milestones||[]){
    const p=projectMap.get(r.project_id);if(!p)continue;
    p.milestones.push(normalizeMilestone({id:r.id,name:r.name,start:r.start_date,end:r.due_date,status:r.status,note:r.note,pic:r.pic,picNote:r.pic_note,drive:r.drive_url,sequence:r.sequence}));
  }
  const settings=db.settings?.[0]||null;
  return {
    version:APP_DATA_VERSION,
    umbrellas:(db.umbrellas||[]).length?(db.umbrellas||[]).map(r=>normalizeUmbrella({id:r.id,name:r.name,color:r.color})):DEFAULT_UMBRELLAS.map(normalizeUmbrella),
    projects:[...projectMap.values()].map(normalizeProject),
    yearPlans:(db.yearPlans||[]).map(r=>normalizeYearPlan({id:r.id,brand:r.brand,year:r.year,month:r.month,title:r.title,note:r.note})),
    notes:(db.notes||[]).map(r=>normalizeNote({id:r.id,brand:r.brand,title:r.title,content:r.content,link:r.link,date:r.note_date,createdAt:r.created_at,updatedAt:r.updated_at})),
    appSettings:{theme:settings?.theme||appSettings.theme||'light',legacyImported:!!settings?.legacy_imported},
    lastBackup:settings?.last_backup_at||''
  };
}

async function loadCloudState({preserveSelection=false,silent=false}={}){
  if(!supabaseClient||!currentUser)throw new Error('Not authenticated');
  if(!silent)setCloudStatus('Loading cloud data...','warn');
  const [umbrellasRows,projectsRows,milestonesRows,yearPlanRows,noteRows,settingsRow]=await Promise.all([
    fetchAllRows('umbrellas'),fetchAllRows('projects'),fetchAllRows('milestones'),fetchAllRows('yearPlans'),fetchAllRows('notes'),fetchSettingsRow()
  ]);
  const db={umbrellas:umbrellasRows,projects:projectsRows,milestones:milestonesRows,yearPlans:yearPlanRows,notes:noteRows,settings:settingsRow?[settingsRow]:[]};
  const cloudState=stateFromDbRows(db);
  applyStatePayload(cloudState,preserveSelection);
  setBaselineFromDb(db);
  cloudLoadComplete=true;
  supabaseReady=true;
  localDirty=false;
  const pending=readPendingCache();
  writeSyncedCache({clearPending:false});
  if(pending?.state&&stateFingerprint(pending.state)!==stateFingerprint(cloudState)){
    pendingLocalRecovery=pending;
    setCloudStatus('Unsynced local copy tersedia di Recovery','warn');
  }else{
    safeLocalRemove(LOCAL_PENDING_CACHE_KEY);
    pendingLocalRecovery=null;
    setCloudStatus('✓ Saved online','ok');
  }

  renderAll();

  const activeContentCount=projectsRows.length+yearPlanRows.length+noteRows.length;
  if(umbrellasRows.length===0&&activeContentCount===0){
    scheduleCloudSave();
    await saveCloudNow(true);
  }
  return cloudState;
}

function markDirty(){
  mutationVersion+=1;
  localDirty=true;
  writePendingCache();
}
function scheduleCloudSave(){
  if(!cloudLoadComplete){return}
  markDirty();
  if(!supabaseReady||!supabaseClient||!currentUser){setCloudStatus('Offline • perubahan disimpan lokal','warn');return}
  setCloudStatus('Saving...','warn');
  clearTimeout(saveTimer);
  saveTimer=setTimeout(()=>saveCloudNow(),SYNC_DEBOUNCE_MS);
}
function currentRowsMap(rows,tableKey){return new Map((rows||[]).map(r=>[rowId(tableKey,r),r]))}
function hasDeletesInDiff(currentRows){
  return Object.keys(baseline).some(key=>{
    if(key==='settings')return false;
    const now=currentRowsMap(currentRows[key],key);
    return [...baseline[key].keys()].some(id=>!now.has(id));
  });
}
async function createSnapshot(reason='Manual snapshot',payload=null){
  if(!supabaseReady||!currentUser)return null;
  const snapshot=payload||currentStatePayload();
  const {data,error}=await supabaseClient.from(TABLES.snapshots).insert({user_id:currentUser.id,reason,snapshot}).select('id,reason,created_at').single();
  if(error)throw error;
  return data;
}
async function pruneSnapshots(){
  if(!supabaseReady||!currentUser)return;
  const {data,error}=await supabaseClient.from(TABLES.snapshots).select('id,reason,created_at').eq('user_id',currentUser.id).order('created_at',{ascending:false}).limit(5000);
  if(error)throw error;
  const rows=data||[],deleteIds=[];
  const daily=rows.filter(x=>x.reason==='Automatic daily snapshot');
  const ninetyDaysAgo=Date.now()-90*24*60*60*1000;
  const monthlyKept=new Set();
  for(const row of daily){
    const ts=new Date(row.created_at).getTime();
    if(ts>=ninetyDaysAgo)continue;
    const d=new Date(row.created_at),monthKey=`${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`;
    if(monthlyKept.has(monthKey))deleteIds.push(row.id);else monthlyKept.add(monthKey);
  }
  const safety=rows.filter(x=>x.reason==='Automatic safety snapshot before delete');
  deleteIds.push(...safety.slice(100).map(x=>x.id));
  for(let i=0;i<deleteIds.length;i+=200){
    const ids=deleteIds.slice(i,i+200);
    const {error:deleteError}=await supabaseClient.from(TABLES.snapshots).delete().eq('user_id',currentUser.id).in('id',ids);
    if(deleteError)throw deleteError;
  }
}
async function ensureDailySnapshot(){
  if(!supabaseReady||!currentUser)return;
  try{
    const {data,error}=await supabaseClient.from(TABLES.snapshots).select('id,created_at').eq('user_id',currentUser.id).order('created_at',{ascending:false}).limit(1).maybeSingle();
    if(error)throw error;
    const age=data?.created_at?Date.now()-new Date(data.created_at).getTime():Infinity;
    if(age>24*60*60*1000)await createSnapshot('Automatic daily snapshot');
    await pruneSnapshots();
  }catch(err){console.warn('Daily snapshot skipped',err)}
}
async function insertRow(tableKey,row){
  const {data,error}=await supabaseClient.from(TABLES[tableKey]).insert(row).select('*').single();
  if(error){if(error.code==='23505')throw new ConflictError(`Insert conflict in ${tableKey}`);throw error}
  baseline[tableKey].set(rowId(tableKey,data),{updatedAt:data.updated_at||null,fingerprint:fingerprint(row)});
}
async function updateRowWithConflict(tableKey,row,meta){
  const id=rowId(tableKey,row),payload={...row};
  if(tableKey==='settings')delete payload.user_id;else{delete payload.id;delete payload.user_id}
  let query=supabaseClient.from(TABLES[tableKey]).update(payload);
  if(tableKey==='settings')query=query.eq('user_id',id);else query=query.eq('id',id).eq('user_id',currentUser.id);
  if(meta?.updatedAt)query=query.eq('updated_at',meta.updatedAt);
  const {data,error}=await query.select('*');
  if(error)throw error;
  if(!data?.length)throw new ConflictError(`Concurrent edit detected in ${tableKey}`);
  const saved=data[0];
  baseline[tableKey].set(id,{updatedAt:saved.updated_at||null,fingerprint:fingerprint(row)});
}
async function softDeleteRowWithConflict(tableKey,id,meta){
  let query=supabaseClient.from(TABLES[tableKey]).update({deleted_at:new Date().toISOString()}).eq('id',id).eq('user_id',currentUser.id);
  if(meta?.updatedAt)query=query.eq('updated_at',meta.updatedAt);
  const {data,error}=await query.select('id,updated_at,deleted_at');
  if(error)throw error;
  if(!data?.length)throw new ConflictError(`Concurrent delete detected in ${tableKey}`);
  baseline[tableKey].delete(id);
}
async function syncTable(tableKey,rows){
  const base=baseline[tableKey],now=currentRowsMap(rows,tableKey);
  for(const [id,row] of now){
    const meta=base.get(id),fp=fingerprint(row);
    if(!meta)await insertRow(tableKey,row);
    else if(meta.fingerprint!==fp)await updateRowWithConflict(tableKey,row,meta);
  }
  if(tableKey!=='settings'){
    for(const [id,meta] of [...base])if(!now.has(id))await softDeleteRowWithConflict(tableKey,id,meta);
  }
}
async function saveCloudNow(silent=false){
  if(!cloudLoadComplete||!supabaseReady||!supabaseClient||!currentUser){
    if(!silent)setCloudStatus('Offline • perubahan disimpan lokal','warn');
    return false;
  }
  if(syncInFlight){clearTimeout(saveTimer);saveTimer=setTimeout(()=>saveCloudNow(silent),SYNC_DEBOUNCE_MS);return false}
  syncInFlight=true;
  const startVersion=mutationVersion;
  try{
    const rows=buildCurrentRows();
    if(hasDeletesInDiff(rows)){
      const previous=readSyncedCache()?.state||currentStatePayload();
      await createSnapshot('Automatic safety snapshot before delete',previous);
    }
    for(const key of ['umbrellas','projects','milestones','yearPlans','notes','settings'])await syncTable(key,rows[key]);
    if(mutationVersion===startVersion){
      localDirty=false;
      writeSyncedCache();
      setCloudStatus('✓ Saved online','ok');
    }else{
      setCloudStatus('Saving newer changes...','warn');
      clearTimeout(saveTimer);saveTimer=setTimeout(()=>saveCloudNow(),SYNC_DEBOUNCE_MS);
    }
    return true;
  }catch(err){
    console.error(err);
    writePendingCache();
    if(err instanceof ConflictError){
      setCloudStatus('Conflict detected • local copy aman di Recovery','err');
      showToast('Ada perubahan dari device lain. Data lokal disimpan di Recovery.');
    }else{
      setCloudStatus('Save failed • local copy tetap aman','err');
      showToast('Gagal sync. Perubahan tetap tersimpan lokal.');
    }
    return false;
  }finally{
    syncInFlight=false;
  }
}

async function forceReplaceCloudState(payload,{reason='Explicit restore'}={}){
  const desired=migrateStatePayload(payload);
  applyStatePayload(desired);
  appSettings.legacyImported=!!desired.appSettings?.legacyImported;
  const rows=buildCurrentRows();
  const tableOrder=['umbrellas','projects','milestones','yearPlans','notes'];
  for(const key of tableOrder){
    const existing=await fetchAllRows(key,{deleted:'all'});
    const desiredMap=currentRowsMap(rows[key],key);
    for(let i=0;i<rows[key].length;i+=200){
      const chunk=rows[key].slice(i,i+200).map(r=>({...r,deleted_at:null}));
      if(chunk.length){const {error}=await supabaseClient.from(TABLES[key]).upsert(chunk,{onConflict:'id'});if(error)throw error}
    }
    const activeIds=existing.filter(r=>!r.deleted_at&&!desiredMap.has(r.id)).map(r=>r.id);
    for(let i=0;i<activeIds.length;i+=200){
      const ids=activeIds.slice(i,i+200);
      const {error}=await supabaseClient.from(TABLES[key]).update({deleted_at:new Date().toISOString()}).eq('user_id',currentUser.id).in('id',ids);
      if(error)throw error;
    }
  }
  const settings={...serializeSettings(),legacy_imported:!!appSettings.legacyImported};
  const {error:settingsError}=await supabaseClient.from(TABLES.settings).upsert(settings,{onConflict:'user_id'});
  if(settingsError)throw settingsError;
  await loadCloudState({preserveSelection:false,silent:true});
  showToast(reason+' selesai');
}

async function detectLegacyState(){
  legacyStateAvailable=false;
  try{
    const {data,error}=await supabaseClient.rpc('ch_get_legacy_state');
    if(error)throw error;
    legacyStateAvailable=!!data&&hasMeaningfulState(data)&&!appSettings.legacyImported;
  }catch(err){console.warn('Legacy state check skipped',err)}
}
async function importLegacyState(){
  const {data,error}=await supabaseClient.rpc('ch_get_legacy_state');
  if(error)throw error;
  if(!data||!hasMeaningfulState(data)){showToast('Legacy data tidak ditemukan');return}
  if(!confirm('Import data dashboard lama ke database baru? Snapshot kondisi sekarang akan dibuat dulu.'))return;
  await createSnapshot('Before legacy import');
  const migrated=migrateStatePayload(data);
  migrated.appSettings={...migrated.appSettings,legacyImported:true};
  await forceReplaceCloudState(migrated,{reason:'Legacy import'});
  appSettings.legacyImported=true;
  legacyStateAvailable=false;
  await renderRecoveryCenter();
}

async function restorePendingLocal(){
  const pending=readPendingCache();
  if(!pending?.state){showToast('Tidak ada local copy yang pending');return}
  if(!confirm('Pulihkan local copy yang belum tersinkron dan jadikan itu versi aktif? Snapshot cloud saat ini akan dibuat dulu.'))return;
  await createSnapshot('Before restoring unsynced local copy');
  await forceReplaceCloudState(pending.state,{reason:'Local recovery'});
  safeLocalRemove(LOCAL_PENDING_CACHE_KEY);
  pendingLocalRecovery=null;
  await renderRecoveryCenter();
}
async function restoreSnapshot(snapshotId){
  const {data,error}=await supabaseClient.from(TABLES.snapshots).select('id,reason,snapshot,created_at').eq('user_id',currentUser.id).eq('id',snapshotId).single();
  if(error)throw error;
  if(!confirm(`Restore snapshot ${new Date(data.created_at).toLocaleString('id-ID')}? Kondisi sekarang akan disnapshot dulu.`))return;
  await createSnapshot('Before snapshot restore');
  await forceReplaceCloudState(data.snapshot,{reason:'Snapshot restore'});
  await renderRecoveryCenter();
}
async function restoreTrashItem(tableKey,id){
  await createSnapshot(`Before restoring deleted ${tableKey}`);
  const {error}=await supabaseClient.from(TABLES[tableKey]).update({deleted_at:null}).eq('user_id',currentUser.id).eq('id',id);
  if(error)throw error;
  if(tableKey==='projects'){
    const {error:mErr}=await supabaseClient.from(TABLES.milestones).update({deleted_at:null}).eq('user_id',currentUser.id).eq('project_id',id);
    if(mErr)throw mErr;
  }
  await loadCloudState({preserveSelection:true,silent:true});
  await renderRecoveryCenter();
  showToast('Item restored');
}
async function renderRecoveryCenter(){
  const summary=document.getElementById('recoverySummary'),snapshotsEl=document.getElementById('snapshotList'),trashEl=document.getElementById('trashList'),legacyEl=document.getElementById('legacyRecovery');
  if(!summary||!snapshotsEl||!trashEl||!legacyEl||!currentUser)return;
  summary.innerHTML=pendingLocalRecovery||readPendingCache()?'<div class="recovery-alert"><b>Unsynced local copy ditemukan.</b><span>Versi lokal tidak akan pernah otomatis menimpa cloud. Pulihkan hanya jika memang itu versi yang benar.</span><button class="btn mini" id="restorePendingLocalBtn">Restore local copy</button></div>':'<div class="recovery-ok">Tidak ada perubahan lokal yang tertinggal.</div>';
  legacyEl.innerHTML=legacyStateAvailable?'<div class="recovery-alert"><b>Legacy dashboard data tersedia.</b><span>Bisa diimpor satu kali ke struktur database baru.</span><button class="btn mini" id="importLegacyBtn">Import legacy data</button></div>':'';
  const [{data:snapshots,error:sErr},deletedProjects,deletedNotes,deletedPlans,deletedMilestones,deletedUmbrellas]=await Promise.all([
    supabaseClient.from(TABLES.snapshots).select('id,reason,created_at').eq('user_id',currentUser.id).order('created_at',{ascending:false}).limit(20),
    fetchAllRows('projects',{deleted:'deleted',order:'deleted_at'}),
    fetchAllRows('notes',{deleted:'deleted',order:'deleted_at'}),
    fetchAllRows('yearPlans',{deleted:'deleted',order:'deleted_at'}),
    fetchAllRows('milestones',{deleted:'deleted',order:'deleted_at'}),
    fetchAllRows('umbrellas',{deleted:'deleted',order:'deleted_at'})
  ]);
  if(sErr)throw sErr;
  snapshotsEl.innerHTML=(snapshots||[]).length?(snapshots||[]).map(s=>`<div class="recovery-row"><div><b>${esc(s.reason)}</b><small>${new Date(s.created_at).toLocaleString('id-ID')}</small></div><button class="mini" data-restore-snapshot="${esc(s.id)}">Restore</button></div>`).join(''):'<div class="home-empty">Belum ada snapshot.</div>';
  const trash=[
    ...deletedProjects.map(r=>({table:'projects',id:r.id,label:`Project · ${r.name}`})),
    ...deletedNotes.map(r=>({table:'notes',id:r.id,label:`Note · ${r.title}`})),
    ...deletedPlans.map(r=>({table:'yearPlans',id:r.id,label:`Year plan · ${r.title}`})),
    ...deletedMilestones.map(r=>({table:'milestones',id:r.id,label:`Milestone · ${r.name}`})),
    ...deletedUmbrellas.map(r=>({table:'umbrellas',id:r.id,label:`Umbrella · ${r.name}`}))
  ];
  trashEl.innerHTML=trash.length?trash.slice(0,100).map(x=>`<div class="recovery-row"><div><b>${esc(x.label)}</b></div><button class="mini" data-restore-trash="${esc(x.table)}|${esc(x.id)}">Restore</button></div>`).join(''):'<div class="home-empty">Trash kosong.</div>';
  document.getElementById('restorePendingLocalBtn')?.addEventListener('click',()=>restorePendingLocal().catch(handleUiError));
  document.getElementById('importLegacyBtn')?.addEventListener('click',()=>importLegacyState().catch(handleUiError));
  snapshotsEl.querySelectorAll('[data-restore-snapshot]').forEach(b=>b.addEventListener('click',()=>restoreSnapshot(b.dataset.restoreSnapshot).catch(handleUiError)));
  trashEl.querySelectorAll('[data-restore-trash]').forEach(b=>b.addEventListener('click',()=>{const [table,id]=b.dataset.restoreTrash.split('|');restoreTrashItem(table,id).catch(handleUiError)}));
}
function handleUiError(err){console.error(err);showToast(err?.message||'Terjadi error');setCloudStatus('Error • cek Recovery / Console','err')}
async function openRecoveryModal(){
  document.getElementById('recoveryModal').classList.add('open');
  await detectLegacyState();
  await renderRecoveryCenter();
}

function subscribeRealtime(){
  if(!supabaseClient||!currentUser)return;
  if(realtimeChannel)supabaseClient.removeChannel(realtimeChannel);
  let channel=supabaseClient.channel(`creative-hub-${currentUser.id}`);
  for(const key of ['umbrellas','projects','milestones','yearPlans','notes']){
    channel=channel.on('postgres_changes',{event:'*',schema:'public',table:TABLES[key],filter:`user_id=eq.${currentUser.id}`},()=>{
      if(syncInFlight)return;
      if(localDirty||readPendingCache()){
        setCloudStatus('Remote changes detected • review Recovery','warn');
        return;
      }
      clearTimeout(remoteReloadTimer);
      remoteReloadTimer=setTimeout(()=>loadCloudState({preserveSelection:true,silent:true}).catch(handleUiError),350);
    });
  }
  realtimeChannel=channel.subscribe();
}

function showAuthScreen(show=true){
  document.getElementById('authScreen')?.classList.toggle('hidden',!show);
  const app=document.getElementById('appRoot');if(app)app.hidden=show;
}
function setAuthMessage(text,kind=''){
  const el=document.getElementById('authMessage');if(!el)return;el.textContent=text;el.dataset.kind=kind;
}
async function loginWithPassword(){
  const email=OWNER_EMAIL,password=document.getElementById('authPassword').value;
  if(!email||email.includes('GANTI_DENGAN')){setAuthMessage('Isi ownerEmail di config.js terlebih dahulu.','err');return}
  if(!password){setAuthMessage('Isi password.','err');return}
  setAuthMessage('Signing in...');
  const {data,error}=await supabaseClient.auth.signInWithPassword({email,password});
  if(error){setAuthMessage(error.message,'err');return}
  if(data?.user)await startAuthenticatedSession(data.user);
}
async function signOut(){
  clearTimeout(saveTimer);
  if(realtimeChannel)supabaseClient.removeChannel(realtimeChannel);
  realtimeChannel=null;supabaseReady=false;cloudLoadComplete=false;currentUser=null;baseline=createEmptyBaseline();
  await supabaseClient.auth.signOut();
  showAuthScreen(true);setAuthMessage('Signed out.');
}
async function startAuthenticatedSession(user){
  if(currentUser?.id===user.id&&cloudLoadComplete)return;
  currentUser=user;
  showAuthScreen(false);
  setCloudStatus('Checking owner access...','warn');
  const {data:isOwner,error:ownerError}=await supabaseClient.rpc('ch_claim_owner');
  if(ownerError){
    console.error(ownerError);
    showAuthScreen(true);
    setAuthMessage('Database belum disiapkan. Jalankan supabase_schema.sql dulu.','err');
    return;
  }
  if(!isOwner){
    await supabaseClient.auth.signOut();
    currentUser=null;showAuthScreen(true);setAuthMessage('Akun ini bukan owner Creative Hub.','err');return;
  }
  try{
    await loadCloudState();
    subscribeRealtime();
    await detectLegacyState();
    ensureDailySnapshot();
    refreshCalendarStatus();
  }catch(err){
    console.error('Cloud load failed, using emergency cache when available',err);
    const cached=readPendingCache()||readSyncedCache();
    if(cached?.state){
      applyStatePayload(cached.state);
      cloudLoadComplete=true;
      supabaseReady=false;
      localDirty=!!readPendingCache();
      pendingLocalRecovery=readPendingCache();
      renderAll();
      setCloudStatus('Offline fallback • cache lokal aktif, cloud tidak ditimpa','warn');
      showToast('Cloud gagal dimuat. Menampilkan emergency cache lokal.');
    }else{
      throw err;
    }
  }
}
async function initSupabase(){
  if(initStarted)return;initStarted=true;
  if(!isSupabaseConfigured()){showAuthScreen(true);setAuthMessage('config.js belum lengkap.','err');return}
  if(!window.supabase){showAuthScreen(true);setAuthMessage('Supabase library gagal dimuat.','err');return}
  supabaseClient=window.supabase.createClient(SUPABASE_URL,SUPABASE_ANON_KEY,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
  const {data:{session},error}=await supabaseClient.auth.getSession();
  if(error)console.warn(error);
  if(session?.user)await startAuthenticatedSession(session.user);else showAuthScreen(true);
  supabaseClient.auth.onAuthStateChange((event,sessionNow)=>{
    if(event==='SIGNED_OUT'){showAuthScreen(true);return}
    if(sessionNow?.user&&!currentUser)setTimeout(()=>startAuthenticatedSession(sessionNow.user).catch(handleUiError),0);
  });
}

async function calendarRequest(action,payload=null){
  if(!supabaseClient||!currentUser)throw new Error('Belum login');
  const {data:{session}}=await supabaseClient.auth.getSession();
  if(!session?.access_token)throw new Error('Session tidak tersedia');
  const base=`${SUPABASE_URL}/functions/v1/${CALENDAR_FUNCTION}`;
  const options={method:payload?'POST':'GET',headers:{Authorization:`Bearer ${session.access_token}`,'Content-Type':'application/json'}};
  let url=`${base}?action=${encodeURIComponent(action)}`;
  if(payload)options.body=JSON.stringify({action,...payload});
  const res=await fetch(url,options);
  const json=await res.json().catch(()=>({}));
  if(!res.ok)throw new Error(json.error||`Calendar request gagal (${res.status})`);
  return json;
}
async function connectGoogleCalendar(){
  try{const data=await calendarRequest('start');if(!data.url)throw new Error('OAuth URL tidak tersedia');window.location.href=data.url}catch(err){handleUiError(err)}
}
async function syncOneMilestone(op,project,milestone){
  if(!project||!milestone)return;
  try{await calendarRequest('sync',{op,project:{id:project.id,name:project.name,brand:project.brand,type:project.type,pic:project.pic,note:project.note},milestone})}
  catch(err){console.warn('Calendar sync skipped',err);setCloudStatus('Data saved • Calendar sync gagal','warn')}
}
function queueMilestoneCalendarSync(op,project,milestone){setTimeout(()=>syncOneMilestone(op,project,milestone),900)}
async function syncAllCalendar(){
  try{
    setCloudStatus('Syncing Google Calendar...','warn');
    for(const project of projects)for(const milestone of project.milestones)await syncOneMilestone('upsert',project,milestone);
    setCloudStatus('✓ Saved online • Calendar synced','ok');showToast('Semua milestone tersinkron ke Google Calendar');
  }catch(err){handleUiError(err)}
}
async function refreshCalendarStatus(){
  try{const data=await calendarRequest('status');const btn=document.getElementById('connectCalendarBtn');if(btn)btn.textContent=data.connected?'Calendar Connected':'Connect Calendar'}catch(_){/* optional */}
}

function renderAll(){
  syncBrandControls();
  clearNoteComposer();
  renderHome();
  renderTimelineSection();
  renderProjects();
  renderDetail();
  renderNotes();
}
function exportData(){
  const exportedAt=new Date().toISOString();
  const payload={...currentStatePayload(),exportedAt};
  const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}),a=document.createElement('a');
  a.href=URL.createObjectURL(blob);a.download=`creative-hub-backup-${iso(today)}.json`;a.click();URL.revokeObjectURL(a.href);
  lastBackup=exportedAt;renderHome();scheduleCloudSave();showToast('Backup exported');
}
function importData(file){
  const reader=new FileReader();
  reader.onload=async()=>{
    try{
      const raw=JSON.parse(reader.result);
      const importedProjects=Array.isArray(raw)?raw:raw?.projects;
      if(!Array.isArray(importedProjects))throw new Error('Invalid JSON structure');
      const incoming=migrateStatePayload(Array.isArray(raw)?{projects:raw}:raw);
      if(!confirm(`Import backup ini? ${incoming.projects.length} project, ${incoming.notes.length} notes, ${incoming.yearPlans.length} year plans. Kondisi sekarang akan disnapshot dulu.`))return;
      await createSnapshot('Before JSON import');
      await forceReplaceCloudState(incoming,{reason:'JSON import'});
      showToast('Data imported safely');
    }catch(err){handleUiError(err);showToast('Invalid JSON file')}
  };
  reader.readAsText(file);
}
function navigate(delta){if(timelineView==='calendar')selectedMonth=new Date(selectedMonth.getFullYear(),selectedMonth.getMonth()+delta,1);else if(timelineView==='year')selectedYear+=delta;else startDate=addDays(startDate,delta*rangeDays);renderTimelineSection()}
function goToday(){if(timelineView==='calendar')selectedMonth=new Date(today.getFullYear(),today.getMonth(),1);else if(timelineView==='year')selectedYear=today.getFullYear();else startDate=new Date(today);renderTimelineSection()}

document.querySelectorAll('.tab').forEach(b=>b.addEventListener('click',()=>switchMainView(b.dataset.view)));document.querySelectorAll('[data-timeline-view]').forEach(b=>b.addEventListener('click',()=>setTimelineView(b.dataset.timelineView)));document.querySelectorAll('[data-range]').forEach(b=>b.addEventListener('click',()=>{rangeDays=Number(b.dataset.range);document.querySelectorAll('[data-range]').forEach(x=>x.classList.toggle('active',x===b));renderTimeline()}));document.getElementById('prevBtn').addEventListener('click',()=>navigate(-1));document.getElementById('nextBtn').addEventListener('click',()=>navigate(1));document.getElementById('todayBtn').addEventListener('click',goToday);document.getElementById('brandFilter').addEventListener('change',renderTimelineSection);document.getElementById('newProjectBtn').addEventListener('click',()=>openProjectModal());document.getElementById('addProjectMilestoneBtn').addEventListener('click',()=>addProjectMilestoneRow());document.getElementById('themeToggleBtn').addEventListener('click',toggleTheme);document.getElementById('manageUmbrellasBtn').addEventListener('click',openUmbrellaModal);document.getElementById('newUmbrellaInline').addEventListener('click',openUmbrellaModal);document.getElementById('saveUmbrellaBtn').addEventListener('click',saveUmbrella);document.getElementById('saveProjectBtn').addEventListener('click',saveProject);document.getElementById('deleteProjectBtn').addEventListener('click',deleteProject);document.getElementById('saveMilestoneBtn').addEventListener('click',saveMilestone);document.getElementById('deleteMilestoneBtn').addEventListener('click',deleteMilestone);document.getElementById('saveYearPlanBtn').addEventListener('click',saveYearPlan);document.getElementById('deleteYearPlanBtn').addEventListener('click',deleteYearPlan);document.getElementById('projectSearch').addEventListener('input',renderProjects);document.getElementById('saveNoteBtn').addEventListener('click',saveNote);document.getElementById('clearNoteBtn').addEventListener('click',clearNoteComposer);document.getElementById('notesBrandFilter').addEventListener('change',renderNotes);document.getElementById('notesSort').addEventListener('change',renderNotes);document.getElementById('pickerSearch').addEventListener('input',renderDetail);document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>closeModal(b.dataset.close)));document.querySelectorAll('.modal').forEach(m=>m.addEventListener('click',e=>{if(e.target===m)m.classList.remove('open')}));document.getElementById('exportBtn').addEventListener('click',exportData);document.getElementById('importInput').addEventListener('change',e=>{if(e.target.files[0])importData(e.target.files[0]);e.target.value=''});document.getElementById('projectForm').addEventListener('submit',e=>{e.preventDefault();saveProject()});document.getElementById('milestoneForm').addEventListener('submit',e=>{e.preventDefault();saveMilestone()});document.getElementById('yearPlanForm').addEventListener('submit',e=>{e.preventDefault();saveYearPlan()});
document.getElementById('loginBtn')?.addEventListener('click',()=>loginWithPassword().catch(handleUiError));
document.getElementById('authPassword')?.addEventListener('keydown',e=>{if(e.key==='Enter')loginWithPassword().catch(handleUiError)});
document.getElementById('recoveryBtn')?.addEventListener('click',()=>openRecoveryModal().catch(handleUiError));
document.getElementById('connectCalendarBtn')?.addEventListener('click',()=>connectGoogleCalendar());
document.getElementById('syncCalendarBtn')?.addEventListener('click',()=>syncAllCalendar());
document.getElementById('signOutBtn')?.addEventListener('click',()=>signOut().catch(handleUiError));
document.getElementById('snapshotNowBtn')?.addEventListener('click',async()=>{try{await createSnapshot('Manual snapshot');await renderRecoveryCenter();showToast('Snapshot created')}catch(err){handleUiError(err)}});
window.addEventListener('offline',()=>{setCloudStatus('Offline • perubahan akan disimpan lokal','warn')});
window.addEventListener('online',async()=>{try{if(!currentUser)return;await loadCloudState({preserveSelection:true,silent:true});subscribeRealtime();if(readPendingCache())setCloudStatus('Online again • unsynced local copy ada di Recovery','warn')}catch(err){handleUiError(err)}});

applyTheme(appSettings.theme);
syncBrandControls();clearNoteComposer();renderHome();renderTimelineSection();renderProjects();renderDetail();renderNotes();
initSupabase().catch(handleUiError);
