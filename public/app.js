// ---------------------------------------------------------------------------
// Dat Moi ordering — client. All state lives in Postgres via /api; this file
// keeps an in-memory mirror and writes through on every change.
// ---------------------------------------------------------------------------

const DAY_DEFS = {
  produce: [{ key: 'mon', label: 'MONDAY' }, { key: 'thu', label: 'THURSDAY' }],
  meat: [
    { key: 'mon', label: 'MON' }, { key: 'tue', label: 'TUE' }, { key: 'wed', label: 'WED' },
    { key: 'thu', label: 'THU' }, { key: 'fri', label: 'FRI' }, { key: 'sat', label: 'SAT' }
  ],
  // The fish order goes out Wednesday and Sunday.
  fish: [{ key: 'wed', label: 'WEDNESDAY' }, { key: 'sun', label: 'SUNDAY' }]
};
const DAY_NAMES = { sun:'Sunday', mon:'Monday', tue:'Tuesday', wed:'Wednesday',
                   thu:'Thursday', fri:'Friday', sat:'Saturday' };
const DEPT_TITLES = { produce:'Inventory & Order', meat:'Daily Order', fish:'Daily Order' };

let dept = localStorage.getItem('dm_dept') || 'produce';
let items = [];
let routes = [];
let vendors = [];
let counts = {};        // name -> {shelf, cooler, qty}
let day = 'mon';
let roundChoices = {};
let visibleItems = [];   // the items currently rendered, for the progress counter
let resetArmed = false, resetArmTimer = null;
let armedDeleteGroup = null, armedDeleteTimer = null;

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/'/g, "\\'");
const htmlEsc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fmt = n => (n === null || n === undefined) ? '' : String(Math.round(n * 100) / 100);

// ---- sync indicator ----
let pending = 0;
function syncStart(){ pending++; setSync('saving', 'Saving...'); }
function syncDone(ok){
  pending = Math.max(0, pending - 1);
  if (!ok) return setSync('err', 'Save failed \u2014 check connection');
  if (pending === 0) setSync('saved', 'Saved');
}
function setSync(cls, text){
  const el = $('syncline');
  el.className = 'syncline ' + cls;
  el.textContent = text;
  if (cls === 'saved') setTimeout(()=>{ if (pending===0 && el.classList.contains('saved')) el.textContent = '\u00a0'; }, 1500);
}

async function api(method, path, body, retries = 3){
  for (let i = 0; i < retries; i++){
    try{
      const res = await fetch(`/api/${dept}${path}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined
      });
      if (!res.ok){
        const err = new Error('HTTP ' + res.status);
        err.status = res.status;
        throw err;
      }
      return await res.json();
    }catch(e){
      // A 4xx is the server's final answer — "already exists", "name required" —
      // so retrying only delays the message the user needs to see.
      if (e.status >= 400 && e.status < 500) return null;
      if (i === retries - 1){ console.error('api failed', method, path, e); return null; }
      await new Promise(r => setTimeout(r, 400 * (i + 1)));
    }
  }
}

async function write(method, path, body){
  syncStart();
  const r = await api(method, path, body);
  syncDone(!!r);
  return r;
}

// ---- item helpers ----
// What the vendor is asked for. Items are known internally by the name the store
// sells them under; invdesc holds the vendor's own name for the same thing
// (BANANA BLOSSOM on the shelf is BANANA FLOWER on the order).
function orderName(it){ return (it.invdesc || '').trim() || it.name; }

function parFor(it, d){ return (it.pars && it.pars[d] !== undefined) ? Number(it.pars[d]) : 0; }
function shelfTargetFor(it){ return it.shelf_target === null || it.shelf_target === undefined ? 1 : Number(it.shelf_target); }

function computeOrder(it){
  const e = counts[it.name];
  if (!e) return null;
  if (it.mode === 'shelf_cooler'){
    const s = (e.shelf === null || e.shelf === undefined) ? null : Number(e.shelf);
    const c = (e.cooler === null || e.cooler === undefined) ? null : Number(e.cooler);
    if (s === null && c === null) return null;
    const shelfNeed = Math.max(shelfTargetFor(it) - (s || 0), 0);
    const coolerNeed = Math.max(parFor(it, day) - (c || 0), 0);
    return shelfNeed + coolerNeed;
  }
  const q = (e.qty === null || e.qty === undefined) ? null : Number(e.qty);
  if (q === null) return null;
  return Math.max(parFor(it, day) - q, 0);
}

function isDone(it){
  const e = counts[it.name];
  if (!e) return false;
  if (it.mode === 'shelf_cooler'){
    return e.shelf !== null && e.shelf !== undefined && e.cooler !== null && e.cooler !== undefined;
  }
  return e.qty !== null && e.qty !== undefined;
}

function orderedItems(){
  const active = items.filter(i => i.active);
  if (!routes.length) return active.map(i => ({ item: i, group: null }));
  const byName = {}; active.forEach(i => byName[i.name] = i);
  const placed = new Set(); const out = [];
  routes.forEach(g => {
    (g.item_names || []).forEach(n => {
      if (byName[n] && !placed.has(n)){ out.push({ item: byName[n], group: g.name }); placed.add(n); }
    });
  });
  active.filter(i => !placed.has(i.name))
        .forEach(i => out.push({ item: i, group: 'Not in a section yet' }));
  return out;
}

// ---- department switching ----
async function switchDept(d){
  dept = d;
  localStorage.setItem('dm_dept', d);
  document.body.dataset.dept = d;
  document.querySelectorAll('#deptBar button').forEach(b =>
    b.classList.toggle('active', b.dataset.dept === d));
  $('deptEyebrow').textContent = `DAT MOI \u00b7 ${d.toUpperCase()}`;
  $('deptTitle').textContent = DEPT_TITLES[d];
  roundChoices = {};
  await bootstrap();
  showList();
}

function todayKey(){
  const map = ['sun','mon','tue','wed','thu','fri','sat'];
  const k = map[new Date().getDay()];
  const allowed = DAY_DEFS[dept].map(x => x.key);
  return allowed.includes(k) ? k : allowed[0];
}

async function bootstrap(){
  setSync('saving', 'Loading...');
  const data = await api('GET', '/bootstrap');
  if (!data){ setSync('err', 'Could not load \u2014 check connection'); return; }
  items = data.items.map(i => ({
    ...i,
    case_size: i.case_size === null ? null : Number(i.case_size),
    shelf_target: i.shelf_target === null ? null : Number(i.shelf_target)
  }));
  routes = data.routes;
  vendors = data.vendors;
  counts = {};
  data.counts.forEach(c => {
    counts[c.item_name] = {
      shelf: c.shelf === null ? null : Number(c.shelf),
      cooler: c.cooler === null ? null : Number(c.cooler),
      qty: c.qty === null ? null : Number(c.qty)
    };
  });
  day = data.day && DAY_DEFS[dept].some(x => x.key === data.day) ? data.day : todayKey();
  renderDayToggle();
  renderList();
  setSync('saved', 'Loaded');
}

function renderDayToggle(){
  $('dayToggle').innerHTML = DAY_DEFS[dept]
    .map(d => `<button onclick="setDay('${d.key}')" class="${day===d.key?'active':''}">${d.label}</button>`)
    .join('');
}

async function setDay(d){
  day = d;
  renderDayToggle();
  renderList();
  await write('PUT', '/day', { day: d });
}

// ---- counting list ----
function renderList(){
  const q = $('search').value.trim().toLowerCase();
  const wrap = $('listView');
  wrap.innerHTML = '';
  let total = 0, lastGroup;
  const shown = [];

  orderedItems().forEach(({ item: it, group }) => {
    if (q && !it.name.toLowerCase().includes(q) && !(it.invdesc || '').toLowerCase().includes(q)) return;
    total++;
    if (!q && group !== lastGroup){
      const l = document.createElement('div');
      l.className = 'sectionlabel';
      l.textContent = group || 'Items';
      wrap.appendChild(l);
      lastGroup = group;
    }
    shown.push(it);
    const order = computeOrder(it);

    const row = document.createElement('div');
    row.className = 'row' + (order && order > 0 ? ' hasorder' : '');

    let meta = it.vendor
      ? `<span class="chip">${htmlEsc(it.vendor)}</span>`
      : `<span class="chip note">vendor unassigned</span>`;
    meta += `<span class="chip">PAR ${fmt(parFor(it, day))}</span>`;
    if (it.vendor2) meta += `<span class="chip alt">or ${htmlEsc(it.vendor2)}</span>`;
    if (it.note) meta += `<span class="chip note">${htmlEsc(it.note)}</span>`;

    const ctl = controlsHtml(it);

    row.innerHTML = `
      <div class="row-main">
        <div class="row-name">${htmlEsc(it.name)}</div>
        ${it.invdesc ? `<div class="row-desc">${htmlEsc(it.invdesc)}</div>` : ''}
        <div class="row-meta">${meta}</div>
      </div>
      <div class="row-ctl">${ctl}</div>`;
    row.dataset.name = it.name;
    wrap.appendChild(row);
  });
  visibleItems = shown;

  if (total === 0){
    // An empty list means no search hit, or a department with nothing in it yet.
    wrap.innerHTML = q
      ? '<div class="emptystate">No items match your search.</div>'
      : '<div class="emptystate">No items in this department yet.</div>';
  }
  refreshProgress();
}

// Rebuilding only the row that was touched keeps the rest of the list from
// shifting under a finger mid-count.
function controlsHtml(it){
    const e = counts[it.name] || {};
    const order = computeOrder(it);
    let ctl;
    if (it.mode === 'shelf_cooler'){
      const s = e.shelf;
      ctl = `
        <div class="mini-stepper-group">
          <span class="lbl">Shelf</span>
          <div class="fetoggle">
            <button class="${s===0?'sel-empty':''}" onclick="setCount('${esc(it.name)}','shelf',0)">0</button>
            <button class="${s===0.5?'sel-half':''}" onclick="setCount('${esc(it.name)}','shelf',0.5)">&frac12;</button>
            <button class="${s===1?'sel-full':''}" onclick="setCount('${esc(it.name)}','shelf',1)">1</button>
          </div>
        </div>
        <div class="mini-stepper-group">
          <span class="lbl">Cooler</span>
          <div class="stepper mini">
            <button onclick="stepCount('${esc(it.name)}','cooler',-0.25)">&minus;</button>
            <input type="number" inputmode="decimal" step="0.25" value="${e.cooler ?? ''}" placeholder="0"
                   onchange="setCount('${esc(it.name)}','cooler',this.value)">
            <button onclick="stepCount('${esc(it.name)}','cooler',0.25)">+</button>
          </div>
        </div>`;
    } else {
      // Meat and fish are counted in half units — half a box, half a case.
      ctl = `
        <div class="stepper">
          <button onclick="stepCount('${esc(it.name)}','qty',-0.5)">&minus;</button>
          <input type="number" inputmode="decimal" step="0.5" value="${e.qty ?? ''}" placeholder="0"
                 onchange="setCount('${esc(it.name)}','qty',this.value)">
          <button onclick="stepCount('${esc(it.name)}','qty',0.5)">+</button>
        </div>`;
    }
    ctl += `<span class="order-badge">${order !== null ? (order > 0 ? 'ORDER ' + fmt(order) : 'OK') : ''}</span>`;
    return ctl;
}

function rowEl(name){
  return [...document.querySelectorAll('#listView .row')].find(r => r.dataset.name === name);
}

function refreshRow(name){
  const it = items.find(i => i.name === name);
  const row = rowEl(name);
  if (!it || !row) return;
  const order = computeOrder(it);
  row.classList.toggle('hasorder', !!(order && order > 0));
  row.querySelector('.row-ctl').innerHTML = controlsHtml(it);
}

function refreshProgress(){
  const total = visibleItems.length;
  const counted = visibleItems.filter(isDone).length;
  $('progresslabel').textContent = `${counted} of ${total} counted`;
  $('progressbar').style.width = total ? `${(counted / total * 100).toFixed(0)}%` : '0%';
  $('reviewBtn').textContent = `Review Orders (${counted}/${total})`;
}

function ensureCount(name){
  if (!counts[name]) counts[name] = { shelf: null, cooler: null, qty: null };
  return counts[name];
}

async function setCount(name, field, val){
  const c = ensureCount(name);
  c[field] = (val === '' || val === null) ? null : Number(val);
  refreshRow(name); refreshProgress();
  await write('PUT', '/count', { item_name: name, shelf: c.shelf, cooler: c.cooler, qty: c.qty });
}

async function stepCount(name, field, delta){
  const c = ensureCount(name);
  const cur = Number(c[field] || 0);
  const next = Math.max(cur + delta, 0);
  c[field] = Math.round(next * 4) / 4;
  refreshRow(name); refreshProgress();
  await write('PUT', '/count', { item_name: name, shelf: c.shelf, cooler: c.cooler, qty: c.qty });
}

function handleResetTap(){
  const btn = $('resetBtn');
  if (!resetArmed){
    resetArmed = true;
    btn.textContent = 'Tap to confirm';
    btn.style.background = 'var(--accent)';
    btn.style.color = '#fff';
    clearTimeout(resetArmTimer);
    resetArmTimer = setTimeout(()=>{
      resetArmed = false; btn.textContent = 'Reset';
      btn.style.background = ''; btn.style.color = '';
    }, 4000);
  } else {
    clearTimeout(resetArmTimer);
    resetArmed = false;
    btn.textContent = 'Reset'; btn.style.background = ''; btn.style.color = '';
    counts = {}; roundChoices = {};
    renderList();
    write('DELETE', '/counts');
  }
}

// ---- views ----
function hideAll(){
  ['listView','summaryView','settingsHub','routeView','parView','seasonalView','vendorView',
   'orderNameView','addItemView','historyView']
    .forEach(id => $(id).style.display = 'none');
  document.querySelector('header').style.display = 'none';
}
function showList(){
  hideAll();
  $('listView').style.display = '';
  document.querySelector('header').style.display = '';
  $('footerBar').style.display = 'flex';
  renderList();
}
function showSettingsHub(){
  hideAll();
  $('settingsHub').style.display = 'block';
  $('footerBar').style.display = 'none';
  const unassigned = items.filter(i => !i.vendor).length;
  const off = items.filter(i => !i.active).length;
  const placed = new Set(); routes.forEach(g => (g.item_names||[]).forEach(n => placed.add(n)));
  const notRouted = items.length - placed.size;
  $('vendorHubCount').textContent = unassigned ? `${unassigned} unassigned` : 'all set';
  $('seasonalHubCount').textContent = `${off} off`;
  $('parHubCount').textContent = `${items.length} items`;
  const renamed = items.filter(i => orderName(i) !== i.name).length;
  $('orderNameHubCount').textContent = renamed ? `${renamed} renamed` : 'same as shelf';
  $('addItemHubCount').textContent = `${items.length} in ${dept}`;
  $('routeHubCount').textContent = routes.length ? (notRouted ? `${notRouted} not placed` : 'all set') : 'not set up';
}

// ---- order summary ----
function showSummary(){
  hideAll();
  $('summaryView').style.display = 'block';
  $('footerBar').style.display = 'none';

  const byVendor = {};
  items.forEach(it => {
    if (!it.active) return;
    const raw = computeOrder(it);
    if (!raw || raw <= 0) return;
    const v = it.vendor || 'UNASSIGNED VENDOR';
    (byVendor[v] = byVendor[v] || []).push({ ...it, rawQty: raw });
  });

  const dayLabel = DAY_NAMES[day];
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  // Copied tickets use a plain numeric date: "8/20".
  const sendDate = now.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' });
  $('summaryDate').textContent = `${dayLabel} \u00b7 ${dateStr}`;

  const wrap = $('ticketsWrap');
  const names = Object.keys(byVendor).sort();
  if (!names.length){
    // An empty ticket list has three very different causes. Say which one.
    const active = items.filter(it => it.active);
    const anyPar = active.some(it =>
      Object.values(it.pars || {}).some(v => Number(v) > 0));
    let msg;
    if (!active.length){
      msg = 'No items in this department yet.';
    } else if (!anyPar){
      msg = 'No PARs set for this department yet.<br>' +
            'Set them under Settings \u2192 PARs and the order builds itself as you count.';
    } else {
      msg = 'No items need ordering yet.<br>Go back and finish counting.';
    }
    wrap.innerHTML = `<div class="emptystate">${msg}</div>`;
    return;
  }
  wrap.innerHTML = '';
  names.forEach((v, idx) => {
    const list = byVendor[v].map(it => ({ ...it, orderQty: effQty(it.name, it.rawQty) }));
    const ticket = document.createElement('div');
    ticket.className = 'ticket';
    ticket.innerHTML = `
      <div class="notch left"></div><div class="notch right"></div>
      <div class="ticket-head">
        <span class="vname">${htmlEsc(v)}</span>
        <span class="vcount">${list.length} item${list.length===1?'':'s'}</span>
      </div>
      <div class="ticket-body">
        ${list.map(it => {
          const frac = Math.abs(it.rawQty % 1) > 0.001;
          const ch = roundChoices[it.name];
          return `<div class="tline">
            <span class="tname">${htmlEsc(orderName(it))}${
              orderName(it) !== it.name ? `<span class="tsell">${htmlEsc(it.name)}</span>` : ''
            }${it.note?`<span class="tnote">${htmlEsc(it.note)}</span>`:''}</span>
            <span style="text-align:right;">
              <span class="tqty">${fmt(it.orderQty)}</span>
              ${frac ? `<div style="display:flex;gap:4px;justify-content:flex-end;margin-top:3px;">
                <button class="roundbtn ${ch==='down'?'sel':''}" onclick="setRound('${esc(it.name)}','down')">&darr; ${Math.floor(it.rawQty)}</button>
                <button class="roundbtn ${(!ch||ch==='exact')?'exact-sel':''}" onclick="setRound('${esc(it.name)}','exact')">${fmt(it.rawQty)}</button>
                <button class="roundbtn ${ch==='up'?'sel':''}" onclick="setRound('${esc(it.name)}','up')">&uarr; ${Math.ceil(it.rawQty)}</button>
              </div>` : ''}
            </span>
          </div>`;
        }).join('')}
      </div>
      <div class="ticket-foot">
        <button class="copybtn" onclick="copyTicket(${idx}, this)">Copy text for ${htmlEsc(v)}</button>
      </div>`;
    ticket.dataset.text = buildText(list, sendDate);
    ticket.dataset.vendor = v;
    ticket.dataset.dayLabel = dayLabel;
    ticket.dataset.items = JSON.stringify(list.map(it => ({ name: it.name, qty: it.orderQty, note: it.note || null })));
    wrap.appendChild(ticket);
  });
}
function effQty(name, raw){
  const c = roundChoices[name];
  if (c === 'up') return Math.ceil(raw);
  if (c === 'down') return Math.floor(raw);
  return raw;
}
function setRound(name, mode){ roundChoices[name] = mode; showSummary(); }
// The message a vendor actually receives. Each ticket already goes to one vendor,
// so naming them back to themselves adds nothing; keep it to the date and the
// lines they have to read. A note only appears when the buyer typed one.
function buildText(list, dateStr){
  const lines = [`Dat Moi Order - ${dateStr}`, ''];
  list.forEach(it => {
    let l = `${orderName(it)}: ${fmt(it.orderQty)}`;
    if (it.note) l += ` - ${it.note}`;
    lines.push(l);
  });
  return lines.join('\n');
}
async function copyTicket(idx, btn){
  const t = document.querySelectorAll('.ticket')[idx];
  const ok = await copyText(t.dataset.text);
  if (ok){
    btn.textContent = 'Copied \u2713'; btn.classList.add('copied');
    setTimeout(()=>{ btn.textContent = `Copy text for ${t.dataset.vendor}`; btn.classList.remove('copied'); }, 1800);
  } else {
    showCopyFallback(t.dataset.text);
  }
  write('POST', '/order', {
    vendor: t.dataset.vendor,
    day_label: t.dataset.dayLabel,
    items: JSON.parse(t.dataset.items)
  });
}
async function copyText(text){
  try{ if (navigator.clipboard?.writeText){ await navigator.clipboard.writeText(text); return true; } }catch(e){}
  try{
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position='fixed'; ta.style.left='-9999px';
    document.body.appendChild(ta); ta.focus(); ta.select();
    const ok = document.execCommand('copy'); document.body.removeChild(ta);
    return ok;
  }catch(e){ return false; }
}
function showCopyFallback(text){
  const m = document.createElement('div');
  m.className = 'copy-fallback-modal';
  m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:100;display:flex;align-items:center;justify-content:center;padding:20px;';
  m.innerHTML = `<div style="background:var(--card);border-radius:12px;padding:16px;max-width:420px;width:100%;max-height:80vh;display:flex;flex-direction:column;gap:10px;">
    <div style="font-family:var(--serif);font-size:16px;">Select the text below to copy</div>
    <textarea readonly style="min-height:220px;font-family:var(--mono);font-size:12.5px;border:1px solid var(--line);border-radius:8px;padding:10px;background:var(--paper);color:var(--ink);">${htmlEsc(text)}</textarea>
    <button style="border:none;background:var(--ink);color:var(--paper);padding:12px;border-radius:9px;font-weight:700;" onclick="document.querySelector('.copy-fallback-modal').remove()">Close</button>
  </div>`;
  document.body.appendChild(m);
  const ta = m.querySelector('textarea'); ta.focus(); ta.select();
}

// ---- vendors ----
function showVendorSettings(){
  hideAll(); $('vendorView').style.display = 'block'; $('footerBar').style.display = 'none';
  renderVendors();
}
function renderVendors(){
  const wrap = $('vendorWrap');
  const unassigned = items.filter(i => !i.vendor).length;
  // group by current vendor so bulk reassignment is a few taps, not one per item
  const groups = {};
  items.forEach(i => { (groups[i.vendor || 'NO VENDOR'] = groups[i.vendor || 'NO VENDOR'] || []).push(i); });

  wrap.innerHTML = `
    <div class="vsummarybar">
      <div class="vs-title">Vendors</div>
      <div class="vs-sub">${unassigned} item${unassigned===1?'':'s'} need a vendor</div>
    </div>
    <div style="display:flex;gap:8px;margin-bottom:14px;">
      <input type="text" id="newVendor" class="textinput" placeholder="Add a vendor...">
      <button class="addbtn" onclick="addVendor()">Add</button>
    </div>`;

  Object.keys(groups).sort().forEach(gname => {
    const list = groups[gname].sort((a,b)=>a.name.localeCompare(b.name));
    const div = document.createElement('div');
    div.className = 'vgroup' + (gname === 'NO VENDOR' ? ' needsattn' : '');
    div.innerHTML = `
      <div class="vgroup-head">
        <div class="oldname">${htmlEsc(gname)} <span class="chip">${list.length}</span></div>
        <select class="bulk" onchange="bulkVendor(${JSON.stringify(list.map(i=>i.name)).replace(/"/g,'&quot;')}, this.value); this.value='';">
          <option value="">move all to...</option>
          ${vendors.map(v=>`<option value="${htmlEsc(v)}">${htmlEsc(v)}</option>`).join('')}
        </select>
      </div>
      ${list.map(i => `<div class="vitem">
        <span class="viname">${htmlEsc(i.name)}</span>
        <select class="single ${i.vendor?'':'unassigned'}" onchange="setVendor('${esc(i.name)}', this.value)">
          <option value="">&mdash; none &mdash;</option>
          ${vendors.map(v=>`<option value="${htmlEsc(v)}" ${v===i.vendor?'selected':''}>${htmlEsc(v)}</option>`).join('')}
        </select>
      </div>`).join('')}`;
    wrap.appendChild(div);
  });
}
async function setVendor(name, v){
  const it = items.find(i => i.name === name);
  if (it) it.vendor = v || null;
  await write('PUT', '/item', { name, vendor: v || null });
  renderVendors();
}
async function bulkVendor(names, v){
  if (!v) return;
  names.forEach(n => { const it = items.find(i => i.name === n); if (it) it.vendor = v; });
  await write('PUT', '/items/bulk-vendor', { names, vendor: v });
  renderVendors();
}
async function addVendor(){
  const el = $('newVendor');
  const name = el.value.trim().toUpperCase();
  if (!name || vendors.includes(name)) return;
  vendors.push(name); vendors.sort();
  await write('POST', '/vendor', { name });
  renderVendors();
}

// ---- PARs ----
function showParSettings(){
  hideAll(); $('parView').style.display = 'block'; $('footerBar').style.display = 'none';
  renderPars();
}
function renderPars(){
  const wrap = $('parWrap');
  wrap.innerHTML = `<div class="vsummarybar"><div class="vs-title">PARs</div>
    <div class="vs-sub">${dept === 'produce' ? 'Shelf target + cooler PAR per day' : 'Target quantity per day'}</div></div>`;
  [...items].sort((a,b)=>a.name.localeCompare(b.name)).forEach(it => {
    const div = document.createElement('div');
    div.className = 'vgroup';
    let rows = '';
    if (it.mode === 'shelf_cooler'){
      rows += `<div class="vitem"><span class="viname">Shelf target (full)</span>
        <input type="number" step="0.25" class="numinput" value="${shelfTargetFor(it)}"
          onchange="setShelfTarget('${esc(it.name)}', this.value)"></div>`;
    }
    DAY_DEFS[dept].forEach(d => {
      rows += `<div class="vitem"><span class="viname">${d.label}</span>
        <input type="number" step="0.25" class="numinput" value="${parFor(it, d.key)}"
          onchange="setPar('${esc(it.name)}','${d.key}', this.value)"></div>`;
    });
    div.innerHTML = `<div class="vgroup-head" style="cursor:default;">
      <div class="oldname">${htmlEsc(it.name)}</div></div>${rows}`;
    wrap.appendChild(div);
  });
}
async function setPar(name, dayKey, val){
  const it = items.find(i => i.name === name);
  if (!it) return;
  it.pars = { ...(it.pars || {}), [dayKey]: val === '' ? 0 : Number(val) };
  await write('PUT', '/item', { name, pars: it.pars });
}
async function setShelfTarget(name, val){
  const it = items.find(i => i.name === name);
  if (!it) return;
  it.shelf_target = val === '' ? 0 : Number(val);
  await write('PUT', '/item', { name, shelf_target: it.shelf_target });
}

// ---- seasonal / active ----
function showSeasonalSettings(){
  hideAll(); $('seasonalView').style.display = 'block'; $('footerBar').style.display = 'none';
  renderSeasonal();
}
function renderSeasonal(){
  const wrap = $('seasonalWrap');
  const on = items.filter(i => i.active).sort((a,b)=>a.name.localeCompare(b.name));
  const off = items.filter(i => !i.active).sort((a,b)=>a.name.localeCompare(b.name));
  wrap.innerHTML = `<div class="vsummarybar"><div class="vs-title">Seasonal / Active</div>
    <div class="vs-sub">${off.length} item${off.length===1?'':'s'} hidden from counting</div></div>
    <div class="sectionlabel">Currently off</div><div id="seasOff"></div>
    <div class="sectionlabel">Currently on</div><div id="seasOn"></div>`;
  const offWrap = $('seasOff');
  if (!off.length) offWrap.innerHTML = '<div class="vitem" style="border-top:none;color:var(--ink-soft);">Nothing turned off.</div>';
  off.forEach(i => {
    const r = document.createElement('div'); r.className = 'vitem';
    r.innerHTML = `<span class="viname">${htmlEsc(i.name)}</span>
      <button class="bulk" style="border-color:var(--good);background:var(--good-soft);color:var(--good);"
        onclick="setActive('${esc(i.name)}', true)">TURN ON</button>`;
    offWrap.appendChild(r);
  });
  const onWrap = $('seasOn');
  on.forEach(i => {
    const r = document.createElement('div'); r.className = 'vitem';
    r.innerHTML = `<span class="viname">${htmlEsc(i.name)}</span>
      <button class="bulk" onclick="setActive('${esc(i.name)}', false)">TURN OFF</button>`;
    onWrap.appendChild(r);
  });
}
async function setActive(name, val){
  const it = items.find(i => i.name === name);
  if (it) it.active = val;
  await write('PUT', '/item', { name, active: val });
  renderSeasonal();
}

// ---- order names (what the vendor calls it) ----
function showOrderNameSettings(){
  hideAll(); $('orderNameView').style.display = 'block'; $('footerBar').style.display = 'none';
  renderOrderNames();
}
function renderOrderNames(){
  const wrap = $('orderNameWrap');
  wrap.innerHTML = `
    <div class="vsummarybar">
      <div class="vs-title">Order Names</div>
      <div class="vs-sub">${items.filter(i => orderName(i) !== i.name).length} of ${items.length} differ from the shelf name</div>
    </div>
    <div class="hint">The bold name is what you sell it as. The box below it is what
    the vendor calls it, and that is the name that goes out on the order. Leave a box
    empty to send the shelf name.</div>`;
  [...items].sort((a,b)=>a.name.localeCompare(b.name)).forEach(it => {
    const div = document.createElement('div');
    div.className = 'vgroup';
    div.innerHTML = `
      <div class="vgroup-head" style="cursor:default;">
        <div class="oldname">${htmlEsc(it.name)}</div>
      </div>
      <div class="vitem">
        <input type="text" class="textinput" value="${htmlEsc(it.invdesc || '')}"
          placeholder="${htmlEsc(it.name)}"
          onchange="setOrderName('${esc(it.name)}', this.value)">
      </div>`;
    wrap.appendChild(div);
  });
}
async function setOrderName(name, val){
  const it = items.find(i => i.name === name);
  if (!it) return;
  it.invdesc = val.trim();
  await write('PUT', '/item', { name, invdesc: it.invdesc });
  const sub = document.querySelector('#orderNameWrap .vs-sub');
  if (sub) sub.textContent =
    `${items.filter(i => orderName(i) !== i.name).length} of ${items.length} differ from the shelf name`;
}

// ---- adding an item ----
function showAddItem(){
  hideAll(); $('addItemView').style.display = 'block'; $('footerBar').style.display = 'none';
  renderAddItem();
}
function renderAddItem(){
  $('addItemWrap').innerHTML = `
    <div class="vsummarybar">
      <div class="vs-title">Add an Item</div>
      <div class="vs-sub">${items.length} in ${dept} right now</div>
    </div>
    <div class="hint">Adds one item to <b>${htmlEsc(dept)}</b>. It starts with every PAR
    at 0, so it will not appear on an order until you set one under PARs.</div>
    <div class="vgroup">
      <div class="vgroup-head" style="cursor:default;"><div class="oldname">Name on the shelf</div></div>
      <div class="vitem"><input type="text" class="textinput" id="newItemName" placeholder="e.g. RAU RAM"></div>
      <div class="vgroup-head" style="cursor:default;"><div class="oldname">Name the vendor uses</div></div>
      <div class="vitem"><input type="text" class="textinput" id="newItemOrderName" placeholder="leave blank to use the shelf name"></div>
      <div class="vgroup-head" style="cursor:default;"><div class="oldname">Vendor</div></div>
      <div class="vitem">
        <select class="single" id="newItemVendor">
          <option value="">&mdash; none &mdash;</option>
          ${vendors.map(v=>`<option value="${htmlEsc(v)}">${htmlEsc(v)}</option>`).join('')}
        </select>
      </div>
    </div>
    <button class="addbtn" style="width:100%;" onclick="addItem()">Add to ${htmlEsc(dept)}</button>
    <div class="hint" id="addItemMsg" style="padding-top:12px;"></div>`;
}
async function addItem(){
  const name = $('newItemName').value.trim();
  const msg = $('addItemMsg');
  if (!name){ msg.textContent = 'Give the item a name first.'; return; }
  const r = await write('POST', '/item', {
    name,
    invdesc: $('newItemOrderName').value.trim(),
    vendor: $('newItemVendor').value || null
  });
  if (!r){ msg.textContent = `Could not add "${name}". It may already be in ${dept}.`; return; }
  await bootstrap();          // pick up the new row, and the vendor if it was new
  renderAddItem();
  $('addItemMsg').textContent = `Added "${name}". Set its PARs when you are ready.`;
}

// ---- routine / route ----
function showRouteSettings(){
  hideAll(); $('routeView').style.display = 'block'; $('footerBar').style.display = 'none';
  renderRoutes();
}
function renderRoutes(){
  const wrap = $('routeWrap');
  const placed = new Set(); routes.forEach(g => (g.item_names||[]).forEach(n => placed.add(n)));
  const unplaced = items.filter(i => !placed.has(i.name)).sort((a,b)=>a.name.localeCompare(b.name));
  wrap.innerHTML = `<div class="vsummarybar"><div class="vs-title">My Routine</div>
    <div class="vs-sub">${unplaced.length} item${unplaced.length===1?'':'s'} not placed yet</div></div>
    <div style="display:flex;gap:8px;margin-bottom:14px;">
      <input type="text" id="newGroup" class="textinput" placeholder="e.g. Front tables, Wall cooler...">
      <button class="addbtn" onclick="addGroup()">Add</button>
    </div>`;
  routes.forEach((g, gi) => {
    const div = document.createElement('div'); div.className = 'vgroup';
    div.innerHTML = `
      <div class="vgroup-head">
        <div class="oldname">${gi+1}. ${htmlEsc(g.name)} <span class="chip">${(g.item_names||[]).length}</span></div>
        <span style="display:flex;gap:4px;">
          <button class="bulk" onclick="moveGroup(${gi},-1)" ${gi===0?'disabled':''}>&uarr;</button>
          <button class="bulk" onclick="moveGroup(${gi},1)" ${gi===routes.length-1?'disabled':''}>&darr;</button>
          <button class="bulk" id="delg-${gi}" style="border-color:var(--accent);background:var(--accent-soft);color:#8a4413;" onclick="delGroup(${gi})">delete</button>
        </span>
      </div>
      ${(g.item_names||[]).map((n, ii) => `<div class="vitem">
        <span class="viname">${ii+1}. ${htmlEsc(n)}</span>
        <span style="display:flex;gap:4px;">
          <button class="bulk" onclick="moveItem(${gi},${ii},-1)" ${ii===0?'disabled':''}>&uarr;</button>
          <button class="bulk" onclick="moveItem(${gi},${ii},1)" ${ii===(g.item_names.length-1)?'disabled':''}>&darr;</button>
          <button class="bulk" onclick="removeItem(${gi},${ii})">&times;</button>
        </span></div>`).join('')}
      <div class="vitem">
        <select class="single" style="width:100%;max-width:none;" onchange="addToGroup(${gi}, this.value); this.value='';">
          <option value="">+ add item to this section...</option>
          ${unplaced.map(i=>`<option value="${htmlEsc(i.name)}">${htmlEsc(i.name)}</option>`).join('')}
        </select>
      </div>`;
    wrap.appendChild(div);
  });
  if (unplaced.length){
    const d = document.createElement('div'); d.className = 'vgroup needsattn';
    d.innerHTML = `<div class="vgroup-head" style="cursor:default;">
      <div class="oldname">Not placed yet<span class="flag">${unplaced.length}</span></div></div>
      ${unplaced.map(i=>`<div class="vitem"><span class="viname">${htmlEsc(i.name)}</span></div>`).join('')}`;
    wrap.appendChild(d);
  }
}
async function saveRoutes(){
  await write('PUT', '/routes', { groups: routes.map(g => ({ name: g.name, items: g.item_names || [] })) });
}
async function addGroup(){
  const el = $('newGroup'); const name = el.value.trim();
  if (!name) return;
  routes.push({ name, item_names: [] });
  await saveRoutes(); renderRoutes();
}
async function delGroup(gi){
  const btn = $(`delg-${gi}`);
  if (armedDeleteGroup !== gi){
    armedDeleteGroup = gi;
    if (btn) btn.textContent = 'tap to confirm';
    clearTimeout(armedDeleteTimer);
    armedDeleteTimer = setTimeout(()=>{ armedDeleteGroup = null; if (btn) btn.textContent = 'delete'; }, 4000);
    return;
  }
  clearTimeout(armedDeleteTimer); armedDeleteGroup = null;
  routes.splice(gi, 1);
  await saveRoutes(); renderRoutes();
}
async function moveGroup(gi, dir){
  const t = gi + dir; if (t < 0 || t >= routes.length) return;
  [routes[gi], routes[t]] = [routes[t], routes[gi]];
  await saveRoutes(); renderRoutes();
}
async function moveItem(gi, ii, dir){
  const list = routes[gi].item_names; const t = ii + dir;
  if (t < 0 || t >= list.length) return;
  [list[ii], list[t]] = [list[t], list[ii]];
  await saveRoutes(); renderRoutes();
}
async function removeItem(gi, ii){
  routes[gi].item_names.splice(ii, 1);
  await saveRoutes(); renderRoutes();
}
async function addToGroup(gi, name){
  if (!name) return;
  routes.forEach(g => { g.item_names = (g.item_names||[]).filter(n => n !== name); });
  routes[gi].item_names.push(name);
  await saveRoutes(); renderRoutes();
}

// ---- history ----
async function showHistory(){
  hideAll(); $('historyView').style.display = 'block'; $('footerBar').style.display = 'none';
  const wrap = $('historyWrap');
  wrap.innerHTML = '<div class="emptystate">Loading...</div>';
  const data = await api('GET', '/orders');
  const orders = data?.orders || [];
  if (!orders.length){
    wrap.innerHTML = '<div class="emptystate">No orders logged yet.</div>';
    return;
  }
  const byDate = {};
  orders.forEach(o => {
    const k = `${o.order_date}__${o.day_label || ''}`;
    (byDate[k] = byDate[k] || []).push(o);
  });
  wrap.innerHTML = `<div class="vsummarybar"><div class="vs-title">Order History</div>
    <div class="vs-sub">${orders.length} vendor order${orders.length===1?'':'s'}</div></div>`;
  Object.keys(byDate).sort().reverse().forEach(k => {
    const [d, label] = k.split('__');
    const div = document.createElement('div'); div.className = 'vgroup';
    const dateLabel = new Date(d + 'T00:00:00').toLocaleDateString('en-US',
      { weekday:'short', month:'short', day:'numeric' });
    div.innerHTML = `<div class="vgroup-head" style="cursor:default;">
      <div class="oldname">${dateLabel}${label ? ' \u00b7 ' + htmlEsc(label) : ''}</div></div>`;
    byDate[k].forEach(o => {
      const s = document.createElement('div');
      s.className = 'vitem'; s.style.display = 'block';
      s.innerHTML = `<div style="font-weight:700;margin-bottom:4px;">${htmlEsc(o.vendor)}
        <span class="chip">${(o.items||[]).length} item${(o.items||[]).length===1?'':'s'}</span></div>
        <div style="font-family:var(--mono);font-size:11.5px;color:var(--ink-soft);line-height:1.6;">
        ${(o.items||[]).map(i=>`${htmlEsc(i.name)}: ${fmt(i.qty)}`).join('<br>')}</div>`;
      div.appendChild(s);
    });
    wrap.appendChild(div);
  });
}

switchDept(dept);
