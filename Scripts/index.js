// ============================================================
// CHURCH DASHBOARD MAP — script.js
// Supports two view modes: District and Church
// Data source: Supabase (read-only via anon public key)
// ============================================================

// ===== ENDPOINTS =====
const ENDPOINTS = {
  district: `${SUPABASE_URL}/rest/v1/districts?select=id,mission_id,name,leader_name,address,contact,latitude,longitude,profile_photo_url,churches(count)`,
  // contact and photo_url must be added to churches table first — see SQL below
  church:   `${SUPABASE_URL}/rest/v1/churches?select=id,district_id,name,address,latitude,longitude,districts(name,mission_id)`,
  missions: `${SUPABASE_URL}/rest/v1/missions?select=id,code,name`
};

// ===== STATE =====
let map, clusterGroup;
let activeMarkerId = null;
let currentView    = 'district';
let activeMission  = null;        // null = All
let ALL_DATA       = [];
let filteredData   = [];
let refreshTimer   = null;
let MISSIONS       = [];          // [{id, code, name}]
let DISTRICT_MAP   = {};          // district_id → mission_id (for church view)
const TITHES_YEARS = [2026, 2025];

// ===== SUPABASE FETCH =====
async function fetchFromSupabase(view) {
  const path = ENDPOINTS[view].replace(`${SUPABASE_URL}/rest/v1/`, '');
  console.log(`[Fetch] ${view}`);
  const json = await supabaseFetch(path);
  console.log(`[Data] ${view} rows received:`, json.length);
  return json;
}

// ===== NORMALIZE — DISTRICT ROW =====
function normalizeDistrict(row) {
  const lat = parseFloat(row.latitude);
  const lng = parseFloat(row.longitude);
  if (isNaN(lat) || isNaN(lng)) {
    console.warn(`[Skip] District "${row.name}" (id:${row.id}) has invalid coordinates:`, row.latitude, row.longitude);
  }
  const assignedChurches = Array.isArray(row.churches) && row.churches[0]
    ? row.churches[0].count : 0;
  return {
    id:           row.id,
    mission_id:   row.mission_id        || null,
    pastor:       row.leader_name       || '—',
    name:         row.name              || '—',
    district:     row.name              || '—',
    address:      row.address           || '—',
    contact:      row.contact           || '—',
    lat, lng,
    pastor_image: row.profile_photo_url || null,
    members:      assignedChurches,
    tithes:       0,
    sheets_url:   '#',
    updated:      '—'
  };
}

// ===== NORMALIZE — CHURCH ROW =====
// Actual columns: id, district_id, name, address, latitude, longitude
// districts(name, mission_id) embedded via FK
function normalizeChurch(row) {
  const lat = parseFloat(row.latitude);
  const lng = parseFloat(row.longitude);
  if (isNaN(lat) || isNaN(lng)) {
    console.warn(`[Skip] Church "${row.name}" (id:${row.id}) missing coordinates:`, row.latitude, row.longitude);
  }
  const districtName = row.districts?.name       || (row.district_id ? `District #${row.district_id}` : '—');
  const missionId    = row.districts?.mission_id || null;
  console.log(`[normalizeChurch] id:${row.id} | name:${row.name} | lat:${lat} | lng:${lng} | district:${districtName}`);
  return {
    id:           row.id,
    mission_id:   missionId,
    pastor:       '—',          // churches table has no pastor column yet
    name:         row.name    || '—',
    district:     districtName,
    address:      row.address || '—',
    contact:      '—',
    lat, lng,
    pastor_image: null,        // never use district photo for church markers
    members:      null,
    tithes:       null,
    sheets_url:   '#',
    updated:      '—'
  };
}

// ===== VIEW TOGGLE =====
function setupViewToggle() {
  const buttons = document.querySelectorAll('.view-btn');
  buttons.forEach(btn => {
    btn.addEventListener('click', async () => {
      if (btn.dataset.view === currentView) return;
      buttons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentView    = btn.dataset.view;
      activeMarkerId = null;
      resetSidebar();
      await loadData();
    });
  });
}

// ===== RESET SIDEBAR PLACEHOLDER =====
function resetSidebar() {
  document.getElementById('church-detail').innerHTML = `
    <div class="detail-placeholder">
      <i class="fas fa-map-marker-alt"></i>
      <p>Click a marker on the map to view details</p>
    </div>`;
}

// ===== INIT =====
document.addEventListener('DOMContentLoaded', async () => {
  initMap();
  setupSearch();
  setupMobileToggle();
  setupViewToggle();
  await fetchMissions();   // load missions first so buttons are ready
  await loadData();
  setupChurchesModal();
  setupTithesModal();
});

// ===== FETCH & BUILD MISSION BUTTONS =====
async function fetchMissions() {
  try {
    MISSIONS = await supabaseFetch('missions?select=id,code,name');
    console.log('[Missions]', MISSIONS);
  } catch (err) {
    // Non-fatal: fall back to hardcoded codes if missions table unavailable
    console.warn('[Missions] Could not fetch, using fallback:', err.message);
    MISSIONS = [
      { id: 1, code: 'NCMC', name: 'NCMC' },
      { id: 2, code: 'CMM',  name: 'CMM'  },
      { id: 3, code: 'NMM',  name: 'NMM'  },
      { id: 4, code: 'WMC',  name: 'WMC'  },
      { id: 5, code: 'ZPM',  name: 'ZPM'  }
    ];
  }
  buildMissionButtons();
}

function buildMissionButtons() {
  const container = document.getElementById('mission-filter');
  container.innerHTML = '';

  // ALL button
  const allBtn = document.createElement('button');
  allBtn.className    = 'mission-btn active';
  allBtn.dataset.id   = '';
  allBtn.textContent  = 'ALL';
  container.appendChild(allBtn);

  // One button per mission
  MISSIONS.forEach(m => {
    const btn = document.createElement('button');
    btn.className   = 'mission-btn';
    btn.dataset.id  = m.id;
    btn.textContent = m.code || m.name;
    container.appendChild(btn);
  });

  // Event delegation on container
  container.addEventListener('click', e => {
    const btn = e.target.closest('.mission-btn');
    if (!btn) return;
    container.querySelectorAll('.mission-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeMission  = btn.dataset.id ? Number(btn.dataset.id) : null;
    activeMarkerId = null;
    applyFilters();
  });
}

// ===== BUILD DISTRICT LOOKUP (for church view mission filtering) =====
async function buildDistrictMap() {
  try {
    const rows = await supabaseFetch('districts?select=id,mission_id');
    DISTRICT_MAP = {};
    rows.forEach(r => { DISTRICT_MAP[r.id] = r.mission_id; });
    console.log('[DistrictMap]', DISTRICT_MAP);
  } catch (err) {
    console.warn('[DistrictMap] Could not build:', err.message);
  }
}

// ===== LOAD & RENDER =====
async function loadData() {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(loadData, 60_000);

  try {
    showLoading(true);
    const rows      = await fetchFromSupabase(currentView);
    const normalize = currentView === 'district' ? normalizeDistrict : normalizeChurch;
    const normalized = rows.map(normalize);
    ALL_DATA     = normalized.filter(r => !isNaN(r.lat) && !isNaN(r.lng));
    filteredData = [...ALL_DATA];
    console.log(`[loadData] view:${currentView} | fetched:${rows.length} | valid:${ALL_DATA.length}`);
    populateDistricts();
    renderStats(ALL_DATA);
    renderMarkers(ALL_DATA);
    renderRecentUpdates(ALL_DATA);
  } catch (err) {
    console.error('[loadData] Error:', err.message);
    showError(`Could not load map data. Open browser console (F12) for details.`);
  } finally {
    showLoading(false);
  }
}

// ===== MAP INIT =====
function initMap() {
  map = L.map('map', {
    center: [7.1907, 125.4553],
    zoom: 7,
    zoomControl: false
  });

  L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 19
  }).addTo(map);

  L.control.zoom({ position: 'bottomright' }).addTo(map);

  clusterGroup = L.markerClusterGroup({
    showCoverageOnHover: false,
    maxClusterRadius: 60
  });
  map.addLayer(clusterGroup);
}

// ===== MARKER ICON =====
function createMarkerIcon(isActive = false, photo = null) {
  const imgContent = photo
    ? `<img src="${photo}" alt="photo" />`
    : `<i class="fas fa-${currentView === 'district' ? 'map' : 'church'}"></i>`;

  return L.divIcon({
    className: '',
    html: `
      <div class="pastor-pin ${isActive ? 'active' : ''}">
        <div class="pastor-pin__photo">${imgContent}</div>
        <div class="pastor-pin__tail"></div>
      </div>`,
    iconSize:    [48, 58],
    iconAnchor:  [24, 58],
    popupAnchor: [0, -62]
  });
}

// ===== RENDER MARKERS =====
function renderMarkers(data) {
  clusterGroup.clearLayers();

  data.forEach(item => {
    const marker = L.marker([item.lat, item.lng], {
      icon: createMarkerIcon(item.id === activeMarkerId, item.pastor_image)
    });

    marker.bindPopup(
      currentView === 'church'
        ? `
          <div class="popup-title">${item.name}</div>
          <div class="popup-sub"><i class="fas fa-map-pin" style="margin-right:4px"></i>${item.address}</div>
          <div class="popup-sub"><i class="fas fa-map" style="margin-right:4px"></i>${item.district}</div>`
        : `
          <div class="popup-title">${item.name}</div>
          <div class="popup-sub"><i class="fas fa-user" style="margin-right:4px"></i>${item.pastor}</div>
          <div class="popup-sub"><i class="fas fa-map-pin" style="margin-right:4px"></i>${item.district}</div>`,
      { maxWidth: 220 }
    );

    marker.on('click', () => {
      activeMarkerId = item.id;
      updateSidebar(item);
      renderMarkers(data);
      map.flyTo([item.lat, item.lng], 14, { duration: 0.8 });
    });

    clusterGroup.addLayer(marker);
  });
}

// ===== TITHES FETCH & CALCULATION =====
async function getTithesFilter(item) {
  if (currentView === 'district') {
    const churches = await supabaseFetch(`churches?select=id&district_id=eq.${item.id}`);
    if (!churches.length) return null;
    return `church_id=in.(${churches.map(c => c.id).join(',')})`;
  }
  return `church_id=eq.${item.id}`;
}

async function fetchFinanceTotal(table, baseFilter, year) {
  if (!baseFilter) return 0;
  const filter = `${baseFilter}&year=eq.${year}`;
  let total = 0, offset = 0;
  const PAGE = 1000;
  while (true) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/${table}?select=amount&${filter}&limit=${PAGE}&offset=${offset}`,
      { headers: SUPABASE_HEADERS }
    );
    if (!res.ok) throw new Error(`${table} fetch ${res.status}`);
    const rows = await res.json();
    rows.forEach(r => { total += Number(r.amount || 0); });
    if (rows.length < PAGE) break;
    offset += PAGE;
  }
  return total;
}


// ===== SIDEBAR UPDATE =====
function updateSidebar(item) {
  const panel = document.getElementById('church-detail');

  // ---- CHURCH VIEW ----
  if (currentView === 'church') {
    panel.innerHTML = `
      <div class="church-card">
        <div class="church-card-header">
          <div class="church-avatar"><i class="fas fa-church"></i></div>
          <div>
            <h2>${item.name}</h2>
            <p>${item.address}</p>
          </div>
        </div>
        <div class="info-grid">
          <div class="info-item">
            <label>District</label>
            <span>${item.district}</span>
          </div>
          <div class="info-item clickable" id="offerings-card">
            <label>OFFERINGS</label>
            <span id="church-offerings-value">Loading...</span>
          </div>
            <div class="info-item clickable" id="tithes-card">
            <label>TITHES</label>
            <span id="church-tithes-value">Loading...</span>
          </div>
        </div>
      </div>`;

    if (window.innerWidth <= 640) {
      document.getElementById('sidebar').classList.add('open');
      document.getElementById('sidebar-backdrop').classList.add('visible');
    }

    getTithesFilter(item).then(async baseFilter => {
      const [tithesTotals, offeringsTotals] = await Promise.all([
        Promise.all(TITHES_YEARS.map(y => fetchFinanceTotal('tithes',    baseFilter, y))),
        Promise.all(TITHES_YEARS.map(y => fetchFinanceTotal('offerings', baseFilter, y)))
      ]);
      const fmt = n => '₱' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const tEl = document.getElementById('church-tithes-value');
      const oEl = document.getElementById('church-offerings-value');
      if (tEl) tEl.textContent = fmt(tithesTotals.reduce((a, b) => a + b, 0));
      if (oEl) oEl.textContent = fmt(offeringsTotals.reduce((a, b) => a + b, 0));
    }).catch(err => {
      console.warn('[Finance] Failed to load (church view):', err.message);
      const tEl = document.getElementById('church-tithes-value');
      const oEl = document.getElementById('church-offerings-value');
      if (tEl) tEl.textContent = '₱0';
      if (oEl) oEl.textContent = '₱0';
    });

    document.getElementById('tithes-card').addEventListener('click', () => openFinanceModal('tithes', item));
    document.getElementById('offerings-card').addEventListener('click', () => openFinanceModal('offerings', item));

    return;
  }

  // ---- DISTRICT VIEW ----
  panel.innerHTML = `
    <div class="church-card">
      <div class="church-card-header">
        <div class="church-avatar">
          ${item.pastor_image
            ? `<img src="${item.pastor_image}" alt="${item.pastor}"/>`
            : `<i class="fas fa-user"></i>`}
        </div>
        <div>
          <h2>${item.pastor}</h2>
          <p class="church-card-church-name">${item.name}</p>
          <p>${item.address}</p>
        </div>
      </div>
      <div class="info-grid">
        <div class="info-item">
          <label>Contact No.</label>
          <span>${item.contact}</span>
        </div>
        <div class="info-item">
          <label>District</label>
          <span>${item.district}</span>
        </div>
        <div class="info-item clickable" id="tithes-card">
          <label>TITHES</label>
          <span id="district-tithes-value">Loading...</span>
        </div>
        <div class="info-item clickable" id="offerings-card">
          <label>OFFERINGS</label>
          <span id="district-offerings-value">Loading...</span>
        </div>
        <div class="info-item clickable" id="assigned-churches-card" style="grid-column: 1 / -1;">
          <label>Assigned Churches</label>
          <span>${Number(item.members).toLocaleString()}</span>
        </div>
      </div>
      <a href="${item.sheets_url}" target="_blank" rel="noopener" class="btn-sheets">
        <i class="fas fa-table-cells"></i>
        View Google Sheets
      </a>
    </div>`;

  const card = document.getElementById('assigned-churches-card');
  if (card) card.addEventListener('click', () => openChurchesModal(item.id, item.name));

  getTithesFilter(item).then(async baseFilter => {
    const [tithesTotals, offeringsTotals] = await Promise.all([
      Promise.all(TITHES_YEARS.map(y => fetchFinanceTotal('tithes',    baseFilter, y))),
      Promise.all(TITHES_YEARS.map(y => fetchFinanceTotal('offerings', baseFilter, y)))
    ]);
    const fmt = n => '₱' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const tEl = document.getElementById('district-tithes-value');
    const oEl = document.getElementById('district-offerings-value');
    if (tEl) tEl.textContent = fmt(tithesTotals.reduce((a, b) => a + b, 0));
    if (oEl) oEl.textContent = fmt(offeringsTotals.reduce((a, b) => a + b, 0));
  }).catch(err => {
    console.warn('[Finance] Failed to load:', err.message);
  });

  document.getElementById('tithes-card').addEventListener('click', () => openFinanceModal('tithes', item));
  document.getElementById('offerings-card').addEventListener('click', () => openFinanceModal('offerings', item));

  if (window.innerWidth <= 640) {
    document.getElementById('sidebar').classList.add('open');
    document.getElementById('sidebar-backdrop').classList.add('visible');
  }
}

// ===== STATS =====
function renderStats(data) {
  const uniqueDistricts = new Set(data.map(c => c.district)).size;

  if (currentView === 'district') {
    document.getElementById('stat-districts').textContent = uniqueDistricts;
    document.getElementById('stat-pastors').textContent   = data.length;
    document.querySelector('#stat-districts').closest('.stat-card').querySelector('label').textContent = 'Districts';
    document.querySelector('#stat-pastors').closest('.stat-card').querySelector('label').textContent   = 'Pastors';
    document.querySelector('#stat-districts').closest('.stat-card').querySelector('i').className = 'fas fa-map';
    document.querySelector('#stat-pastors').closest('.stat-card').querySelector('i').className   = 'fas fa-user-tie';
  } else {
    document.getElementById('stat-districts').textContent = data.length;
    document.getElementById('stat-pastors').textContent   = uniqueDistricts;
    document.querySelector('#stat-districts').closest('.stat-card').querySelector('label').textContent = 'Churches';
    document.querySelector('#stat-pastors').closest('.stat-card').querySelector('label').textContent   = 'Districts';
    document.querySelector('#stat-districts').closest('.stat-card').querySelector('i').className = 'fas fa-church';
    document.querySelector('#stat-pastors').closest('.stat-card').querySelector('i').className   = 'fas fa-map';
  }
}

// ===== DISTRICT FILTER =====
function populateDistricts() {
  const select      = document.getElementById('district-filter');
  const current     = select.value;
  const allLabel    = currentView === 'district' ? 'All Districts' : 'All Churches';

  select.innerHTML  = `<option value="">${allLabel}</option>`;

  [...new Set(ALL_DATA.map(c => c.district))].sort().forEach(d => {
    const opt = document.createElement('option');
    opt.value = d;
    opt.textContent = d;
    if (d === current) opt.selected = true;
    select.appendChild(opt);
  });

  if (!select.dataset.bound) {
    select.addEventListener('change', applyFilters);
    select.dataset.bound = 'true';
  }
}

// ===== SEARCH =====
function setupSearch() {
  document.getElementById('search-input').addEventListener('input', applyFilters);
}

function applyFilters() {
  const query    = document.getElementById('search-input').value.toLowerCase().trim();
  const district = document.getElementById('district-filter').value;

  activeMarkerId = null;

  filteredData = ALL_DATA.filter(c => {
    const matchSearch   = !query         || c.pastor.toLowerCase().includes(query);
    const matchDistrict = !district      || c.district === district;
    const matchMission  = !activeMission || c.mission_id === activeMission;
    return matchSearch && matchDistrict && matchMission;
  });

  renderMarkers(filteredData);
  renderStats(filteredData);

  // Auto-pan on search
  if (!query || filteredData.length === 0) return;

  if (filteredData.length === 1) {
    const item = filteredData[0];
    activeMarkerId = item.id;
    map.flyTo([item.lat, item.lng], 14, { duration: 0.8 });
    updateSidebar(item);
    renderMarkers(filteredData);
  } else {
    const bounds = L.latLngBounds(filteredData.map(r => [r.lat, r.lng]));
    map.fitBounds(bounds, { padding: [60, 60], maxZoom: 13, animate: true });
  }
}

// ===== RECENT UPDATES =====
function renderRecentUpdates(data) {
  const list   = document.getElementById('recent-list');
  const recent = [...data].slice(0, 4);
  list.innerHTML = recent.map(c => `
    <li>
      <i class="fas fa-${currentView === 'district' ? 'map' : 'church'}"></i>
      <span><strong style="color:var(--text)">${c.name}</strong><br/>${c.updated !== '—' ? c.updated : 'Recently Added'}</span>
    </li>
  `).join('');
}

// ===== LOADING / ERROR =====
function showLoading(visible) {
  const el = document.getElementById('loading-overlay');
  if (!el) return;
  visible ? el.classList.remove('hidden') : setTimeout(() => el.classList.add('hidden'), 400);
}

function showError(msg) {
  const panel = document.getElementById('church-detail');
  if (panel) panel.innerHTML = `
    <div class="detail-placeholder">
      <i class="fas fa-exclamation-triangle" style="color:var(--offline)"></i>
      <p>${msg}</p>
    </div>`;
}

// ===== FINANCE SUMMARY MODAL (shared by Tithes & Offerings) =====
function setupTithesModal() {
  const modal = document.getElementById('tithes-modal');
  document.getElementById('tithes-modal-close').addEventListener('click', () => modal.classList.remove('open'));
  modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('open'); });
}

async function openFinanceModal(table, item) {
  const modal = document.getElementById('tithes-modal');
  const body  = document.getElementById('tithes-modal-body');
  const title = document.getElementById('tithes-modal-title');
  const label = table === 'tithes' ? 'Tithes' : 'Offerings';
  const icon  = table === 'tithes' ? 'fa-coins' : 'fa-hand-holding-heart';

  title.innerHTML = `<i class="fas ${icon}"></i> ${label} Summary — ${item.name}`;
  body.innerHTML  = `<div class="modal-loading"><div class="loader-ring"></div><span>Loading...</span></div>`;
  modal.classList.add('open');

  try {
    const baseFilter = await getTithesFilter(item);
    const totals  = await Promise.all(TITHES_YEARS.map(y => fetchFinanceTotal(table, baseFilter, y)));
    const combined = totals.reduce((a, b) => a + b, 0);
    const fmt = n => '₱' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    body.innerHTML =
      TITHES_YEARS.map((y, i) => `
        <div class="tithes-year-row">
          <span class="tithes-year-label">${y}</span>
          <span class="tithes-year-amount">${fmt(totals[i])}</span>
        </div>`).join('') +
      `<div class="tithes-year-row tithes-total-row">
        <span class="tithes-year-label">Total</span>
        <span class="tithes-year-amount">${fmt(combined)}</span>
      </div>`;
  } catch (err) {
    body.innerHTML = `<div class="modal-empty"><i class="fas fa-exclamation-triangle"></i>Failed to load ${label.toLowerCase()}.</div>`;
  }
}

// ===== ASSIGNED CHURCHES MODAL =====
function setupChurchesModal() {
  const modal    = document.getElementById('churches-modal');
  const closeBtn = document.getElementById('modal-close');

  closeBtn.addEventListener('click', closeChurchesModal);
  // Close on backdrop click
  modal.addEventListener('click', e => {
    if (e.target === modal) closeChurchesModal();
  });
  // Close on Escape key
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeChurchesModal();
  });
}

function openChurchesModal(districtId, districtName) {
  const modal = document.getElementById('churches-modal');
  const body  = document.getElementById('modal-body');
  const title = document.getElementById('modal-title');

  title.innerHTML = `<i class="fas fa-church"></i> ${districtName} — Churches`;
  body.innerHTML  = `
    <div class="modal-loading">
      <div class="loader-ring"></div>
      <span>Loading churches...</span>
    </div>`;
  modal.classList.add('open');

  fetchChurchesByDistrict(districtId).then(churches => {
    if (!churches.length) {
      body.innerHTML = `
        <div class="modal-empty">
          <i class="fas fa-church"></i>
          No assigned churches found.
        </div>`;
      return;
    }
    body.innerHTML = churches.map(c => `
      <div class="church-list-item">
        <div class="church-list-item__name">${c.name || '—'}</div>
        <div class="church-list-item__row">
          <i class="fas fa-map-pin"></i>
          <span>${c.address || '—'}</span>
        </div>
      </div>
    `).join('');
  }).catch(() => {
    body.innerHTML = `
      <div class="modal-empty">
        <i class="fas fa-exclamation-triangle"></i>
        Failed to load churches.
      </div>`;
  });
}

function closeChurchesModal() {
  document.getElementById('churches-modal').classList.remove('open');
}

async function fetchChurchesByDistrict(districtId) {
  console.log('[Modal] district_id:', districtId);
  const data = await supabaseFetch(`churches?select=id,name,address&district_id=eq.${districtId}`);
  console.log('[Modal] churches received:', data.length);
  return data;
}

// ===== MOBILE SIDEBAR TOGGLE =====
function setupMobileToggle() {
  const btn      = document.getElementById('sidebar-toggle');
  const closeBtn = document.getElementById('sidebar-close');
  const backdrop = document.getElementById('sidebar-backdrop');
  const sidebar  = document.getElementById('sidebar');

  function openSidebar() {
    sidebar.classList.add('open');
    backdrop.classList.add('visible');
    setTimeout(() => map && map.invalidateSize(), 320);
  }
  function closeSidebar() {
    sidebar.classList.remove('open');
    backdrop.classList.remove('visible');
    setTimeout(() => map && map.invalidateSize(), 320);
  }

  btn.addEventListener('click', () => {
    sidebar.classList.contains('open') ? closeSidebar() : openSidebar();
  });

  if (closeBtn) closeBtn.addEventListener('click', closeSidebar);
  backdrop.addEventListener('click', closeSidebar);

  document.getElementById('map').addEventListener('click', () => {
    if (window.innerWidth <= 768) closeSidebar();
  });
}
