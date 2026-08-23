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
let me = null;           // the signed-in employee
let authNames = [], authPick = null, authPin = '', authMode = 'who';
let resetArmed = false, resetArmTimer = null;
let armedDeleteGroup = null, armedDeleteTimer = null;
// Produce is counted in two laps of the building: the shelves, then the back
// room. They are not laid out the same way, so each lap has its own order and
// each shows only the control that lap is for.
let pass = 'shelf';
// While building an order you are walking a route the list does not know yet, so
// you search for each item as you reach it. Hiding what is already done shrinks
// 174 rows towards nothing as you go, which is the difference between hunting
// and finishing.
let hideDone = false;
function toggleHideDone(){ hideDone = !hideDone; renderList(); }
let walk = {};                 // the saved order for each lap
let walked = [];               // the order this lap is being done in, as it happens
const TWO_PASS = () => dept === 'produce';
function setPass(p){
  pass = p; walked = [];
  window.scrollTo(0, 0);
  renderList();
}

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
      if (res.status === 401 || res.status === 403){
        const body = await res.json().catch(() => ({}));
        if (res.status === 401) { me = null; showAuth(); }
        else if (body.must_change_pin) { showAuth('change'); }
        else if (body.read_only) { setSync('bad', body.error); }
        const err = new Error(body.error || 'HTTP ' + res.status);
        err.status = res.status;
        throw err;
      }
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

// Everyone can look. Changing something needs the area granted. The server is
// the authority — this only decides which controls are worth showing.
function canEdit(area){
  if (!me) return false;
  if (me.role === 'manager') return true;
  return (me.areas || []).includes(area || dept);
}

function parFor(it, d){ return (it.pars && it.pars[d] !== undefined) ? Number(it.pars[d]) : 0; }
function shelfTargetFor(it){ return it.shelf_target === null || it.shelf_target === undefined ? 1 : Number(it.shelf_target); }

function computeOrder(it){
  const e = counts[it.name];
  if (!e) return null;
  if (it.mode === 'shelf_cooler'){
    const s = (e.shelf === null || e.shelf === undefined) ? null : Number(e.shelf);
    const c = (e.cooler === null || e.cooler === undefined) ? null : Number(e.cooler);
    if (s === null && c === null) return null;
    // What we want to have, less what we have anywhere. The two gaps used to be
    // added, which meant a case sitting in the back could never cancel a
    // half-empty shelf: the other buyer picks something up, has not put it out
    // yet, and the app still says order more. A quarter-full shelf needs three
    // quarters to fill it, and nobody orders three quarters of a box, so the
    // answer is rounded up once at the end.
    const want = shelfTargetFor(it) + parFor(it, day);
    const have = (s || 0) + (c || 0);
    return Math.ceil(Math.max(want - have, 0));
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
  let active = items.filter(i => i.active);
  if (TWO_PASS()){
    // The back lap shows everything, including items with no par today. Stock
    // that somebody bought and has not put out yet is exactly what stops you
    // buying again, and an item filtered out for having no par is an item whose
    // back stock you never see.
    const saved = walk[pass];
    if (saved && saved.length){
      const byName = {}; active.forEach(i => byName[i.name] = i);
      const out = [];
      saved.forEach(n => { if (byName[n]){ out.push({ item: byName[n], group: null }); delete byName[n]; } });
      Object.values(byName).forEach(i => out.push({ item: i, group: 'Not on the walk yet' }));
      return out;
    }
    return active.map(i => ({ item: i, group: null }));
  }
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
  $('warehouseView').style.display = 'none';
  dept = d;
  localStorage.setItem('dm_dept', d);
  document.body.dataset.dept = d;
  document.querySelectorAll('#deptBar button').forEach(b =>
    b.classList.toggle('active', b.dataset.dept === d));
  $('deptEyebrow').textContent = `DAT MOI \u00b7 ${d.toUpperCase()}`;
  $('deptTitle').textContent = DEPT_TITLES[d];
  roundChoices = {};
  await bootstrap();
  applyAccess();
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
  walk = data.walk || {};
  walked = [];
  pass = 'shelf';
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
  if (!canEdit()) return;
  day = d;
  renderDayToggle();
  renderList();
  await write('PUT', '/day', { day: d });
}

// ---- counting list ----
function passBarHtml(){
  if (!TWO_PASS()) return '';
  const active = items.filter(i => i.active);
  const doneS = active.filter(i => counts[i.name]?.shelf != null).length;
  // Most things have nothing out the back, and nobody should have to tap a zero
  // onto a hundred and fifty of them. Untouched already means none, so the back
  // lap counts what was found rather than how much of the list has been visited.
  const foundB = active.filter(i => Number(counts[i.name]?.cooler) > 0).length;
  return `<div class="passbar">
      <button class="${pass === 'shelf' ? 'on' : ''}" onclick="setPass('shelf')">
        Shelves <span>${doneS}/${active.length}</span></button>
      <button class="${pass === 'back' ? 'on' : ''}" onclick="setPass('back')">
        Back <span>${foundB} found</span></button>
    </div>`;
}

// Offered once a lap is far enough along to be worth keeping, and only when the
// order actually differs from the one already saved.
// Updated on its own rather than by re-rendering: the list must not move under
// a thumb mid-count, which is the bug that made counting produce miserable once
// already.
function refreshWalkOffer(){
  const el = $('walkOffer');
  if (el) el.innerHTML = walkOfferHtml();
}
function refreshPassBar(){
  const el = $('passBar');
  if (el) el.innerHTML = passBarHtml();
}

// The first lap of a pass has no order to follow, so it is done by search: walk
// the route, type two or three letters, tap. The order writes itself out of that,
// and from the next lap on the list is already in the right order.
function lapToolsHtml(){
  const known = (walk[pass] || []).length > 0;
  const total = items.filter(i => i.active).length;
  return `<div class="laptools">
      <label class="hidedone">
        <input type="checkbox" ${hideDone ? 'checked' : ''} onchange="toggleHideDone()">
        Hide what I have done
      </label>
      ${known ? '' : `<div class="lapnote">No ${pass === 'shelf' ? 'shelf' : 'back room'} order saved yet.
        Walk your route and search for each item as you reach it &mdash; two or three letters is enough.
        The order writes itself, and next time these ${total} will already be in it.</div>`}
    </div>`;
}

function walkOfferHtml(){
  if (!TWO_PASS() || !canEdit() || walked.length < 8) return '';
  const saved = walk[pass] || [];
  const same = saved.length === walked.length && saved.every((n, i) => n === walked[i]);
  if (same) return '';
  return `<button class="walksave" onclick="saveWalk()">
      Save this as the ${pass === 'shelf' ? 'shelf' : 'back room'} order
      <span>so next time the list follows your feet</span></button>`;
}

async function saveWalk(){
  const names = walked.slice();
  const res = await write('PUT', '/walk-order', { pass, names });
  if (res === false) return;
  walk[pass] = names;
  renderList();
}

function renderList(){
  const q = $('search').value.trim().toLowerCase();
  const wrap = $('listView');
  wrap.innerHTML = '';
  wrap.insertAdjacentHTML('beforeend', `<div id="passBar">${passBarHtml()}</div>`);
  if (TWO_PASS() && canEdit()) wrap.insertAdjacentHTML('beforeend', lapToolsHtml());
  let total = 0, lastGroup;
  const shown = [];

  const laneDone = it => TWO_PASS() && pass === 'back'
    ? Number(counts[it.name]?.cooler) > 0
    : (counts[it.name] || {})[TWO_PASS() ? 'shelf' : 'qty'] != null;
  orderedItems().forEach(({ item: it, group }) => {
    if (q && !it.name.toLowerCase().includes(q) && !(it.invdesc || '').toLowerCase().includes(q)) return;
    if (hideDone && !q && laneDone(it)) return;
    total++;
    // A heading only where there is something to say. An unnamed group used to
    // print "Items" above the list, which named nothing.
    if (!q && group !== lastGroup){
      if (group){
        const l = document.createElement('div');
        l.className = 'sectionlabel';
        l.textContent = group;
        wrap.appendChild(l);
      }
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
  wrap.insertAdjacentHTML('beforeend', `<div id="walkOffer">${walkOfferHtml()}</div>`);

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
    if (!canEdit()){
      // Read-only: show what was counted, with nothing to press.
      const seen = it.mode === 'shelf_cooler'
        ? `${e.shelf ?? '\u2014'} shelf / ${e.cooler ?? '\u2014'} cooler`
        : `${e.qty ?? '\u2014'}`;
      return `<span class="rocount">${htmlEsc(seen)}</span>` +
        `<span class="order-badge">${order !== null ? (order > 0 ? 'ORDER ' + fmt(order) : 'OK') : ''}</span>`;
    }
    let ctl;
    if (it.mode === 'shelf_cooler'){
      const s = e.shelf;
      // One lap, one control. Showing both meant visiting every row twice and
      // hunting for it the second time, in an order that suited neither lap.
      const shelfCtl = `
        <div class="mini-stepper-group">
          <span class="lbl">Shelf</span>
          <div class="fetoggle">
            <button class="${s===0?'sel-empty':''}" onclick="setCount('${esc(it.name)}','shelf',0)">empty</button>
            <button class="${s===0.25?'sel-qtr':''}" onclick="setCount('${esc(it.name)}','shelf',0.25)">&frac14;</button>
            <button class="${s===0.5?'sel-half':''}" onclick="setCount('${esc(it.name)}','shelf',0.5)">&frac12;</button>
            <button class="${s===1?'sel-full':''}" onclick="setCount('${esc(it.name)}','shelf',1)">full</button>
          </div>
        </div>`;
      const backCtl = `
        <div class="mini-stepper-group">
          <span class="lbl">Back &middot; par ${fmt(parFor(it, day))}</span>
          <div class="stepper mini">
            <button onclick="stepCount('${esc(it.name)}','cooler',-1)">&minus;</button>
            <input type="number" inputmode="decimal" step="1" value="${e.cooler ?? ''}" placeholder="0"
                   onchange="setCount('${esc(it.name)}','cooler',this.value)">
            <button onclick="stepCount('${esc(it.name)}','cooler',1)">+</button>
          </div>
        </div>`;
      ctl = !TWO_PASS() ? shelfCtl + backCtl : (pass === 'shelf' ? shelfCtl : backCtl);
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
  // On a two-lap department this counts the lap you are on. Counting whole items
  // instead read "0 of 174" next to a pass bar saying 12/174, because nothing is
  // finished until both laps are, which is true and unhelpful.
  const done = it => TWO_PASS() && pass === 'shelf'
    ? (counts[it.name] || {}).shelf != null
    : isDone(it);
  const counted = visibleItems.filter(done).length;
  $('progresslabel').textContent = !TWO_PASS()
    ? `${counted} of ${total} counted`
    : pass === 'shelf'
      ? `${counted} of ${total} shelves`
      : `${visibleItems.filter(i => Number(counts[i.name]?.cooler) > 0).length} found in the back`;
  $('progressbar').style.width = total ? `${(counted / total * 100).toFixed(0)}%` : '0%';
  // The button is about the whole order, so it stays on whole items.
  const whole = visibleItems.filter(isDone).length;
  $('reviewBtn').textContent = `Review Orders (${whole}/${total})`;
}

function ensureCount(name){
  if (!counts[name]) counts[name] = { shelf: null, cooler: null, qty: null };
  return counts[name];
}

// The order things are being touched in, as they are touched. This is the whole
// answer to "I would have to scroll up and down for hours": the list is only
// wrong until somebody walks it once.
function noteWalked(name){
  if (!TWO_PASS()) return;
  if (!walked.includes(name)) walked.push(name);
}

async function setCount(name, field, val){
  noteWalked(name);
  const c = ensureCount(name);
  c[field] = (val === '' || val === null) ? null : Number(val);
  refreshRow(name); refreshProgress(); refreshWalkOffer(); refreshPassBar();
  await write('PUT', '/count', { item_name: name, shelf: c.shelf, cooler: c.cooler, qty: c.qty });
}

async function stepCount(name, field, delta){
  noteWalked(name);
  const c = ensureCount(name);
  const cur = Number(c[field] || 0);
  const next = Math.max(cur + delta, 0);
  c[field] = Math.round(next * 4) / 4;
  refreshRow(name); refreshProgress(); refreshWalkOffer(); refreshPassBar();
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
   'orderNameView','addItemView','backupView','employeesView','historyView','warehouseView']
    .forEach(id => $(id).style.display = 'none');
  document.querySelector('header').style.display = 'none';
}
function applyAccess(){
  const editable = canEdit();
  document.body.classList.toggle('viewonly', !editable);
  const reset = $('resetBtn');
  if (reset) reset.style.display = editable ? '' : 'none';
  const mark = $('viewOnlyMark');
  if (mark) mark.style.display = editable ? 'none' : '';
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
  $('backupHubCount').textContent = 'all departments';
  const editable = canEdit();
  ['routeHubRow','parHubRow','seasonalHubRow','vendorHubRow','orderNameHubRow','addItemHubRow']
    .forEach(id => { const el = $(id); if (el) el.style.display = editable ? '' : 'none'; });
  const note = $('settingsAccessNote');
  if (note){
    note.style.display = editable ? 'none' : '';
    note.textContent = `You can look at ${dept}, but changing it is not yours to do.`;
  }
  const isManager = me?.role === 'manager';
  $('employeesHubRow').style.display = isManager ? '' : 'none';
  $('backupHubRow').style.display = isManager ? '' : 'none';
  $('whoamiLine').innerHTML = me
    ? `Signed in as ${htmlEsc(me.name)} \u00b7 <button onclick="doLogout()" style="background:none;border:none;color:var(--ink-soft);text-decoration:underline;font-size:11px;padding:0;">sign out</button>`
    : '';
  $('routeHubCount').textContent = routes.length ? (notRouted ? `${notRouted} not placed` : 'all set') : 'not set up';
}

// Nothing here is live: every number came off this phone, and the only thing
// worth doing is typing a pickup. Say that rather than letting stale counts pass
// as current.
function goOffline(){
  document.body.classList.add('offline');
  const bar = document.createElement('div');
  bar.className = 'offbar';
  bar.innerHTML = `<b>No signal.</b> Showing what this phone last saw.
    A pickup you type is kept and saved when you are back in range.`;
  document.body.prepend(bar);
  if (me?.simple_mode) document.body.classList.add('simple');
  else whPicking = true;
  showWarehouse('warehouse').catch(() => {});
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
      ${canEdit() ? `<div class="ticket-foot">
        <button class="copybtn" onclick="copyTicket(${idx}, this)">Copy text for ${htmlEsc(v)}</button>
      </div>` : ''}`;
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

// ---- signing in ------------------------------------------------------------
// The whole app sits behind this. Everything under /api refuses without a
// session, so the screen below is the only thing a stranger with the URL sees.
// Most people use the same phone every day, so the name step only needs asking
// once per device. Signing out clears it — that is the deliberate hand-over.
const LAST_KEY = 'dm_last_employee';
function rememberDevice(emp){
  try { localStorage.setItem(LAST_KEY, JSON.stringify({ id: emp.id, name: emp.name })); } catch {}
}
// Signing out forgets the offline identity too, or the next person on this
// phone would inherit it when the signal drops.
function forgetDeviceAndMe(){ forgetDevice(); cacheMe(null); }
function forgetDevice(){ try { localStorage.removeItem(LAST_KEY); } catch {} }
function rememberedDevice(){
  try { return JSON.parse(localStorage.getItem(LAST_KEY) || 'null'); } catch { return null; }
}

// Who this phone last signed in as. Only ever used when the network is gone --
// the cookie is what actually authenticates, and the server checks it on every
// write, so this cannot let anybody in. It exists because somebody standing in
// the storage unit with a reloaded phone should still reach their pickup.
const ME_CACHE = 'dm_me';
function cacheMe(m){
  try { m ? localStorage.setItem(ME_CACHE, JSON.stringify(m)) : localStorage.removeItem(ME_CACHE); }
  catch {}
}
function cachedMe(){
  try { return JSON.parse(localStorage.getItem(ME_CACHE) || 'null'); } catch { return null; }
}

async function boot(){
  let offline = false;
  const r = await fetch('/api/auth/whoami').then(x => x.json())
    .catch(() => { offline = true; return null; });

  if (!r) {
    // Signed in here before and simply out of range: carry on with what the
    // phone remembers rather than showing a login nobody can complete. Anything
    // that reaches the server will still be checked properly when it does.
    const known = offline && cachedMe();
    // Straight to the warehouse, not through startApp: that loads a department
    // over the network, and its reply would land after this and take the screen
    // back to an empty Produce list.
    if (known) { me = known; authNames = []; $('authView').style.display = 'none'; return goOffline(); }
    showAuth('who');
    authError(offline
      ? 'No signal, and this phone has not been signed into yet.'
      : 'Cannot reach the app. Check your connection.');
    return;
  }
  authNames = r.names || [];
  me = r.employee;
  cacheMe(me);
  if (r.needs_setup) return showAuth('setup');
  if (me) return me.must_change_pin ? showAuth('change') : startApp();

  // Straight to the PIN pad for whoever used this phone last, as long as they
  // still have an account.
  const last = rememberedDevice();
  const still = last && authNames.find(n => n.id === last.id);
  if (still){ authPick = still; return showAuth('pin'); }
  forgetDevice();
  showAuth('who');
}

function startApp(){
  $('authView').style.display = 'none';
  // Simple mode is the whole app for whoever is in it: no tabs, no settings, no
  // other departments to get lost in.
  if (me?.simple_mode){
    document.body.classList.add('simple');
    showWarehouse('warehouse').catch(() => {});
    return;
  }
  document.body.classList.remove('simple');
  switchDept(dept);
}

function showAuth(mode){
  authMode = mode || authMode || 'who';
  authPin = '';
  hideAll();
  $('footerBar').style.display = 'none';
  $('authView').style.display = 'block';
  renderAuth();
}
function authError(msg){
  const el = $('authErr');
  el.textContent = msg || '';
  el.classList.toggle('on', !!msg);
}

function renderAuth(){
  const body = $('authBody');
  authError('');
  if (authMode === 'setup'){
    $('authTitle').textContent = 'Set up';
    body.innerHTML = `
      <div class="authsub">Nobody has an account yet. Make the first one — it will be
      a manager, so it can add everyone else and reset PINs.</div>
      <input type="text" class="textinput" id="setupName" placeholder="Your name" style="width:100%;margin-bottom:9px;">
      <input type="tel" inputmode="numeric" class="textinput" id="setupPin" placeholder="Choose a 6-digit PIN" maxlength="6" style="width:100%;margin-bottom:14px;">
      <button class="addbtn" style="width:100%;" onclick="doSetup()">Create manager account</button>`;
    return;
  }
  if (authMode === 'change'){
    $('authTitle').textContent = 'Choose a PIN';
    body.innerHTML = `
      <div class="authsub">${me ? htmlEsc(me.name) + ', this' : 'This'} PIN was set for you,
      so pick your own. Six digits, and not one anyone could guess from your phone number.</div>
      <input type="tel" inputmode="numeric" class="textinput" id="oldPin" placeholder="The PIN you just used" maxlength="6" style="width:100%;margin-bottom:9px;">
      <input type="tel" inputmode="numeric" class="textinput" id="newPin" placeholder="New 6-digit PIN" maxlength="6" style="width:100%;margin-bottom:9px;">
      <input type="tel" inputmode="numeric" class="textinput" id="newPin2" placeholder="Type it again" maxlength="6" style="width:100%;margin-bottom:14px;">
      <button class="addbtn" style="width:100%;" onclick="doChangePin()">Save my PIN</button>
      <div class="authlink"><button onclick="doLogout()">Sign in as someone else</button></div>`;
    return;
  }
  if (authMode === 'pin'){
    $('authTitle').textContent = authPick ? authPick.name : 'PIN';
    const dots = [0,1,2,3,4,5].map(i => `<div class="pindot ${i < authPin.length ? 'on' : ''}"></div>`).join('');
    body.innerHTML = `
      <div class="authsub">Enter your PIN.</div>
      <div class="pindots">${dots}</div>
      <div class="pinpad">
        ${[1,2,3,4,5,6,7,8,9].map(n => `<button onclick="pinTap('${n}')">${n}</button>`).join('')}
        <button class="wide" onclick="notMe()">Not you?</button>
        <button onclick="pinTap('0')">0</button>
        <button class="wide" onclick="pinTap('del')">Delete</button>
      </div>`;
    return;
  }
  $('authTitle').textContent = 'Who is counting?';
  body.innerHTML = authNames.length
    ? authNames.map(n => `<button class="whobtn" onclick="pickWho(${n.id})">${htmlEsc(n.name)}</button>`).join('')
    : '<div class="authsub">No accounts yet. Ask a manager to add you.</div>';
}

function notMe(){ forgetDevice(); authPick = null; showAuth('who'); }

function pickWho(id){
  authPick = authNames.find(n => n.id === id);
  authPin = '';
  showAuth('pin');
}

async function pinTap(key){
  if (key === 'del'){ authPin = authPin.slice(0, -1); return renderAuth(); }
  if (authPin.length >= 6) return;
  authPin += key;
  renderAuth();
  if (authPin.length >= 4) {
    // Try at 4 in case a manager set a short temporary PIN, then again at 6.
    if (authPin.length === 4 || authPin.length === 6) await tryLogin(authPin.length === 6);
  }
}

async function tryLogin(showErrors){
  const res = await fetch('/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ employee_id: authPick.id, pin: authPin })
  });
  const body = await res.json().catch(() => ({}));
  if (res.ok){
    me = body.employee;
    cacheMe(me);
    authPin = '';
    rememberDevice(me);
    if (me.must_change_pin) return showAuth('change');
    return startApp();
  }
  if (showErrors || res.status === 423 || res.status === 429){
    authError(body.error || 'That PIN is not right.');
    authPin = '';
    renderAuth();
    authError(body.error || 'That PIN is not right.');
  }
}

async function doSetup(){
  const name = $('setupName').value.trim(), pin = $('setupPin').value.trim();
  const res = await fetch('/api/auth/setup', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, pin })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return authError(body.error || 'Could not set that up.');
  me = body.employee;
  cacheMe(me);
  rememberDevice(me);
  startApp();
}

async function doChangePin(){
  const cur = $('oldPin').value.trim(), a = $('newPin').value.trim(), b = $('newPin2').value.trim();
  if (a !== b) return authError('Those two PINs are not the same.');
  const res = await fetch('/api/auth/change-pin', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ current_pin: cur, new_pin: a })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return authError(body.error || 'Could not change it.');
  me.must_change_pin = false;
  startApp();
}

async function doLogout(){
  await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
  forgetDeviceAndMe();
  me = null; authPick = null; authPin = '';
  const r = await fetch('/api/auth/whoami').then(x => x.json()).catch(() => ({ names: [] }));
  authNames = r.names || [];
  showAuth('who');
}

// ---- employees, for managers ----
async function showEmployees(){
  hideAll(); $('employeesView').style.display = 'block'; $('footerBar').style.display = 'none';
  $('employeesWrap').innerHTML = '<div class="hint">Loading...</div>';
  const r = await fetch('/api/employees').then(x => x.json()).catch(() => null);
  if (!r || r.error) { $('employeesWrap').innerHTML = `<div class="hint">${htmlEsc(r?.error || 'Could not load.')}</div>`; return; }
  whAreas = r.areas || ['produce','meat','fish','warehouse'];
  renderEmployees(r.employees);
}

function renderEmployees(list){
  const wrap = $('employeesWrap');
  const managers = list.filter(e => e.active && e.role === 'manager').length;
  wrap.innerHTML = `
    <div class="vsummarybar">
      <div class="vs-title">Employees</div>
      <div class="vs-sub">${list.filter(e=>e.active).length} active, ${managers} manager${managers===1?'':'s'}</div>
    </div>
    <div class="hint">A new person starts on the PIN you set here — the last four of
    their phone number is fine — and has to choose their own the first time they
    sign in. Reset does the same thing again, and clears a lockout.
    <br><br>Everyone signed in can look at everything. Ticking an area below lets
    that person <b>change</b> it — count, edit PARs, place orders, move warehouse
    stock. Managers can change everything without ticking anything.</div>
    <div class="vgroup">
      <div class="vgroup-head" style="cursor:default;"><div class="oldname">Add someone</div></div>
      <div class="vitem"><input type="text" class="textinput" id="newEmpName" placeholder="Name"></div>
      <div class="vitem"><input type="tel" inputmode="numeric" class="textinput" id="newEmpPin" placeholder="Temporary PIN (4-6 digits)" maxlength="6"></div>
      <div class="vitem"><span class="viname">Can manage people</span>
        <input type="checkbox" id="newEmpManager" style="width:22px;height:22px;"></div>
    </div>
    <button class="addbtn" style="width:100%;" onclick="addEmployee()">Add</button>
    <div class="hint" id="empMsg" style="padding-top:12px;"></div>`;

  list.forEach(e => {
    const div = document.createElement('div');
    div.className = 'vgroup' + (e.active ? '' : ' needsattn');
    const state = !e.active ? 'switched off'
      : e.locked ? `locked for ${e.locked_minutes} min`
      : e.must_change_pin ? 'must choose a PIN' : 'ok';
    div.innerHTML = `
      <div class="vgroup-head" style="cursor:default;">
        <div class="oldname">${htmlEsc(e.name)}
          <span class="chip emprole">${e.role}</span>
          <span class="chip${e.locked || e.must_change_pin ? ' note' : ''}">${state}</span></div>
      </div>
      <div class="vitem">
        <input type="tel" inputmode="numeric" class="textinput" maxlength="6"
               id="pin_${e.id}" placeholder="New temporary PIN">
        <button class="addbtn" style="margin-left:8px;" onclick="resetEmployeePin(${e.id})">Reset</button>
      </div>
      <div class="vitem"><span class="viname">Can manage people</span>
        <input type="checkbox" ${e.role === 'manager' ? 'checked' : ''}
               ${e.id === me.id ? 'disabled' : ''} style="width:22px;height:22px;"
               onchange="setEmployeeRole(${e.id}, this.checked)"></div>
      <div class="vitem"><span class="viname">Active</span>
        <input type="checkbox" ${e.active ? 'checked' : ''}
               ${e.id === me.id ? 'disabled' : ''} style="width:22px;height:22px;"
               onchange="setEmployeeActive(${e.id}, this.checked)"></div>
      ${e.role === 'manager' ? '' : `
      <div class="vitem"><span class="viname">Simple mode
        <span class="vihint">just the warehouse, pallet by pallet, no keyboard</span></span>
        <input type="checkbox" ${e.simple_mode ? 'checked' : ''}
               style="width:22px;height:22px;"
               onchange="setEmployeeSimple(${e.id}, this.checked)"></div>`}
      <div class="vgroup-head" style="cursor:default;"><div class="oldname">Can change</div></div>
      ${e.role === 'manager'
        ? '<div class="vitem"><span class="viname">everything, as a manager</span></div>'
        : whAreas.map(a => `<div class="vitem">
            <span class="viname">${htmlEsc(areaLabel(a))}</span>
            <input type="checkbox" class="areabox" data-emp="${e.id}" data-area="${htmlEsc(a)}"
                   ${(e.areas || []).includes(a) ? 'checked' : ''}
                   style="width:22px;height:22px;"
                   onchange="setEmployeeAreas(${e.id})"></div>`).join('')}`;
    wrap.appendChild(div);
  });
}

async function setEmployeeSimple(id, on){
  if (on && !confirm('Put this person in simple mode?\n\n'
    + 'They will see one screen for taking things out of the warehouse — '
    + 'no tabs, no other departments, no typing. Nothing else in the app.')) {
    return renderEmployees();
  }
  await empCall('PUT', '/api/employees/' + id, { simple_mode: !!on });
}

async function empCall(method, path, body){
  const res = await fetch(path, {
    method, headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) { if ($('empMsg')) $('empMsg').textContent = out.error || 'That did not work.'; return null; }
  return out;
}
async function addEmployee(){
  const name = $('newEmpName').value.trim();
  const pin = $('newEmpPin').value.trim();
  const role = $('newEmpManager').checked ? 'manager' : 'staff';
  if (!name) { $('empMsg').textContent = 'Give them a name first.'; return; }
  if (await empCall('POST', '/api/employees', { name, pin, role })) showEmployees();
}
async function resetEmployeePin(id){
  const pin = $('pin_' + id).value.trim();
  if (!pin) { $('empMsg').textContent = 'Type the temporary PIN to set.'; return; }
  if (await empCall('PUT', '/api/employees/' + id, { pin })) showEmployees();
}
async function setEmployeeRole(id, isManager){
  await empCall('PUT', '/api/employees/' + id, { role: isManager ? 'manager' : 'staff' });
  showEmployees();
}
// The whole set is sent every time, read off that person's own boxes, so
// ticking one cannot clear the rest.
async function setEmployeeAreas(id){
  const areas = [...document.querySelectorAll(`.areabox[data-emp="${id}"]`)]
    .filter(b => b.checked).map(b => b.dataset.area);
  await empCall('PUT', '/api/employees/' + id, { areas });
  showEmployees();
}

async function setEmployeeActive(id, active){
  await empCall('PUT', '/api/employees/' + id, { active });
  showEmployees();
}

// ---- offsite warehouse ------------------------------------------------------
// Not a counting screen. The other tabs ask "how much is on the shelf right now",
// answered by whoever is standing in front of it. Nobody is standing in front of
// this one, so the screen has to say how old each number is and let a stale one
// look like the guess it is.
let whStock = [], whMoves = [], whOpen = null, whVori = { configured: false }, whLinking = null;
let whSheet = null;
let whCats = [], whPallets = false, whAreas = ['produce','meat','fish','warehouse','coldstorage'];
// The stored area names stay as they are; only what a manager reads changes, so
// the tick matches the tab it grants.
const AREA_LABELS = { warehouse: 'Offsite', coldstorage: 'Monkish' };
const areaLabel = a => AREA_LABELS[a] || a;
let whLoc = 'warehouse', whContainer = null, whPals = [], whPallet = null;
// Two ways to look at the same stock. Cards answer "have we got it and where";
// the table is for someone sitting down to enter a lot of rows at once. Kept per
// person on their own phone, since it is a working preference, not a setting.
let whView = (() => { try { return localStorage.getItem('dm_wh_view') || 'list'; } catch { return 'list'; } })();
function whSetView(v){
  whView = v;
  try { localStorage.setItem('dm_wh_view', v); } catch {}
  renderWarehouse();
}

// The two places differ only in what their sections are called and whether the
// screen opens on a diagram of them.
const PLACES = {
  warehouse: {
    tab: 'OFFSITE', eyebrow: 'DAT MOI', title: 'Offsite',
    section: 'pallet', sections: 'pallets', sectionLabel: 'which pallets?',
    search: 'Search Offsite...', diagram: false,
    noEdit: 'You can look at the warehouse, but changing what is on the shelves is not yours to do. Ask a manager.'
  },
  coldstorage: {
    tab: 'MONKISH', eyebrow: 'DAT MOI', title: 'Monkish',
    section: 'container', sections: 'containers', sectionLabel: 'label / temp',
    search: 'Search Monkish...', diagram: true,
    noEdit: 'You can look at Monkish, but changing what is in the containers is not yours to do. Ask a manager.'
  }
};
const place = () => PLACES[whLoc];
// Rows on a pallet, counted from the deck: 1 sits on the boards. Six by default,
// but each pallet carries its own count — they are not all the same height.
// Eight, the same eight the server enforces.
const SPOTS = 8;
const levelsOf = p => Array.from({ length: Number(p?.levels) || 6 }, (_, i) => i + 1);

// Vori counts every unit the business owns; the warehouse row counts one place.
// What is left is what should be at the store. Both halves have to be in the same
// unit for that to mean anything, which is what the pack size is for.
function splitOf(row){
  if (row.vori_on_hand === null || row.vori_on_hand === undefined) return null;
  const total = Number(row.vori_on_hand);
  const pack = row.pack_size ? Number(row.pack_size) : null;
  // Without a pack size a case cannot be compared with whatever Vori counts in.
  if (!pack) return { total, warehouse: null, onsite: null, blocked: 'needs a pack size' };
  // One of the places holding this has no pack size, so the total held cannot be
  // worked out and the difference would be a guess dressed as a figure.
  if (Number(row.no_pack) > 0) {
    return { total, blocked: 'another place holds it without a pack size' };
  }
  // Everything held away from the store, not just the place on screen.
  const offsite = row.held_all === null || row.held_all === undefined
    ? Number(row.qty) * pack + (Number(row.qty_units) || 0)
    : Number(row.held_all);
  const here = row.held_here === null || row.held_here === undefined
    ? offsite : Number(row.held_here);
  return {
    total, warehouse: offsite, here, onsite: total - offsite,
    places: Number(row.places || 1), unit: row.unit_name || 'units'
  };
}

async function showWarehouse(loc){
  if (loc && loc !== whLoc){ whLoc = loc; whContainer = null; whOpen = null; whPallets = false; }
  hideAll();
  document.body.dataset.dept = whLoc;
  document.querySelectorAll('#deptBar button').forEach(b =>
    b.classList.toggle('active', b.dataset.dept === whLoc));
  const cfg = place();
  $('whEyebrow').innerHTML = cfg.eyebrow;
  $('whTitle').textContent = cfg.title;
  $('whSearch').placeholder = cfg.search;
  $('warehouseView').style.display = 'block';
  $('footerBar').style.display = 'none';
  $('whWrap').innerHTML = '<div class="hint">Loading...</div>';
  const r = await fetch('/api/place/' + whLoc).then(x => x.json()).catch(() => null);
  if (!r || r.error){
    // Out of range at the storage unit. Fall back to the copy this phone kept,
    // so a pickup can still be typed. Everything else on the tab is stale and
    // the banner across the top says so.
    const cache = whLoc === 'warehouse' ? cachedList() : null;
    if (!cache){
      $('whWrap').innerHTML = '<div class="hint">Could not load the warehouse.</div>';
      return;
    }
    whStock = cache.items; whMoves = []; whVori = { configured: false };
    whCats = cache.cats.map(name => ({ name })); whPals = []; whSheet = null;
    renderWarehouse();
    return;
  }
  whStock = r.stock; whMoves = r.moves; whVori = r.vori || { configured: false };
  whCats = r.categories || []; whPals = r.pallets || []; whSheet = r.sheet || null;
  if (whLoc === 'warehouse') cacheList();
  renderWarehouse();
}

function ageOf(row){
  if (row.counted_at === null || row.days_since_count === null) return { band: 'stale', text: 'never counted' };
  const d = Number(row.days_since_count);
  const who = row.counted_by ? ` by ${row.counted_by}` : '';
  const when = d < 1 ? 'today' : d < 2 ? 'yesterday'
    : d < 14 ? `${Math.round(d)} days ago`
    : d < 60 ? `${Math.round(d / 7)} weeks ago`
    : `${Math.round(d / 30)} months ago`;
  const band = d < 7 ? 'fresh' : d < 30 ? 'aging' : 'stale';
  return { band, text: `counted ${when}${who}` };
}

const fmtQty = n => String(Math.round(Number(n) * 100) / 100);

// "5 cases + 9 bottles" is what is on the shelf. A single decimal is not.
function stockLine(row){
  const cases = `${fmtQty(row.qty)}<span class="whunit"> ${htmlEsc(row.unit || 'cases')}</span>`;
  const u = Number(row.qty_units) || 0;
  if (!u) return cases;
  // Loose ones are shown even with no pack size set. What cannot be worked out
  // without one is the single total, not the fact that six packs are sitting
  // there out of a box.
  if (!row.pack_size) {
    return `${cases} <span class="whplus">+</span> ${fmtQty(u)}<span class="whunit"> loose</span>`;
  }
  return `${cases} <span class="whplus">+</span> ${fmtQty(u)}<span class="whunit"> ${htmlEsc(row.unit_name || 'units')}</span>`;
}
function totalLine(row){
  if (!row.pack_size) return '';
  const total = Number(row.qty) * Number(row.pack_size) + (Number(row.qty_units) || 0);
  // "per case", not "per cases"
  const one = (row.unit || 'case').replace(/s$/i, '');
  return `${fmtQty(total)} ${htmlEsc(row.unit_name || 'units')} all in &middot; ${fmtQty(row.pack_size)} per ${htmlEsc(one)}`;
}

// The warehouse is walked pallet by pallet, so the list is grouped the way the
// room is. Anything not on a pallet collects at the end, where it is a visible
// job rather than a silent gap.
function whGroups(shown){
  const order = whCats.map(c => c.name);
  const byName = {};
  whCats.forEach(c => byName[c.name] = c);
  const groups = new Map();
  order.forEach(n => groups.set(n, []));
  shown.forEach(row => {
    const key = row.category && groups.has(row.category) ? row.category
              : row.category ? row.category : '\u0000none';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  });
  return [...groups.entries()]
    .filter(([name, rows]) => rows.length || name !== '\u0000none')
    .map(([name, rows]) => ({
      name: name === '\u0000none' ? null : name,
      pallets: byName[name]?.pallets || null,
      rows
    }));
}

// Cold storage opens on a plan of the containers rather than a list, because the
// first question there is "which box is it in" and you cannot see inside one from
// the door. Tapping a container drops into its contents.
// "Container 2 · P3, stacked · on top" — the answer to where exactly is it.
// Angel's spreadsheet says ORDER NOW when the storage unit is below its PAR.
// Same sum here, with the shortfall spelled out so nobody has to work it out.
function shortOf(row){
  if (row.par === null || row.par === undefined) return null;
  const par = Number(row.par), have = Number(row.qty) || 0;
  return have < par ? { par, have, short: Math.round((par - have) * 100) / 100 } : null;
}
function parLine(row){
  const s = shortOf(row);
  if (s) return `<div class="parline short">Order now &mdash; ${fmtQty(s.short)} under a par of ${fmtQty(s.par)}</div>`;
  if (row.par !== null && row.par !== undefined) return `<div class="parline">par ${fmtQty(row.par)}</div>`;
  return '';
}
// Brand and size are what tell six Tom Yum Pastes apart.
function brandLine(row){
  const bits = [row.brand, row.size].filter(Boolean).map(htmlEsc);
  return bits.length ? `<div class="brandline">${bits.join(' &middot; ')}</div>` : '';
}

function whereLine(row){
  // Offsite only needs this when the pallet is not already obvious from the
  // screen you are on — searching, or the flat table of everything.
  if (!place().diagram){
    if (whGroup !== null) return '';
    return row.category
      ? `<div class="whwhere">on the <b>${htmlEsc(row.category)}</b> pallet</div>`
      : '<div class="whwhere">not on a pallet yet</div>';
  }
  const bits = [];
  if (row.category) bits.push(htmlEsc(row.category));
  const p = whPals.find(x => Number(x.id) === Number(row.pallet_id));
  if (p) bits.push(htmlEsc(p.label || 'pallet') + (p.level > 0 ? ', stacked' : ''));
  if (p && row.stack_pos) bits.push('level ' + row.stack_pos);
  return bits.length ? `<div class="whwhere">${bits.join(' \u00b7 ')}</div>` : '';
}

function whSummaryLine(){
  // None of this means anything to somebody whose only job is to say what he
  // carried out of the door.
  if (me?.simple_mode || whPicking){ $('whSummary').innerHTML = ''; return; }
  const stale = whStock.filter(r => ageOf(r).band === 'stale').length;
  const fresh = whStock.filter(r => ageOf(r).band === 'fresh').length;
  const linked = whStock.filter(r => r.vori_product_id).length;
  const whEdit = canEdit(whLoc);
  // Where the list of products comes from, and whether that link is healthy. A
  // stale or broken sheet is worth saying out loud: the counts are still right,
  // but anything Angel added since would be missing.
  const sheetLine = (() => {
    if (place().diagram || !whSheet) return '';
    if (!whSheet.configured) {
      return me.role === 'manager'
        ? '<div class="whsync">No Google Sheet connected. Set GOOGLE_API_KEY and WAREHOUSE_SHEET_ID in Railway.</div>'
        : '';
    }
    const when = whSheet.last_sync
      ? new Date(whSheet.last_sync).toLocaleString('en-US',
          { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' })
      : 'never';
    const err = whSheet.last_error
      ? `<div class="sheetbad">Last sheet pull failed: ${htmlEsc(whSheet.last_error.replace(/^\S+\s/, ''))}</div>`
      : '';
    return `<div class="whsync">Product list from Angel's sheet &middot; pulled ${when}
        ${whEdit ? '<button class="vorilink" onclick="whSyncSheet(true)">Check for changes</button>' : ''}
        <span id="whSheetMsg"></span></div>${err}`;
  })();

  // Nobody counting boxes can act on a missing API key, so it is only worth
  // saying to whoever can go and set one.
  const voriLine = !whVori.configured
    ? (me.role === 'manager'
        ? '<div class="whsync">Vori is not connected. Add a read-only API key as VORI_API_KEY in Railway.</div>'
        : '')
    : `<div class="whsync">Vori: ${whVori.products || 0} products,
        ${whVori.last_sync ? 'synced ' + new Date(whVori.last_sync).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}) : 'never synced'}
        &middot; ${linked} of ${whStock.length} linked
        <button class="vorilink" onclick="whSync()">Sync now</button>
        <span id="whSyncMsg"></span></div>`;
  // Offsite puts this on its front screen instead, where there is room for it.
  const sectionLine = (!place().diagram)
    ? ''
    : `<div class="whsync">${whCats.length} ${place().sections}
      ${whEdit ? `<button class="vorilink" onclick="whShowPallets()">Manage ${place().sections}</button>` : ''}</div>`;
  const pal = whPals.find(x => Number(x.id) === Number(whPallet));
  const backLine = place().diagram && whContainer !== null
    ? `<div class="whsync">
        <button class="vorilink" onclick="whBackToDiagram()">&larr; ${place().sections}</button>
        ${whContainer === '*' ? '' : `<b>${htmlEsc(whContainer || 'Not in a container')}</b>`}
        ${whPallet !== null && whContainer !== '*'
          ? `<button class="vorilink" onclick="whBackToContainer()">&larr; the plan</button>
             <b>${htmlEsc(pal ? (pal.label || 'Pallet') : 'not on a pallet')}</b>` : ''}
       </div>`
    : (!place().diagram && whGroup !== null
      ? `<div class="whsync">
          <button class="vorilink" onclick="whBackToShelf()">&larr; ${place().sections}</button>
          <b>${whGroup ? htmlEsc(whGroup) : 'Not on a pallet yet'}</b>
         </div>`
      : '');
  $('whSummary').innerHTML = (whStock.length
    ? `${whStock.length} items &middot; <b>${stale}</b> not checked in a month &middot; ${fresh} checked this week`
    : `Nothing here yet.${canEdit(whLoc) ? '' : ' ' + place().noEdit}`) + backLine + sectionLine + sheetLine + voriLine;
}

function renderDiagram(){
  const wrap = $('whWrap');
  const cfg = place();
  // The plan still needs the header the list has, or the way in to the
  // containers and to Vori disappears behind it.
  whSummaryLine();
  const byCat = {};
  whStock.forEach(r => { const k = r.category || null; (byCat[k] = byCat[k] || []).push(r); });
  const loose = byCat[null] || [];

  wrap.innerHTML = `
    <div class="hint">${whCats.length
      ? `Tap a ${cfg.section} to see inside it, or <b>+ add</b> to put something in it.`
      : canEdit(whLoc)
        ? `Nothing set up yet. Start with <b>Manage ${cfg.sections}</b> below to name the ${cfg.sections} you have out there, then add what is in them.`
        : `No ${cfg.sections} set up yet. Ask a manager to add them.`}</div>
    <div class="cyard">
      ${whCats.map(c => {
        const rows = byCat[c.name] || [];
        const stale = rows.filter(r => ageOf(r).band === 'stale').length;
        const band = !rows.length ? 'empty' : stale ? 'stale' : 'ok';
        return `<div class="cbox ${band}">
          <button class="cbopen" onclick="whOpenContainer('${esc(c.name)}')">
            <div class="cname">${htmlEsc(c.name)}</div>
            ${c.pallets ? `<div class="cmeta">${htmlEsc(c.pallets)}</div>` : ''}
            <div class="ccount">${rows.length}</div>
            <div class="cmeta">${rows.length === 1 ? 'item' : 'items'}${stale ? ` &middot; ${stale} stale` : ''}</div>
          </button>
          ${canEdit(whLoc) ? `<button class="cbadd" onclick="whAddHere('${esc(c.name)}')">+ add</button>` : ''}
        </div>`;
      }).join('')}
      ${loose.length ? `<div class="cbox loose">
          <button class="cbopen" onclick="whOpenContainer(null)">
            <div class="cname">Not in a container</div>
            <div class="ccount">${loose.length}</div>
            <div class="cmeta">${loose.length === 1 ? 'item' : 'items'}</div>
          </button>
        </div>` : ''}
    </div>
    <div class="cacts">
      ${canEdit(whLoc) ? `<button class="addbtn" onclick="whAddHere(null)">+ Add an item</button>` : ''}
      ${canEdit(whLoc) ? `<button class="addbtn ghost" onclick="whShowPallets()">Manage ${cfg.sections}</button>` : ''}
    </div>
    ${whCats.length ? `<button class="listlink" onclick="whOpenContainer('*')">See everything as a list</button>` : ''}`;
}

function whOpenContainer(name){ whContainer = name; whPallet = null; renderWarehouse(); }
function whOpenPallet(id){ whPallet = id; renderWarehouse(); }
// Offsite's equivalent of opening a container: which pallet you are standing at.
// null is the pallet list, '' the pile that is not on a pallet yet.
let whGroup = null;
function whOpenGroup(name){ whGroup = name; whOpen = null; whAddOpen = false; window.scrollTo(0, 0); renderWarehouse(); }
let whAddOpen = false;
function whToggleAdd(){
  whAddOpen = !whAddOpen;
  renderWarehouse();
  if (whAddOpen) $('whNewName')?.focus();
}
function whBackToShelf(){ whGroup = null; whOpen = null; whAddOpen = false; window.scrollTo(0, 0); renderWarehouse(); }
function whBackToContainer(){ whPallet = null; renderWarehouse(); }

// The plan of one container: each slot is a column, stacked pallets sit above
// the one below, drawn in that order so the picture matches what you walk up to.
function renderContainerPlan(){
  const wrap = $('whWrap');
  whSummaryLine();
  const all = whPals.filter(p => p.container === whContainer).sort((a, b) => a.slot - b.slot);
  const onPallet = id => whStock.filter(r => Number(r.pallet_id) === Number(id));
  const loose = whStock.filter(r => (r.category || null) === whContainer && !r.pallet_id);
  const edit = canEdit(whLoc);
  // Containers built under the old version can carry a ninth or tenth spot. The
  // empty ones are cleared away on boot; anything still here has boxes on it, so
  // it is drawn apart from the container rather than pretending it fits.
  const pals = all.filter(p => p.slot < SPOTS);
  const over = all.filter(p => p.slot >= SPOTS);

  if (!pals.length){
    wrap.innerHTML = `<div class="hint">This container has no pallet spots yet.</div>
      ${edit ? `<button class="addbtn" style="width:100%;" onclick="whMakeSpots()">Set up 8 pallet spots</button>` : ''}`;
    return;
  }

  // Drawn as you look in from the door: the back of the container at the top of
  // the screen, spots 1 and 2 nearest you at the bottom. Rows are reversed but
  // each pair keeps its left-to-right order.
  const rows2 = [];
  for (let i = 0; i < pals.length; i += 2) rows2.push(pals.slice(i, i + 2));
  const laidOut = rows2.reverse().flat();

  wrap.innerHTML = `
    <div class="hint">Tap a pallet to fill it in.
      A container holds eight &mdash; there is no room for more.</div>
    <div class="endmark">back of the container</div>
    <div class="spotgrid">
      ${laidOut.map(p => {
        const rows = onPallet(p.id);
        // Highest first, so the card reads the way the pile looks.
        const stack = levelsOf(p).slice().reverse()
          .map(l => rows.find(r => Number(r.stack_pos) === l)).filter(Boolean);
        const stale = rows.some(r => ageOf(r).band === 'stale');
        return `<button class="spot ${rows.length ? (stale ? 'stale' : 'ok') : 'open'}"
                        onclick="whOpenPallet(${p.id})">
          <div class="spotnum">${htmlEsc(p.label || (p.slot + 1))}</div>
          <div class="spotstack">
            ${stack.length
              ? stack.map(r => `<div class="spotline">${fmtQty(r.qty)} ${htmlEsc(r.item_name)}</div>`).join('')
              : '<div class="spotline blank">empty</div>'}
          </div>
        </button>`;
      }).join('')}
    </div>
    <div class="endmark front">front &mdash; the doors</div>
    ${over.length ? `<div class="overflow">
      <div class="palname">${over.length} spot${over.length === 1 ? '' : 's'} past the eight</div>
      <div class="palmeta">Made before the app knew a container only holds eight, and
        ${over.length === 1 ? 'it still has' : 'they still have'} boxes on
        ${over.length === 1 ? 'it' : 'them'}. Somebody who has been out there needs to say
        where ${over.length === 1 ? 'it' : 'they'} really ${over.length === 1 ? 'is' : 'are'}.</div>
      ${over.map(p => {
        const rows = onPallet(p.id);
        return `<div class="overrow">
          <button class="listlink" onclick="whOpenPallet(${p.id})">
            ${htmlEsc(p.label || (p.slot + 1))} &mdash; ${rows.length} item${rows.length === 1 ? '' : 's'}</button>
          ${edit ? `<button class="listlink danger" onclick="whDropSpot(${p.id})">take the spot out</button>` : ''}
        </div>`;
      }).join('')}
      ${edit ? `<div class="palmeta">Taking a spot out keeps its boxes &mdash; they move to
        &ldquo;not on a pallet&rdquo; in this container until somebody places them again.</div>` : ''}
    </div>` : ''}
    ${loose.length ? `<div class="palloose">
      <div class="palname">Not on a pallet</div>
      <div class="palmeta">${loose.length} item${loose.length === 1 ? '' : 's'} in this container, not placed</div>
      <button class="listlink" onclick="whOpenPallet('none')">show them</button></div>` : ''}`;
}

// One pallet: three rows, top first, each a quantity and a product. Blank means
// nothing is on that level.
function renderPalletForm(){
  const wrap = $('whWrap');
  whSummaryLine();
  const p = whPals.find(x => Number(x.id) === Number(whPallet));
  if (!p) { whPallet = null; return renderWarehouse(); }
  const rows = whStock.filter(r => Number(r.pallet_id) === p.id);
  const edit = canEdit(whLoc);
  const names = [...new Set(whStock.map(r => r.item_name))].sort();

  wrap.innerHTML = `
    <div class="palform">
      <div class="palformnum">${htmlEsc(p.label || (p.slot + 1))}</div>
      <datalist id="itemNames">${names.map(n => `<option value="${htmlEsc(n)}">`).join('')}</datalist>
      <div class="endmark">top of the pile</div>
      ${levelsOf(p).slice().reverse().map(lvl => {
        const r = rows.find(x => Number(x.stack_pos) === lvl);
        return `<div class="lvl">
          <div class="lvlrow">
            <div class="lvlnum">${lvl}</div>
            <input type="tel" inputmode="decimal" class="lvlqty" id="q${lvl}"
                   value="${r ? fmtQty(r.qty) : ''}" placeholder="qty" ${edit ? '' : 'disabled'}>
            <input type="text" class="lvlitem" id="n${lvl}" list="itemNames"
                   value="${r ? htmlEsc(r.item_name) : ''}" placeholder="product" ${edit ? '' : 'disabled'}>
          </div>
          ${r ? `<div class="lvlage ${ageOf(r).band}">${htmlEsc(ageOf(r).text)}</div>` : ''}
        </div>`;
      }).join('')}
      <div class="endmark front">bottom &mdash; on the pallet</div>
      ${edit ? `<div class="rowctl">
        <button onclick="whPalletRows(${p.id},'remove')">&minus; row</button>
        <span>${levelsOf(p).length} rows</span>
        <button onclick="whPalletRows(${p.id},'add')">+ row</button>
      </div>` : ''}
      ${edit ? `<button class="addbtn" style="width:100%;margin-top:12px;" onclick="whSavePallet(${p.id})">Save this pallet</button>
                <div class="hint" id="palSaveMsg" style="padding:10px 0 0;">Clear a row to take it off the pallet.</div>` : ''}
    </div>
    <button class="listlink" onclick="whBackToContainer()">&larr; back to the container</button>`;
}

async function whPalletRows(id, rows){
  const msg = $('palSaveMsg');
  const res = await fetch('/api/place/' + whLoc + '/pallet/' + id, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rows })
  });
  if (!res.ok){
    const b = await res.json().catch(() => ({}));
    if (msg) msg.textContent = b.error || 'Could not change that.';
    return;
  }
  await showWarehouse();
}

async function whMakeSpots(){
  await fetch('/api/place/' + whLoc + '/spots', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ container: whContainer })
  });
  await showWarehouse();
}

// Always a dry run first. Angel's sheet is the catalogue, and seeing "12 new,
// 3 gone" before anything happens is the difference between a sync and a
// surprise.
async function whSyncSheet(dry){
  const msg = $('whSheetMsg');
  if (msg) msg.textContent = dry ? ' checking...' : ' pulling...';
  const res = await fetch('/api/place/warehouse/sheet-sync', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dry_run: !!dry })
  });
  const r = await res.json().catch(() => ({}));
  if (!res.ok){ if (msg) msg.textContent = ''; alert(r.error || 'Could not read the sheet.'); return; }

  if (!dry){
    if (msg) msg.textContent = '';
    await showWarehouse();
    return;
  }
  if (!r.added && !r.changed && !r.gone && !r.problems.length){
    if (msg) msg.textContent = ' — nothing new.';
    return;
  }
  const bits = [];
  if (r.added)   bits.push(`${r.added} new item${r.added === 1 ? '' : 's'}:\n  ` + r.added_names.join('\n  '));
  if (r.changed) bits.push(`${r.changed} with a changed pallet, par or size`);
  if (r.gone)    bits.push(`${r.gone} in the app but not in the sheet — these are KEPT, not deleted:\n  `
                            + r.gone_names.join('\n  '));
  if (r.problems.length) bits.push('Problems in the sheet:\n  ' + r.problems.join('\n  '));
  if (msg) msg.textContent = '';
  if (confirm(bits.join('\n\n') + '\n\nPull these in? Counts are never changed.')) whSyncSheet(false);
}

async function whSetPar(name){
  const box = [...document.querySelectorAll('.whrow')]
    .find(d => d.querySelector('.whname')?.textContent === name)?.querySelector('.whpar');
  const res = await fetch(`/api/place/${whLoc}/item/${encodeURIComponent(name)}/par`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ par: box ? box.value : '' })
  });
  if (!res.ok){ alert((await res.json().catch(() => ({}))).error || 'Could not save that.'); return; }
  await showWarehouse();
}

async function whDropSpot(id){
  const p = whPals.find(x => Number(x.id) === Number(id));
  const n = whStock.filter(r => Number(r.pallet_id) === Number(id)).length;
  if (!confirm(`Take spot ${p?.label || ''} out of this container?\n\n`
    + (n === 1
        ? 'Its one item stays in the container, listed under "not on a pallet".'
        : `Its ${n} items stay in the container, listed under "not on a pallet".`))) return;
  const res = await fetch(`/api/place/${whLoc}/pallet/${id}`, { method: 'DELETE' });
  if (!res.ok) { alert((await res.json().catch(() => ({}))).error || 'Could not take that spot out.'); return; }
  await showWarehouse();
}

async function whSavePallet(id){
  const msg = $('palSaveMsg');
  if (msg) msg.textContent = 'Saving...';
  // Saved from the deck upwards, the way it is loaded.
  const pal = whPals.find(x => Number(x.id) === Number(id));
  for (const lvl of levelsOf(pal)){
    const name = $('n' + lvl).value.trim();
    const qty = $('q' + lvl).value.trim();
    if (name && qty === ''){ msg.textContent = `How many ${name}?`; return; }
    const res = await fetch(`/api/place/${whLoc}/pallet/${id}/level/${lvl}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, qty: qty || 0 })
    });
    if (!res.ok){
      const b = await res.json().catch(() => ({}));
      if (msg) msg.textContent = b.error || 'Could not save that.';
      return;
    }
  }
  whPallet = null;
  await showWarehouse();
}


// Opening the form from a container means adding to that container, so the field
// arrives filled in. Left blank it would quietly file the item under nothing.
function whAddHere(container){
  whContainer = container === null ? '*' : container;
  renderWarehouse();
  setTimeout(() => {
    const el = $('whNewName');
    if (el){ el.scrollIntoView({ block: 'center' }); el.focus(); }
  }, 60);
}
function whBackToDiagram(){ whContainer = null; whOpen = null; renderWarehouse(); }

// A spreadsheet of the same stock: tab across, tab down, one Save. No cards, no
// tapping into anything — the shape Angel already works in. Grouped by pallet so
// the pallet is a heading rather than a fourth column: three columns fit a phone
// without clipping, the list reads in the order you walk the warehouse, and
// adding an item is typing its name on the blank line under the right pallet.
function renderTable(){
  const wrap = $('whWrap');
  whSummaryLine();
  const q = ($('whSearch').value || '').trim().toLowerCase();
  const searching = !!q;
  const edit = canEdit(whLoc);
  const shown = whStock.filter(r => !searching || r.item_name.toLowerCase().includes(q));

  // Every pallet gets a section, even an empty one, so there is always somewhere
  // to type. While searching, only sections with a hit are worth showing.
  const groups = [];
  for (const c of whCats.map(c => c.name)) {
    const rows = shown.filter(r => r.category === c);
    if (!searching || rows.length) groups.push({ name: c, rows });
  }
  const loose = shown.filter(r => !r.category || !whCats.some(c => c.name === r.category));
  if (loose.length || (!searching && !groups.length)) groups.push({ name: '', rows: loose });

  let i = 0;
  const line = (r, cat) => {
    const n = i++;
    const under = r && shortOf(r);
    // No brand column: the name already starts with it, and on a phone the two
    // together clipped both. It stays editable on the item's own card.
    //
    // An existing name is text, not a box. Angel's names run to thirty characters
    // and an input cannot wrap, so half of them were cut off mid-word; as text it
    // wraps and stays whole while the two boxes he is actually typing in keep
    // their place. A blank line still gets a box, because that one needs typing.
    return `<tr class="${under ? 'gshort' : ''}">
      ${r
        ? `<td class="gtext">${htmlEsc(r.item_name)}
             <input type="hidden" class="g gname" data-i="${n}" data-cat="${htmlEsc(cat)}"
                    data-was="${htmlEsc(r.item_name)}" value="${htmlEsc(r.item_name)}"></td>`
        : `<td><input class="g gname" data-i="${n}" data-cat="${htmlEsc(cat)}" data-was=""
                     ${edit ? '' : 'disabled'} placeholder="+ add an item here"></td>`}
      <td><input class="g gqty" data-i="${n}" inputmode="decimal"
                 value="${r ? fmtQty(r.qty) : ''}" ${edit ? '' : 'disabled'}></td>
      <td><input class="g gpar" data-i="${n}" inputmode="decimal"
                 value="${r && r.par !== null && r.par !== undefined ? fmtQty(r.par) : ''}"
                 ${edit ? '' : 'disabled'} placeholder="–"></td>
      <td class="gflag">${under ? '\u25cf' : ''}</td>
    </tr>`;
  };

  const section = g => `
    <tr class="ghead"><th colspan="4">${g.name ? htmlEsc(g.name) : 'Not on a pallet yet'}</th></tr>
    ${g.rows.sort((a, b) => a.item_name.localeCompare(b.item_name)).map(r => line(r, g.name)).join('')}
    ${edit && !searching ? [line(null, g.name), line(null, g.name)].join('') : ''}`;

  wrap.innerHTML = `
    ${whViewToggle()}
    <div class="gridwrap">
      <table class="grid">
        <thead><tr><th>Item</th><th>Qty</th><th>Par</th><th></th></tr></thead>
        <tbody>${groups.map(section).join('')}</tbody>
      </table>
    </div>
    ${searching ? '<div class="hint">Clear the search to add items.</div>' : ''}
    ${edit ? `<button class="addbtn" style="width:100%;margin-top:12px;" onclick="whSaveTable()">Save the table</button>
      <div class="hint" id="gridMsg">Type across, then down. Everything saves at once.</div>`
    : `<div class="hint">${place().noEdit}</div>`}`;
}

function whViewToggle(){
  return `<div class="viewtog">
    <button class="${whView === 'list' ? 'on' : ''}" onclick="whSetView('list')">Cards</button>
    <button class="${whView === 'table' ? 'on' : ''}" onclick="whSetView('table')">Table</button>
  </div>`;
}

async function whSaveTable(){
  const msg = $('gridMsg');
  msg.textContent = 'Saving...';
  const byIndex = {};
  document.querySelectorAll('#whWrap .g').forEach(el => {
    const i = el.dataset.i;
    const r = byIndex[i] = byIndex[i] || { was: '' };
    if (el.classList.contains('gname')) {
      r.name = el.value.trim();
      r.was = el.dataset.was || '';
      r.category = el.dataset.cat || '';   // the section it was typed under
    }
    if (el.classList.contains('gqty'))   r.qty = el.value.trim();
    if (el.classList.contains('gpar'))   r.par = el.value.trim();
  });
  // Only what actually changed, so a save is not 200 pointless writes.
  const rows = Object.values(byIndex).filter(r => {
    if (!r.name) return false;
    const before = whStock.find(x => x.item_name === (r.was || r.name));
    if (!before) return true;
    const wasPar = before.par === null || before.par === undefined ? '' : fmtQty(before.par);
    return r.name !== before.item_name
      || r.qty !== fmtQty(before.qty)
      || r.par !== wasPar
      || r.category !== (before.category || '');
  });
  if (!rows.length){ msg.textContent = 'Nothing changed.'; return; }
  const res = await fetch('/api/place/' + whLoc + '/bulk', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rows })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok){ msg.textContent = body.error || 'Could not save that.'; return; }
  await showWarehouse();
  const m = $('gridMsg');
  if (m) m.textContent = `Saved. ${body.added} added, ${body.changed} updated.`;
}

// Folded shut under whatever is on screen: you come to Offsite to look far more
// often than to add, but there always has to be a way in.
function addFoldHtml(edit, target){
  if (!edit) return '';
  return whAddOpen
    ? `<div class="addfold">${addFormHtml(target)}
         <button class="listlink" onclick="whToggleAdd()">Never mind</button></div>`
    : `<button class="listlink addfoldbtn" onclick="whToggleAdd()">+ Add something${
         target ? ' to ' + htmlEsc(target) : ' to the warehouse'}</button>`;
}

// The one add form, used by whichever screen is offering it. It takes the
// pallet it should land on, which is blank on the front screen where no pallet
// is implied and the person has to say.
function addFormHtml(target){
  return `
    <div class="vgroup">
      <div class="vgroup-head" style="cursor:default;"><div class="oldname">${
        target ? `Add to ${htmlEsc(target)}` : 'Add something'}</div></div>
      <div class="vitem"><input type="text" class="textinput" id="whNewName" placeholder="What is it?"></div>
      <div class="vitem">
        <input type="text" class="textinput" id="whNewUnit" placeholder="cases / boxes">
        <input type="tel" inputmode="decimal" class="textinput" id="whNewQty" placeholder="How many">
      </div>
      <div class="vitem">
        <input type="text" class="textinput" id="whNewCat" list="whCatList"
               value="${htmlEsc(target || '')}" placeholder="Which ${place().section}?">
        <datalist id="whCatList">${whCats.map(c => `<option value="${htmlEsc(c.name)}">`).join('')}</datalist>
      </div>
      <div class="whpick">Picked at? Say what is inside one and people can log single ones.</div>
      <div class="vitem">
        <input type="tel" inputmode="decimal" class="textinput" id="whNewPack" placeholder="e.g. 24">
        <input type="text" class="textinput" id="whNewUnitName" placeholder="bottles / packs">
      </div>
    </div>
    <button class="addbtn" style="width:100%;margin-bottom:6px;" onclick="whAdd()">Add to the warehouse</button>
    <div class="hint" id="whMsg"></div>`;
}

// Andy's screen.
//
// He goes to the storage unit alone and takes whatever is needed. Finding
// "Three Ladies Jasmine Rice 50lb" in a list of 215 is a spelling test, not a
// tool, so he is never asked to. The pallet identifies the item instead: he
// walks to a pallet, taps it, and sees only the things on it -- seven, typically.
// Then plus and minus. No keyboard is ever shown, nothing can be typed wrong,
// and there is no way to reach the rest of the app.
//
// It writes the same draft as the full pickup screen and posts to the same
// endpoint, so it inherits working with no signal, surviving a reload, and being
// safe to re-send.
let simplePallet = null;
// Set while the "saved" screen is up. Without it, the refresh that follows a save
// re-rendered straight over the confirmation and Andy saw the pallet list again
// with no sign anything had happened.
let simpleSaved = null;

function simpleSrc(){
  const cache = cachedList();
  if (whStock.length) return { items: whStock, cats: whCats.map(c => c.name) };
  return cache ? { items: cache.items, cats: cache.cats } : null;
}

function renderSimple(){
  const wrap = $('whWrap');
  // Cleared here rather than trusted to whSummaryLine, which this screen never
  // calls -- the item counts and the two "not connected" notices were simply
  // left behind by whatever screen came before.
  $('whSummary').innerHTML = '';
  if (simpleSaved !== null){
    wrap.innerHTML = `<div class="bigdoneview">
      <div class="tick">&#10003;</div>
      <h2 class="bigask">Saved</h2>
      <p class="bigsub">${simpleSaved} thing${simpleSaved === 1 ? '' : 's'} written down.
        Nothing else to do.</p>
      <button class="bigrestart" onclick="simpleRestart()">Take something else</button>
      ${me?.simple_mode ? '' :
        `<div><button class="listlink" style="margin-top:14px;" onclick="whStopPick()">Back to the warehouse</button></div>`}
    </div>`;
    return;
  }
  const src = simpleSrc();
  const draft = pickDraft();
  // Counting lines, not cases: "half a case and six packs" is one thing taken,
  // and a basket reading 0.5 would look like a mistake.
  const total = Object.keys(draft.lines).length;

  if (!src){
    wrap.innerHTML = `<div class="simplewarn">This phone has not loaded the warehouse yet.
      Open it once at the store, where there is signal.</div>`;
    return;
  }

  const basket = `<div class="basket ${total ? 'on' : ''}">
      <span><b>${total}</b> thing${total === 1 ? '' : 's'} taken</span>
      ${total ? `<button class="bigdone" onclick="simpleDone()">Done</button>` : ''}
    </div>`;

  if (simplePallet === null){
    const counts = {};
    Object.entries(draft.lines).forEach(([name, v]) => {
      const it = src.items.find(x => x.item_name === name);
      const k = it?.category || '';
      counts[k] = (counts[k] || 0) + 1;
    });
    const tiles = src.cats.map(c => {
      const n = src.items.filter(r => r.category === c).length;
      if (!n) return '';
      return `<button class="ptile ${counts[c] ? 'has' : ''}" onclick="simpleOpen('${esc(c)}')">
        <span class="pname">${htmlEsc(c)}</span>
        ${counts[c] ? `<span class="pgot">${counts[c]} taken</span>`
                    : `<span class="pn">${n} thing${n === 1 ? '' : 's'}</span>`}
        ${(whCats.find(x => x.name === c) || {}).pallets
            ? `<span class="pwhere">${htmlEsc((whCats.find(x => x.name === c) || {}).pallets)}</span>` : ''}
        ${(whCats.find(x => x.name === c) || {}).part_cases
            ? '<span class="ppart">half cases &amp; loose packs</span>' : ''}
      </button>`;
    }).join('');
    wrap.innerHTML = basket
      + (me?.simple_mode ? ''
         : `<button class="bigback" onclick="whStopPick()">&larr; Back to ${place().sections}</button>`)
      + `<h2 class="bigask">What did you take?</h2>
         <p class="bigsub">Tap the pallet you took it from.</p>
         <div class="ptiles">${tiles}</div>
         <button class="ptile other" onclick="simpleOther()">
           <span class="pname">Something else</span>
           <span class="pn">not on a pallet, or you are not sure</span></button>`;
    return;
  }

  const rows = src.items.filter(r => r.category === simplePallet)
    .sort((a, b) => a.item_name.localeCompare(b.item_name));
  // The pallet flag still works as a way to reveal everything on a mixed pallet,
  // but it no longer decides a row -- the item does.
  const reveal = !!(whCats.find(c => c.name === simplePallet) || {}).part_cases
                 || simpleReveal === simplePallet;
  wrap.innerHTML = basket
    + `<button class="bigback" onclick="simpleBack()">&larr; All pallets</button>
       <h2 class="bigask">${htmlEsc(simplePallet)}</h2>
       <p class="bigsub">${(whCats.find(c => c.name === simplePallet) || {}).pallets
           ? htmlEsc((whCats.find(c => c.name === simplePallet) || {}).pallets) + ' &middot; how many did you take?'
           : 'How many did you take?'}</p>
       <div class="bigrows">${rows.map(r => bigRow(r, draft, reveal)).join('')}</div>
       ${reveal ? '' : `<button class="askparts" onclick="simpleAskParts()">
          Took half a case, or packs out of a box?</button>`}
       <button class="askparts" onclick="simpleOther()">
         Took something that is not on this list?</button>`;
}

// Standing at a pallet needing a control the row does not have. Reveals them for
// this visit only; whichever item he actually uses is marked when the run saves,
// so the right products end up flagged and every other row stays down to one
// button. Nothing to configure, and unlike changing a pallet setting it does not
// need a signal.
let simpleReveal = null;
function simpleAskParts(){ simpleReveal = simplePallet; renderSimple(); }

// A row shows only what this product actually needs.
//
// Something taken by the case gets one control and nothing else, which is nearly
// everything. Something people pick at leads with packs, because packs are what
// he is counting, and keeps whole cases as a smaller control beside it. It is the
// product that decides, not the pallet it sits on -- thirty-eight things sit on
// Chili Paste and perhaps three of them ever get opened.
function bigRow(r, draft, reveal){
  const line = draft.lines[r.item_name] || {};
  const n = Number(line.cases) || 0;
  const u = Number(line.units) || 0;
  // A leaning thumb on + is otherwise invisible: the basket counts things taken,
  // not cases, so twenty stray presses on one row still reads as "1 thing".
  const have = Number(r.qty) || 0;
  const whole = Math.floor(n);
  const half = n - whole >= 0.5;
  const name = esc(r.item_name);
  const loose = !!r.pick_loose || u > 0;
  const pack = Number(r.pack_size) || 0;
  const rolls = pack && u >= pack;

  const nameCell = `<div class="bigname">${htmlEsc(r.item_name)}
      ${loose ? `<span class="bysub">taken by the pack${pack ? ` &middot; ${fmtQty(pack)} to a case` : ''}</span>` : ''}
      ${n > have ? `<span class="toomany">the pallet only had ${fmtQty(have)}</span>` : ''}</div>`;
  const stepper = (val, fn) => `<div class="bigstep">
      <button class="minus" ${val ? '' : 'disabled'} onclick="${fn}('${name}',-1)">&minus;</button>
      <span class="bignum">${val ? fmtQty(val) : 0}</span>
      <button class="plus" onclick="${fn}('${name}',1)">+</button>
    </div>`;

  if (!loose && !reveal && !half){
    return `<div class="bigrow ${n ? 'on' : ''}">
      <div class="bigtop">${nameCell}${stepper(n, 'simpleBump')}</div></div>`;
  }

  return `<div class="bigrow ${n || u ? 'on' : ''} ${loose ? 'picked' : ''}">
    <div class="bigtop">${nameCell}${loose ? stepper(u, 'simpleLoose') : stepper(n, 'simpleBump')}</div>
    ${rolls ? `<div class="rollup">${fmtQty(u)} packs is
       ${fmtQty(Math.floor(u / pack))} full case${Math.floor(u / pack) === 1 ? '' : 's'}${
       u % pack ? ` and ${fmtQty(u % pack)} over` : ''} &mdash; it saves that way</div>` : ''}
    <div class="bigparts">
      ${loose
        ? `<span class="chip cases">
             <button ${n ? '' : 'disabled'} onclick="simpleBump('${name}',-1)">&minus;</button>
             <b>${n ? fmtQty(n) : 0}</b> whole case${n === 1 ? '' : 's'}
             <button onclick="simpleBump('${name}',1)">+</button></span>`
        : u ? `<span class="chip loose">
                 <button onclick="simpleLoose('${name}',-1)">&minus;</button>
                 <b>${fmtQty(u)}</b> loose
                 <button onclick="simpleLoose('${name}',1)">+</button></span>`
            : `<button class="chip" onclick="simpleLoose('${name}',1)">opened a box</button>`}
      <button class="chip ${half ? 'on' : ''}" onclick="simpleHalf('${name}')">
        ${half ? '&#10003; ' : ''}half a case</button>
    </div>
  </div>`;
}

function simpleOpen(cat){ simplePallet = cat; simpleReveal = null; window.scrollTo(0,0); renderSimple(); }
function simpleBack(){ simplePallet = null; simpleReveal = null; window.scrollTo(0,0); renderSimple(); }

// Whole cases. A half already on the line is kept: three and a half plus one is
// four and a half, which is what pressing + next to "half a case" should mean.
function simpleBump(name, by){
  const d = pickDraft();
  const cur = Number((d.lines[name] || {}).cases) || 0;
  const next = Math.max(0, cur + by);
  simpleSet(d, name, next, Number((d.lines[name] || {}).units) || 0);
}

// Half of one case, on and off. Soy sauce and fish sauce come back like this.
function simpleHalf(name){
  const d = pickDraft();
  const cur = Number((d.lines[name] || {}).cases) || 0;
  const whole = Math.floor(cur);
  const next = cur - whole >= 0.5 ? whole : whole + 0.5;
  simpleSet(d, name, next, Number((d.lines[name] || {}).units) || 0);
}

// Packs pulled out of an opened box. Counted as themselves, not guessed at as a
// fraction of a case nobody has measured.
function simpleLoose(name, by){
  const d = pickDraft();
  const cur = Number((d.lines[name] || {}).units) || 0;
  simpleSet(d, name, Number((d.lines[name] || {}).cases) || 0, Math.max(0, cur + by));
}

function simpleSet(d, name, cases, units){
  if (cases > 0 || units > 0) d.lines[name] = { cases: String(cases), units: String(units) };
  else delete d.lines[name];
  saveDraft(d);
  renderSimple();
}

// Anything he cannot place. Recorded as a note on the run rather than guessed at,
// so somebody who knows can sort it out instead of the number being wrong.
function simpleOther(){
  const what = prompt('What did you take? Just describe it — somebody will sort it out.');
  if (!what || !what.trim()) return;
  const d = pickDraft();
  d.note = [d.note, what.trim()].filter(Boolean).join('; ');
  saveDraft(d);
  alert('Noted. Carry on, and press Done when you are finished.');
  renderSimple();
}

async function simpleDone(){
  const d = pickDraft();
  const items = Object.entries(d.lines)
    .map(([name, v]) => ({ name, cases: Number(v.cases) || 0, units: Number(v.units) || 0 }))
    .filter(x => x.cases > 0 || x.units > 0);
  if (!items.length && !d.note){ alert('Nothing to save yet.'); return; }

  // Last chance to catch a thumb that leaned on a button. Asked before saving
  // rather than reported afterwards, because he is still standing next to the
  // pallet and can look.
  const src = simpleSrc();
  const odd = items.filter(x => {
    const it = src?.items.find(y => y.item_name === x.name);
    return it && x.cases > (Number(it.qty) || 0);
  });
  if (odd.length && !confirm('Check these before saving:\n\n'
      + odd.map(x => {
          const it = src.items.find(y => y.item_name === x.name);
          return `${x.name}\n  you put ${fmtQty(x.cases)}, the pallet had ${fmtQty(it.qty)}`;
        }).join('\n\n')
      + '\n\nSave anyway? Press cancel to go back and fix it.')) return;

  let res;
  try {
    res = await fetch(`/api/place/warehouse/pickup`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ run_id: d.run_id, items, note: d.note || null })
    });
  } catch {
    alert('No signal here. What you took is saved on this phone.\n\n'
      + 'Open this again when you are back at the store and press Done.');
    return;
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok){ alert(body.error || 'Could not save that. Try again in a moment.'); return; }
  clearDraft();
  simplePallet = null;
  simpleSaved = items.length;
  // Refresh underneath, but the flag keeps the confirmation on screen until he
  // says he is doing something else.
  await showWarehouse('warehouse').catch(() => {});
  renderSimple();
}

async function simpleRestart(){
  simpleSaved = null; simplePallet = null;
  await showWarehouse('warehouse').catch(() => renderSimple());
}

// Loading the van. One screen, every item in walk order, a box for how many you
// took -- no drilling into cards, because a bulk pickup is thirty of them.
//
// All of it assumes there is no signal at the storage unit. The item list is
// kept from the last time the phone had a connection, what you type is written
// to the phone on every keystroke, and the run is posted whenever the network
// comes back. Nothing is lost by walking out of range mid-pickup.
const PICK_LIST = 'dm_pick_list';      // the last good copy of the warehouse
const PICK_DRAFT = 'dm_pick_draft';    // what has been typed but not yet sent

let whPicking = false;
function whStartPick(){ whPicking = true; whGroup = null; window.scrollTo(0,0); renderWarehouse(); }
function whStopPick(){ whPicking = false; simplePallet = null; simpleReveal = null; renderWarehouse(); }

function pickDraft(){
  try { return JSON.parse(localStorage.getItem(PICK_DRAFT) || 'null') || newDraft(); }
  catch { return newDraft(); }
}
function newDraft(){
  // The id is made here, not by the server: the phone may be posting this run
  // for the first time long after it was typed, and it has to be the same id on
  // a retry so a second attempt cannot take the stock twice.
  return { run_id: 'run-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,8),
           started: new Date().toISOString(), lines: {} };
}
function saveDraft(d){ try { localStorage.setItem(PICK_DRAFT, JSON.stringify(d)); } catch {} }
function clearDraft(){ try { localStorage.removeItem(PICK_DRAFT); } catch {} }

// Whatever the warehouse looked like last time we could reach it.
function cacheList(){
  try {
    localStorage.setItem(PICK_LIST, JSON.stringify({
      at: new Date().toISOString(),
      items: whStock.map(r => ({ item_name: r.item_name, brand: r.brand, size: r.size,
                                 category: r.category, qty: r.qty, unit: r.unit,
                                 pack_size: r.pack_size, unit_name: r.unit_name })),
      cats: whCats.map(c => c.name)
    }));
  } catch {}
}
function cachedList(){
  try { return JSON.parse(localStorage.getItem(PICK_LIST) || 'null'); } catch { return null; }
}

function whScrapPick(){
  const d = pickDraft();
  const n = Object.keys(d.lines).length;
  if (n && !confirm(`Throw away ${n} line${n === 1 ? '' : 's'}? Nothing has been taken off the warehouse yet.`)) return;
  clearDraft();
  if (me?.simple_mode){ simplePallet = null; renderSimple(); } else whStopPick();
}

// Everything the storage unit is short of, which is the job Angel's column G
// does and the reason he kept the spreadsheet. Grouped and copyable in the same
// shape as the other tabs, so an order goes out the same way everywhere.
let whOrderView = false;
function whShowOrder(){ whOrderView = true; window.scrollTo(0, 0); renderWarehouse(); }
function whHideOrder(){ whOrderView = false; renderWarehouse(); }

function shortList(){
  return whStock.map(r => ({ row: r, s: shortOf(r) })).filter(x => x.s)
    .sort((a, b) => (a.row.category || '~').localeCompare(b.row.category || '~')
                 || a.row.item_name.localeCompare(b.row.item_name));
}

function renderOrder(){
  const wrap = $('whWrap');
  whSummaryLine();
  const list = shortList();
  const withPar = whStock.filter(r => r.par !== null && r.par !== undefined).length;

  if (!list.length){
    wrap.innerHTML = `<div class="whsync"><button class="vorilink" onclick="whHideOrder()">&larr; ${place().sections}</button></div>
      <div class="emptystate">${withPar
        ? 'Nothing is under its par. Nothing to order.'
        : 'No pars set yet, so nothing can be short. Open an item and set how many the warehouse should keep.'}</div>`;
    return;
  }
  let last = null;
  const rows = list.map(({ row, s }) => {
    const head = row.category !== last
      ? `<div class="palhead"><div class="palname">${htmlEsc(row.category || 'No pallet')}</div></div>` : '';
    last = row.category;
    return head + `<div class="whrow short">
      <div class="whtop">
        <span class="whname">${htmlEsc(row.item_name)}</span>
        <span class="whqty"><b>${fmtQty(s.short)}</b> <span class="whunit">short</span></span>
      </div>
      ${brandLine(row)}
      <div class="parline short">have ${fmtQty(s.have)} &middot; par ${fmtQty(s.par)}</div>
    </div>`;
  }).join('');

  wrap.innerHTML = `<div class="whsync"><button class="vorilink" onclick="whHideOrder()">&larr; ${place().sections}</button></div>
    <div class="hint"><b>${list.length}</b> of ${withPar} items with a par are under it.</div>
    <button class="addbtn" style="width:100%;margin-bottom:10px;" onclick="whCopyOrder()">Copy this order</button>
    <div class="hint" id="whOrderMsg"></div>${rows}`;
}

function whCopyOrder(){
  const d = new Date();
  const lines = [`Dat Moi Warehouse Order - ${d.getMonth() + 1}/${d.getDate()}`];
  let last = null;
  shortList().forEach(({ row, s }) => {
    if (row.category !== last){ lines.push('', row.category || 'No pallet'); last = row.category; }
    lines.push(`${row.item_name}: ${fmtQty(s.short)}`);
  });
  const text = lines.join('\n');
  const done = ok => { const m = $('whOrderMsg'); if (m) m.textContent = ok ? 'Copied.' : text; };
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => done(true), () => done(false));
  else done(false);
}

// The front of Offsite: the pallets, what is on each, and whether those numbers
// are worth believing. No form, no ledger -- somebody opening this tab wants to
// know whether the warehouse has something, and this is the shortest way there.
function renderShelfList(){
  const wrap = $('whWrap');
  whSummaryLine();
  const edit = canEdit(whLoc);
  const groups = whGroups(whStock);

  const card = g => {
    const stale = g.rows.filter(r => ageOf(r).band === 'stale').length;
    const aging = g.rows.filter(r => ageOf(r).band === 'aging').length;
    // A pallet is only as trustworthy as its worst-counted item.
    const band = !g.rows.length ? 'open' : stale ? 'stale' : aging ? 'aging' : 'fresh';
    const trust = !g.rows.length ? 'nothing on it yet'
      : stale ? `<b>${stale}</b> not counted in a month`
      : aging ? `<b>${aging}</b> counted over a week ago`
      : 'all counted this week';
    const under = g.rows.filter(r => shortOf(r)).length;
    const names = g.rows.slice(0, 4).map(r => htmlEsc(r.item_name)).join(', ')
      + (g.rows.length > 4 ? `, and ${g.rows.length - 4} more` : '');
    return `<button class="shelf ${band}" onclick="whOpenGroup('${esc(g.name)}')">
      <div class="shelftop">
        <span class="shelfname">${g.name ? htmlEsc(g.name) : 'Not on a pallet yet'}</span>
        <span class="shelfcount">${g.rows.length}</span>
      </div>
      <div class="shelftrust ${band}">${
        (whCats.find(x => x.name === g.name) || {}).pallets
          ? `<b class="pwhere">${htmlEsc((whCats.find(x => x.name === g.name) || {}).pallets)}</b> &middot; ` : ''
        }${trust}${under ? ` &middot; <b class="short">${under} under par</b>` : ''}</div>
      ${names ? `<div class="shelfnames">${names}</div>` : ''}
    </button>`;
  };

  // An empty warehouse used to be fine, because the add form sat on this screen.
  // Once it moved onto a pallet, a warehouse with no pallets had nothing to tap
  // and no way in -- the screen just said "tap a pallet" at somebody who had
  // none. So say what is actually going on, and offer the way forward.
  if (!whStock.length && !groups.length){
    wrap.innerHTML = whViewToggle() + `
      <div class="emptystate">
        <b>Nothing in the offsite warehouse yet.</b>
        <div>${edit
          ? 'Add the first thing below, or set up your pallets first and add onto them.'
          : 'Somebody with warehouse access needs to put the first items in.'}</div>
      </div>`
      + (edit ? `<button class="listlink" style="margin-top:12px;" onclick="whShowPallets()">Set up pallets</button>` : '')
      + addFoldHtml(edit, '');
    return;
  }

  const short = shortList().length;
  // A run typed at the warehouse and never sent is the one thing worth
  // interrupting for: the stock has left the building but the app still counts it.
  const draft = pickDraft();
  const unsent = Object.values(draft.lines).filter(v => Number(v.cases) > 0 || Number(v.units) > 0).length;
  wrap.innerHTML = whViewToggle()
    + (edit && unsent
        ? `<button class="orderbtn unsent" onclick="whStartPick()">
             <b>${unsent}</b> item${unsent === 1 ? '' : 's'} loaded but not saved &mdash; finish the pickup</button>`
        : '')
    + (edit && !unsent
        ? `<button class="pickbtn" onclick="whStartPick()">Loading the van &mdash; log a pickup</button>`
        : '')
    + (short
        ? `<button class="orderbtn" onclick="whShowOrder()">
             <b>${short}</b> item${short === 1 ? '' : 's'} under par &mdash; see what to order</button>`
        : '')
    + `<div class="hint">Tap a pallet to see what is on it. Or search above for one thing.</div>`
    + `<div class="shelves">${groups.map(card).join('')}</div>`
    + (edit ? `<button class="listlink" style="margin-top:12px;" onclick="whShowPallets()">Add or rename a pallet</button>` : '')
    + addFoldHtml(edit, '')
    + runsHtml(5)
    + moveLogHtml(6);
}

function renderWarehouse(){
  // Set on every render, not on load: starting a pickup only re-renders, so
  // doing this in showWarehouse left the search box on screen through the whole
  // pickup and then hid it again afterwards.
  const picking = !place().diagram && (whPicking || !!me?.simple_mode);
  document.body.classList.toggle('picking', picking);
  $('whTitle').textContent = picking ? 'Taking things' : place().title;
  if (whLinking) return renderLinkPanel();
  if (whPallets) return renderPallets();
  if (whView === 'table' && !place().diagram) return renderTable();
  const searching = !!($('whSearch').value || '').trim();
  // Offsite opens on its pallets, the way Monkish opens on its containers: the
  // tab is for finding out what is out there, and a wall of every item at once
  // never answered that. Searching skips the pallets and answers straight.
  // One pickup screen, and it is Andy's. Simple mode is not a cut-down version
  // for him -- it is the same screen with the rest of the app taken away. If it
  // is easy enough for somebody who does not use computers it is easy for
  // everyone, and there is one thing to build, teach and get wrong instead of two.
  if (!place().diagram && (whPicking || me?.simple_mode)) return renderSimple();
  if (!place().diagram && whOrderView && !searching) return renderOrder();
  if (!place().diagram && whGroup === null && !searching) return renderShelfList();
  if (place().diagram && whContainer === null && !searching) return renderDiagram();
  if (place().diagram && whContainer && whContainer !== '*' && !searching){
    if (whPallet === null) return renderContainerPlan();
    if (whPallet !== 'none') return renderPalletForm();
  }
  const q = ($('whSearch').value || '').trim().toLowerCase();
  const wrap = $('whWrap');
  const whEdit = canEdit(whLoc);
  // '*' is the flat list, null is the unassigned pile — neither is a container
  // to add into.
  const inContainer = (place().diagram && whContainer && whContainer !== '*') ? whContainer : null;
  // On Offsite the open pallet plays the same part: what you add here lands on it.
  const inShelf = (!place().diagram && whGroup !== null && whGroup !== '') ? whGroup : null;
  whSummaryLine();

  let shown = whStock.filter(r => !q || r.item_name.toLowerCase().includes(q));
  if (!place().diagram && whGroup !== null && !q){
    shown = whGroup === ''
      ? shown.filter(r => !r.category || !whCats.some(c => c.name === r.category))
      : shown.filter(r => r.category === whGroup);
  }
  if (place().diagram && whContainer !== null && whContainer !== '*' && !q){
    shown = shown.filter(r => (r.category || null) === whContainer);
    if (whPallet === 'none') shown = shown.filter(r => !r.pallet_id);
    else if (whPallet !== null) shown = shown.filter(r => Number(r.pallet_id) === Number(whPallet));
  }
  // Looking something up is not the moment to be shown a blank form. On Offsite
  // the form belongs on one pallet, which is the only place it has an answer for
  // "which pallet?" anyway.
  const lookingUp = !place().diagram && (!!q || whGroup === null);
  const offerAdd = whEdit && !lookingUp;
  const addForm = offerAdd ? addFormHtml(inContainer || inShelf) : '';

  // Offsite puts the form under the boxes and folded shut: you open a pallet to
  // see what is on it far more often than to put something new on it. Monkish
  // keeps its own order, which people are already used to.
  const foldAdd = !place().diagram;
  wrap.innerHTML = (!place().diagram && whGroup === null ? whViewToggle() : '')
    + (lookingUp ? '' : !whEdit ? `<div class="rowarn">${place().noEdit}</div>` : '')
    + (q ? `<div class="hint">${shown.length} match${shown.length === 1 ? '' : 'es'} for &ldquo;${htmlEsc(q)}&rdquo;.</div>` : '')
    + (foldAdd ? '' : addForm);

  if (!shown.length && q){
    wrap.insertAdjacentHTML('beforeend', '<div class="emptystate">Nothing matches that.</div>');
  }

  const renderRow = row => {
    const age = ageOf(row);
    const div = document.createElement('div');
    div.className = 'whrow ' + age.band;
    const open = whOpen === row.item_name;
    div.innerHTML = `
      <div class="whtop">
        <span class="whname">${htmlEsc(row.item_name)}</span>
        <span class="whqty">${stockLine(row)}</span>
      </div>
      ${brandLine(row)}
      <div class="whage ${age.band}">${htmlEsc(age.text)}</div>
      ${parLine(row)}
      ${whereLine(row)}
      ${row.pack_size ? `<div class="whtotal">${totalLine(row)}</div>` : ''}
      ${voriBlock(row)}
      ${open ? `
        <div class="whform">
          <input type="tel" inputmode="decimal" class="whcases" placeholder="${htmlEsc(row.unit || 'cases')}">
          ${row.pack_size
            ? `<input type="tel" inputmode="decimal" class="whunits" placeholder="${htmlEsc(row.unit_name || 'units')}">`
            : ''}
        </div>
        <div class="whacts">
          <button onclick="whMove('${esc(row.item_name)}','counted')">I counted it</button>
          <button onclick="whMove('${esc(row.item_name)}','added')">Dropped off</button>
          <button onclick="whMove('${esc(row.item_name)}','taken')">Took some</button>
        </div>
        ${place().diagram ? '' : `
        <div class="whpick" style="margin-top:9px;padding-left:0;">How many should the warehouse keep?</div>
        <div class="whform">
          <input type="tel" inputmode="decimal" class="whpar" placeholder="par"
                 value="${row.par === null || row.par === undefined ? '' : fmtQty(row.par)}">
          <button class="whpackset" onclick="whSetPar('${esc(row.item_name)}')">Set</button>
        </div>`}
        <div class="whpick" style="margin-top:9px;padding-left:0;">Which ${place().section} is this in?</div>
        <div class="whform">
          <input type="text" class="whcat" list="whCatList" value="${htmlEsc(row.category || '')}" placeholder="category">
          <button class="whpackset" onclick="whSetCat('${esc(row.item_name)}')">Move</button>
        </div>
        ${row.pack_size ? '' : `
        <div class="whpick" style="margin-top:9px;padding-left:0;">Does anyone pick single ones off this?</div>
        <div class="whform">
          <input type="tel" inputmode="decimal" class="whpack" placeholder="how many inside">
          <input type="text" class="whpackname" placeholder="bottles / packs">
          <button class="whpackset" onclick="whSetPack('${esc(row.item_name)}')">Set</button>
        </div>`}`
      : (canEdit(whLoc)
          ? `<div class="whacts"><button onclick="whToggle('${esc(row.item_name)}')">Update</button></div>`
          : '')}`;
    return div;
  };

  // Searching flattens the groups — you want the item, not the tour. So does
  // standing on one pallet, where every heading would say the same thing.
  if (q || (!place().diagram && whGroup !== null)){
    shown.forEach(row => wrap.appendChild(renderRow(row)));
  } else {
    whGroups(shown).forEach(g => {
      const stale = g.rows.filter(r => ageOf(r).band === 'stale').length;
      const head = document.createElement('div');
      head.className = 'palhead' + (g.name ? '' : ' loose');
      head.innerHTML = `
        <div class="palname">${g.name ? htmlEsc(g.name) : `Not in a ${place().section} yet`}</div>
        <div class="palmeta">${g.pallets ? htmlEsc(g.pallets) + ' &middot; ' : ''}${g.rows.length} item${g.rows.length===1?'':'s'}${stale ? ` &middot; <b>${stale}</b> stale` : ''}</div>`;
      wrap.appendChild(head);
      if (!g.rows.length){
        wrap.insertAdjacentHTML('beforeend', `<div class="palempty">Nothing in this ${place().section} yet.</div>`);
      }
      g.rows.forEach(row => wrap.appendChild(renderRow(row)));
    });
  }

  if (foldAdd && offerAdd) wrap.insertAdjacentHTML('beforeend', addFoldHtml(true, inShelf || ''));
  if (!q){
    wrap.insertAdjacentHTML('beforeend', runsHtml(8));
    wrap.insertAdjacentHTML('beforeend', moveLogHtml(25));
  }
}

// Who changed what, most recent first. Short on the pallet list, longer once you
// are inside a pallet and actually chasing a number.
// A pickup is a trip, so it is shown as one. Before this the ledger listed eight
// separate "Andy took two cases" lines and you had to notice they shared a
// minute; the run id means it can say what it is.
function runsHtml(limit){
  const runs = new Map();
  whMoves.filter(m => m.run_id).forEach(m => {
    const r = runs.get(m.run_id) || { id: m.run_id, who: m.moved_by, at: m.moved_at, note: m.note, lines: [] };
    if (new Date(m.moved_at) < new Date(r.at)) r.at = m.moved_at;
    r.note = r.note || m.note;
    r.lines.push(m);
    runs.set(m.run_id, r);
  });
  if (!runs.size) return '';
  const list = [...runs.values()]
    .sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, limit);
  return `<div class="vsummarybar" style="margin-top:20px;">
      <div class="vs-title">Brought back to the store</div>
      <div class="vs-sub">each trip, most recent first</div></div>`
    + list.map(r => {
        const when = new Date(r.at).toLocaleDateString('en-US',
          { weekday: 'short', month: 'short', day: 'numeric' });
        const open = whOpenRun === r.id;
        return `<div class="runrow ${open ? 'open' : ''}">
          <button class="runhead" onclick="whToggleRun('${esc(r.id)}')">
            <span class="runwhen">${when}</span>
            <span class="runwho">${htmlEsc(r.who || 'someone')}</span>
            <span class="runn">${r.lines.length} item${r.lines.length === 1 ? '' : 's'}</span>
          </button>
          ${r.note ? `<div class="runnote"><b>Note:</b> ${htmlEsc(r.note)}</div>` : ''}
          ${open ? `<div class="runlines">${r.lines.map(m => {
              const c = Math.abs(Number(m.delta) || 0), u = Math.abs(Number(m.delta_units) || 0);
              const bits = [c ? `${fmtQty(c)} case${c === 1 ? '' : 's'}` : null,
                            u ? `${fmtQty(u)} loose` : null].filter(Boolean).join(' + ') || 'nothing';
              return `<div class="runline"><span>${htmlEsc(m.item_name)}</span><b>${bits}</b></div>`;
            }).join('')}</div>` : ''}
        </div>`;
      }).join('');
}

function whToggleRun(id){ whOpenRun = whOpenRun === id ? null : id; renderWarehouse(); }
let whOpenRun = null;

function moveLogHtml(limit){
  if (!whMoves.length) return '';
  const amount = (c, u) => [
    Number(c) ? `${fmtQty(Math.abs(c))} case${Math.abs(Number(c)) === 1 ? '' : 's'}` : null,
    Number(u) ? `${fmtQty(Math.abs(u))} loose` : null
  ].filter(Boolean).join(' and ') || 'nothing';
  const loose = whMoves.filter(m => !m.run_id);
  if (!loose.length) return '';
  const lines = loose.slice(0, limit).map(m => {
    const when = new Date(m.moved_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const left = `now ${fmtQty(m.qty_after)}${Number(m.units_after) ? ` + ${fmtQty(m.units_after)}` : ''}`;
    const what = m.kind === 'counted'
        ? `counted <b>${htmlEsc(m.item_name)}</b> at ${fmtQty(m.qty_after)}${Number(m.units_after) ? ` + ${fmtQty(m.units_after)}` : ''}`
      : m.kind === 'added' ? `dropped off ${amount(m.delta, m.delta_units)} of <b>${htmlEsc(m.item_name)}</b> (${left})`
      : m.kind === 'taken' ? `took ${amount(m.delta, m.delta_units)} of <b>${htmlEsc(m.item_name)}</b> (${left})`
      : `removed <b>${htmlEsc(m.item_name)}</b>`;
    return `<div class="whmove">${when} &middot; ${htmlEsc(m.moved_by || 'someone')} ${what}</div>`;
  }).join('');
  return `<div class="vsummarybar" style="margin-top:20px;">
      <div class="vs-title">Everything else</div>
      <div class="vs-sub">counts and one-off changes, most recent first</div></div>${lines}`;
}

// The three numbers, with the age of each. A difference is only as trustworthy
// as the older of the two figures it came from, so both are shown.
function voriBlock(row){
  if (!whVori.configured) return '';
  if (!row.vori_product_id){
    return `<div class="vorirow unlinked">
      <span>Not linked to Vori</span>
      ${canEdit(whLoc) ? `<button class="vorilink" onclick="whStartLink('${esc(row.item_name)}')">Link</button>` : ''}</div>`;
  }
  const s = splitOf(row);
  if (!s){
    return `<div class="vorirow unlinked"><span>Linked, waiting for the first sync</span>
      <button class="vorilink" onclick="whUnlink('${esc(row.item_name)}')">Unlink</button></div>`;
  }
  if (s.blocked){
    return `<div class="vorirow unlinked"><span>Vori says ${fmtQty(s.total)} &mdash; ${s.blocked} to compare</span></div>`;
  }
  const negative = s.onsite < 0;
  const hrs = row.vori_hours_old === null ? null : Number(row.vori_hours_old);
  const age = hrs === null ? '' : hrs < 1 ? 'just synced' : hrs < 48 ? `${Math.round(hrs)}h ago` : `${Math.round(hrs/24)}d ago`;
  return `
    <div class="voritrio">
      <div class="vcell"><div class="vnum">${fmtQty(s.total)}</div><div class="vlab">Vori, all in</div></div>
      <div class="vop">&minus;</div>
      <div class="vcell"><div class="vnum">${fmtQty(s.warehouse)}</div>
        <div class="vlab">${s.places > 1 ? 'held offsite' : 'here'}</div></div>
      <div class="vop">=</div>
      <div class="vcell ${negative ? 'bad' : 'onsite'}">
        <div class="vnum">${negative ? '?' : fmtQty(s.onsite)}</div><div class="vlab">at the store</div></div>
    </div>
    ${negative
      ? `<div class="voriwarn">More is held offsite than Vori says exists at all.
         One of the two is out of date &mdash; recount, or check Vori.</div>`
      : `<div class="whtotal">in ${htmlEsc(s.unit)} &middot; Vori ${htmlEsc(age)}${
          s.places > 1 ? ` &middot; ${fmtQty(s.here)} of it here, the rest in another place` : ''}</div>`}
    <div class="vorirow"><span class="vorilinked">Vori: ${htmlEsc(row.vori_name || row.vori_product_id)}</span>
      ${canEdit(whLoc) ? `<button class="vorilink" onclick="whUnlink('${esc(row.item_name)}')">Unlink</button>` : ''}</div>`;
}

function whToggle(name){
  if (!canEdit(whLoc)) return;
  whOpen = whOpen === name ? null : name;
  renderWarehouse();
}

// ---- linking a warehouse line to a Vori product ----
function whStartLink(name){ whLinking = { name, results: null, error: null }; renderLinkPanel(); }
function whCancelLink(){ whLinking = null; renderWarehouse(); }

function renderLinkPanel(){
  const wrap = $('whWrap');
  const l = whLinking;
  wrap.innerHTML = `
    <div class="vsummarybar"><div class="vs-title">Link to Vori</div>
      <div class="vs-sub">${htmlEsc(l.name)}</div></div>
    <div class="hint">Search Vori's catalogue and pick the product this is. Until it
    is linked there is nothing to subtract from.</div>
    <div class="whform">
      <input type="text" class="textinput" id="voriQ" placeholder="Search Vori...">
      <button class="whpackset" onclick="whSearchVori()">Search</button>
    </div>
    <div class="hint" id="voriMsg">${l.error ? htmlEsc(l.error) : ''}</div>
    <div id="voriResults">${(l.results || []).map(p => `
      <div class="whrow" style="border-left-color:var(--line);">
        <div class="whtop"><span class="whname">${htmlEsc(p.name)}</span></div>
        ${p.barcode ? `<div class="whtotal">${htmlEsc(p.barcode)}</div>` : ''}
        <div class="whacts"><button onclick="whDoLink('${esc(p.id)}','${esc(p.name)}')">This one</button></div>
      </div>`).join('')}</div>
    <button class="addbtn" style="width:100%;margin-top:10px;" onclick="whCancelLink()">Back</button>`;
  if (l.results === null) setTimeout(() => $('voriQ')?.focus(), 50);
}

async function whSearchVori(){
  const q = $('voriQ').value.trim();
  $('voriMsg').textContent = 'Searching...';
  const r = await fetch('/api/vori/search?q=' + encodeURIComponent(q)).then(x => x.json()).catch(() => null);
  if (!r || r.error){ whLinking.error = r?.error || 'Could not reach Vori.'; whLinking.results = []; }
  else { whLinking.results = r.products; whLinking.error = r.products.length ? null : 'Nothing matched.'; }
  renderLinkPanel();
}

async function whDoLink(id, name){
  await fetch('/api/place/' + whLoc + '/item/' + encodeURIComponent(whLinking.name) + '/vori', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vori_product_id: id, vori_name: name })
  });
  whLinking = null;
  await showWarehouse();
}

async function whUnlink(name){
  await fetch('/api/place/' + whLoc + '/item/' + encodeURIComponent(name) + '/vori', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vori_product_id: null, vori_name: null })
  });
  await showWarehouse();
}

async function whSync(){
  const el = $('whSyncMsg');
  if (el) el.textContent = 'Asking Vori...';
  const r = await fetch('/api/vori/sync', { method: 'POST', headers: {'Content-Type':'application/json'}, body: '{}' })
    .then(x => x.json()).catch(() => null);
  if (!r || r.error){ if (el) el.textContent = r?.error || 'Sync failed.'; return; }
  await showWarehouse();
}

async function whAdd(){
  const name = $('whNewName').value.trim();
  if (!name){ $('whMsg').textContent = 'Give it a name first.'; return; }
  const res = await fetch('/api/place/' + whLoc + '/item', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      unit: $('whNewUnit').value.trim(),
      qty: $('whNewQty').value.trim(),
      pack_size: $('whNewPack').value.trim(),
      unit_name: $('whNewUnitName').value.trim(),
      category: $('whNewCat').value.trim()
    })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok){ $('whMsg').textContent = body.error || 'Could not add that.'; return; }
  await showWarehouse();
}

async function whMove(name, kind){
  const cases = document.querySelector('.whcases')?.value.trim() || '';
  const units = document.querySelector('.whunits')?.value.trim() || '';
  // Counting zero is a real answer — none left. Moving nothing is not.
  if (kind !== 'counted' && cases === '' && units === '') return;
  const res = await fetch('/api/place/' + whLoc + '/move', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ item_name: name, kind, cases: cases || 0, units: units || 0 })
  });
  if (res.ok){ whOpen = null; await showWarehouse(); }
}

async function whSetCat(name){
  const category = document.querySelector('.whcat')?.value.trim() ?? '';
  await fetch('/api/place/' + whLoc + '/item/' + encodeURIComponent(name) + '/category', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ category })
  });
  whOpen = null;
  await showWarehouse();
}

// ---- pallets ----
function whShowPallets(){ whPallets = true; renderWarehouse(); }
function whClosePallets(){ whPallets = false; renderWarehouse(); }

function renderPallets(){
  const counts = {};
  whStock.forEach(r => { if (r.category) counts[r.category] = (counts[r.category] || 0) + 1; });
  const loose = whStock.filter(r => !r.category).length;
  $('whWrap').innerHTML = `
    <div class="vsummarybar"><div class="vs-title">${place().sections.replace(/^./, c => c.toUpperCase())}</div>
      <div class="vs-sub">${whCats.length} ${place().sections}${loose ? ` &middot; ${loose} item${loose===1?'':'s'} in none of them` : ''}</div></div>
    <div class="hint">Order these the way you walk the place and counting follows your
    feet. ${whLoc === 'warehouse'
      ? 'Put whatever is written on the pallet in the box &mdash; a number, a bay, "3 and 4" '
        + 'if the group spans two. It shows next to the name everywhere, so people can match '
        + 'the app to the floor. Nothing needs it, and the sheet never overwrites it.'
      : 'Put whatever is written on the container in the box, or the temperature.'}</div>
    <div class="vgroup">
      <div class="vgroup-head" style="cursor:default;"><div class="oldname">Add a ${place().section}</div></div>
      <div class="vitem">
        <input type="text" class="textinput" id="newCatName" placeholder="${whLoc === 'warehouse' ? 'e.g. Rice' : 'e.g. Container 1'}">
        <input type="text" class="textinput" id="newCatPallets" placeholder="${place().sectionLabel}">
      </div>
    </div>
    <button class="addbtn" style="width:100%;margin-bottom:12px;" onclick="whAddCat()">Add</button>
    <div class="hint" id="catMsg"></div>
    ${whCats.map((c, i) => `
      <div class="vgroup">
        <div class="vgroup-head" style="cursor:default;">
          <div class="oldname">${htmlEsc(c.name)} <span class="chip">${counts[c.name] || 0}</span></div>
          <div>
            <button class="vorilink" ${i === 0 ? 'disabled' : ''} onclick="whMoveCat('${esc(c.name)}','up')">&uarr;</button>
            <button class="vorilink" ${i === whCats.length - 1 ? 'disabled' : ''} onclick="whMoveCat('${esc(c.name)}','down')">&darr;</button>
          </div>
        </div>
        <div class="whform">
          <input type="text" class="textinput catpal" data-cat="${htmlEsc(c.name)}"
                 value="${htmlEsc(c.pallets || '')}" placeholder="${place().sectionLabel}"
                 onchange="whSetPallets('${esc(c.name)}', this.value)">
          <button class="vorilink" onclick="whDelCat('${esc(c.name)}')">Remove</button>
        </div>
        ${whLoc === 'warehouse' ? `<div class="vitem">
          <span class="viname">We take half cases or loose packs from this one
            <span class="vihint">off for most pallets &mdash; it only adds buttons where they get used</span></span>
          <input type="checkbox" ${c.part_cases ? 'checked' : ''} style="width:22px;height:22px;"
                 onchange="whSetParts('${esc(c.name)}', this.checked)"></div>` : ''}
      </div>`).join('')}
    <button class="addbtn" style="width:100%;margin-top:10px;" onclick="whClosePallets()">Back to the warehouse</button>`;
}

async function whSetParts(name, on){
  await fetch(`/api/place/${whLoc}/category/${encodeURIComponent(name)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ part_cases: !!on })
  });
  await showWarehouse();
  whPallets = true; renderWarehouse();
}

async function whAddCat(){
  const name = $('newCatName').value.trim();
  if (!name){ $('catMsg').textContent = 'Give it a name first.'; return; }
  const res = await fetch('/api/place/' + whLoc + '/category', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, pallets: $('newCatPallets').value.trim() })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok){ $('catMsg').textContent = body.error || 'Could not add that.'; return; }
  await showWarehouse();
}
async function whSetPallets(name, pallets){
  await fetch('/api/place/' + whLoc + '/category/' + encodeURIComponent(name), {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pallets })
  });
  await showWarehouse();
}
async function whMoveCat(name, move){
  await fetch('/api/place/' + whLoc + '/category/' + encodeURIComponent(name), {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ move })
  });
  await showWarehouse();
}
async function whDelCat(name){
  const res = await fetch('/api/place/' + whLoc + '/category/' + encodeURIComponent(name), { method: 'DELETE' });
  if (!res.ok){ const b = await res.json().catch(()=>({})); $('catMsg').textContent = b.error || 'Could not remove that.'; return; }
  await showWarehouse();
}

async function whSetPack(name){
  const pack = document.querySelector('.whpack')?.value.trim();
  const unit_name = document.querySelector('.whpackname')?.value.trim();
  if (!pack) return;
  const res = await fetch('/api/place/' + whLoc + '/item/' + encodeURIComponent(name), {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pack_size: pack, unit_name })
  });
  if (res.ok) await showWarehouse();
}

// ---- backup ----
function showBackup(){
  hideAll(); $('backupView').style.display = 'block'; $('footerBar').style.display = 'none';
  $('backupWrap').innerHTML = `
    <div class="vsummarybar">
      <div class="vs-title">Backup</div>
      <div class="vs-sub">Every department, not just this one</div>
    </div>
    <div class="hint">Saves one file holding every item, PAR, vendor, count, route
    and past order. Deploying never removes anything, so this is for the times
    something is being cleared out on purpose &mdash; emptying a department to load
    a fresh list, most of all. Take one first and nothing is unrecoverable.</div>
    <button class="addbtn" style="width:100%;" onclick="downloadBackup()">Download a backup</button>
    <div class="hint" id="backupMsg" style="padding-top:12px;"></div>`;
}
function downloadBackup(){
  $('backupMsg').textContent = 'Saving...';
  // A plain navigation, so the browser handles it as a download rather than the
  // page trying to hold the whole database in memory.
  window.location.href = '/api/export';
  setTimeout(() => { $('backupMsg').textContent =
    'Saved. Keep it somewhere off the phone — email it to yourself is fine.'; }, 1200);
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

boot();
