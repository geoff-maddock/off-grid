/**
 * Off Grid Admin — Manifest editor
 * Reads/writes data/manifest.json for managing mixes and playlists.
 *
 * Modes:
 *   - File mode (default): reads manifest.json, exports as download
 *   - API mode: reads/writes via Cloudflare Worker API (set API_URL in config)
 */

// ── Config ─────────────────────────────────────────────────────────
// Worker URL from per-deployment config (../config.local.js sets
// window.OFFGRID_API_BASE). When present, config wins over localStorage and the
// login form needs only email + password. Leave both empty for file-only mode.
const CONFIG_API_URL = String(window.OFFGRID_API_BASE || '').trim().replace(/\/+$/, '');
const API_URL = CONFIG_API_URL || localStorage.getItem('offgrid_api_url') || '';

// R2 public bucket URL — uploaded files will be referenced with this prefix.
// On config-driven deployments this is fetched from the Worker's GET /config
// endpoint; localStorage is just a cache of the last known value.
let R2_PUBLIC_URL = localStorage.getItem('offgrid_r2_url') || '';

// ── State ──────────────────────────────────────────────────────────
let manifest = { site: { title: '', tagline: '', accent: '#ff5500' }, mixes: [], playlists: [] };
let sortField = 'title';
let sortDir = 'asc';
let playlistSortField = 'title';
let playlistSortDir = 'asc';
let confirmCallback = null;
let authToken = localStorage.getItem('offgrid_token') || '';
let currentUser = null;

// ── Init ───────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // An invite link (#invite=<token>) always lands on the accept-invite screen.
  if (getInviteToken()) {
    showLogin();
    return;
  }
  // Show login if no API URL / session yet
  if (!API_URL || !authToken) {
    showLogin();
    return;
  }
  // Validate the session and learn who we are (admin gating, identity).
  try {
    const meResp = await apiFetch('/auth/me');
    if (meResp.status === 401) {
      // Stale/invalid token — clear it and re-login.
      localStorage.removeItem('offgrid_token');
      authToken = '';
      showLogin();
      return;
    }
    if (meResp.ok) currentUser = (await meResp.json()).user;
  } catch (_) { /* offline-ish; fall through and let loadManifest report */ }

  // Config-driven deployments: refresh the R2 public URL from the Worker so a
  // rotated bucket URL heals itself. Awaited so uploads never see a stale value.
  if (CONFIG_API_URL) {
    const cfg = await fetchWorkerConfig(API_URL);
    if (cfg.ok && cfg.r2PublicUrl) {
      R2_PUBLIC_URL = cfg.r2PublicUrl;
      localStorage.setItem('offgrid_r2_url', cfg.r2PublicUrl);
    }
  }

  await loadManifest();
  await loadStats();
  bindEvents();
  renderMixes();
  renderPlaylists();
  showApp();
});

// Parse the invite hash: #invite=<token>&api=<workerUrl>&r2=<r2PublicUrl>
function getInviteParams() {
  const p = new URLSearchParams((location.hash || '').replace(/^#/, ''));
  return { token: p.get('invite') || '', api: p.get('api') || '', r2: p.get('r2') || '' };
}

function getInviteToken() {
  return getInviteParams().token;
}

async function loadManifest() {
  try {
    if (API_URL && authToken) {
      // API mode — load from D1 via the Worker
      const [mixResp, plResp] = await Promise.all([
        apiFetch('/api/mixes'),
        apiFetch('/api/playlists'),
      ]);
      if (!mixResp.ok) throw new Error(`Mixes API: HTTP ${mixResp.status}`);
      if (!plResp.ok) throw new Error(`Playlists API: HTTP ${plResp.status}`);
      manifest.mixes = await mixResp.json();
      manifest.playlists = await plResp.json();
    } else {
      // Offline mode — load from local manifest file
      const resp = await fetch('../data/manifest.json');
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      manifest = await resp.json();
    }
    if (!manifest.site) manifest.site = { title: '', tagline: '', accent: '#ff5500' };
    if (!manifest.mixes) manifest.mixes = [];
    if (!manifest.playlists) manifest.playlists = [];
  } catch (err) {
    console.warn('Could not load manifest, starting empty:', err);
  }
}

// Merge play/like aggregates from GET /api/stats onto manifest.mixes so the
// table cells and the existing sort machinery can use them directly. Fail-soft:
// a Worker without migration 007 (404/500) just leaves the columns at 0.
async function loadStats() {
  for (const m of manifest.mixes) {
    m.playCount = 0;
    m.totalSeconds = 0;
    m.likeCount = 0;
  }
  if (!API_URL || !authToken) return;
  try {
    const resp = await apiFetch('/api/stats');
    if (!resp.ok) return;
    const byId = new Map((await resp.json()).stats.map(s => [s.mixId, s]));
    for (const m of manifest.mixes) {
      const s = byId.get(m.id);
      if (!s) continue;
      m.playCount = s.playCount || 0;
      m.totalSeconds = s.totalSeconds || 0;
      m.likeCount = s.likeCount || 0;
    }
  } catch (err) {
    console.warn('Could not load play stats:', err);
  }
}

// ── Events ─────────────────────────────────────────────────────────
function bindEvents() {
  // Tabs
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`panel-${tab.dataset.tab}`).classList.add('active');
      if (tab.dataset.tab === 'users') renderUsers();
    });
  });

  // Users / invites (admin)
  const btnInvite = document.getElementById('btn-invite');
  if (btnInvite) btnInvite.addEventListener('click', openInviteModal);
  const btnCancelInvite = document.getElementById('btn-cancel-invite');
  if (btnCancelInvite) btnCancelInvite.addEventListener('click', closeInviteModal);
  const inviteForm = document.getElementById('invite-form');
  if (inviteForm) inviteForm.addEventListener('submit', submitInvite);

  // Mix CRUD
  document.getElementById('btn-add-mix').addEventListener('click', () => openMixModal());
  document.getElementById('btn-cancel-mix').addEventListener('click', closeMixModal);
  document.getElementById('mix-form').addEventListener('submit', saveMix);

  // Playlist CRUD
  document.getElementById('btn-add-playlist').addEventListener('click', () => openPlaylistModal());
  document.getElementById('btn-cancel-playlist').addEventListener('click', closePlaylistModal);
  document.getElementById('playlist-form').addEventListener('submit', savePlaylist);

  // Close the open modal/dialog on Escape. Modals otherwise close only via their
  // Cancel/Save buttons — never by clicking or dragging outside the box.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const open = (id) => { const el = document.getElementById(id); return el && el.classList.contains('open'); };
    if (open('mix-modal')) closeMixModal();
    else if (open('playlist-modal')) closePlaylistModal();
    else if (open('invite-modal')) closeInviteModal();
    else if (open('confirm-dialog')) closeConfirm();
  });

  // Import/Export
  document.getElementById('btn-export').addEventListener('click', exportManifest);
  document.getElementById('btn-import').addEventListener('click', () => document.getElementById('import-file').click());
  document.getElementById('import-file').addEventListener('change', importManifest);

  // Search
  document.getElementById('mix-search').addEventListener('input', renderMixes);
  document.getElementById('playlist-search').addEventListener('input', renderPlaylists);

  // Sort headers
  document.querySelectorAll('#mix-table th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const field = th.dataset.sort;
      if (sortField === field) {
        sortDir = sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        sortField = field;
        sortDir = 'asc';
      }
      renderMixes();
    });
  });

  document.querySelectorAll('#playlist-table th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const field = th.dataset.sort;
      if (playlistSortField === field) {
        playlistSortDir = playlistSortDir === 'asc' ? 'desc' : 'asc';
      } else {
        playlistSortField = field;
        playlistSortDir = 'asc';
      }
      renderPlaylists();
    });
  });

  // Color fields: keep the text input and native color picker in sync.
  wireColorField('mix-color', 'mix-color-picker');
  wireColorField('playlist-color', 'playlist-color-picker');

  // Live tracklist parse preview
  document.getElementById('mix-tracklist').addEventListener('input', renderTracklistPreview);
  // After a paste, fill in any missing timestamps (evenly spaced over the mix).
  document.getElementById('mix-tracklist').addEventListener('paste', () => {
    setTimeout(fillMissingTimestamps, 0); // run once the pasted text has landed
  });

  // Upload buttons. The audio picker drives the full auto-pipeline
  // (upload + peaks + duration); covers/peaks use the simple uploader.
  document.querySelectorAll('.upload-btn input[type="file"]').forEach(input => {
    if (input.dataset.upload === 'audio') {
      input.addEventListener('change', (e) => handleAudioSelected(e.target));
    } else {
      input.addEventListener('change', (e) => handleFileUpload(e.target));
    }
  });

  // Confirm dialog
  document.getElementById('btn-confirm-cancel').addEventListener('click', closeConfirm);
  document.getElementById('btn-confirm-ok').addEventListener('click', () => {
    if (confirmCallback) confirmCallback();
    closeConfirm();
  });
  document.getElementById('confirm-dialog').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeConfirm();
  });

  // Auto-generate ID from title
  document.getElementById('mix-title').addEventListener('input', (e) => {
    const idField = document.getElementById('mix-id');
    const editId = document.getElementById('mix-edit-id').value;
    if (!editId) {
      idField.value = slugify(e.target.value);
    }
  });

  document.getElementById('playlist-title').addEventListener('input', (e) => {
    const idField = document.getElementById('playlist-id');
    const editId = document.getElementById('playlist-edit-id').value;
    if (!editId) {
      idField.value = slugify(e.target.value);
    }
  });
}

// ── Mixes Rendering ────────────────────────────────────────────────
function renderMixes() {
  const search = document.getElementById('mix-search').value.toLowerCase();
  let mixes = manifest.mixes.filter(m =>
    m.title.toLowerCase().includes(search) ||
    (m.artist || '').toLowerCase().includes(search) ||
    (m.tags || []).some(t => t.toLowerCase().includes(search))
  );

  mixes.sort((a, b) => {
    let va = a[sortField] || '';
    let vb = b[sortField] || '';
    if (typeof va === 'string') va = va.toLowerCase();
    if (typeof vb === 'string') vb = vb.toLowerCase();
    if (va < vb) return sortDir === 'asc' ? -1 : 1;
    if (va > vb) return sortDir === 'asc' ? 1 : -1;
    return 0;
  });

  const tbody = document.getElementById('mix-tbody');
  const empty = document.getElementById('mix-empty');

  if (mixes.length === 0) {
    tbody.innerHTML = '';
    empty.style.display = 'block';
    return;
  }

  empty.style.display = 'none';
  tbody.innerHTML = mixes.map(m => `
    <tr data-id="${esc(m.id)}">
      <td class="thumb-cell">
        ${m.thumb
      ? `<img src="${m.thumb.startsWith('http') ? esc(m.thumb) : '../' + esc(m.thumb)}" alt="" onerror="this.parentElement.innerHTML='<div class=thumb-placeholder></div>'">`
      : '<div class="thumb-placeholder"></div>'}
      </td>
      <td class="col-title">${esc(m.title)}</td>
      <td class="col-artist">${esc(m.artist || '')}</td>
      <td class="col-duration">${m.duration ? formatDuration(m.duration) : '—'}</td>
      <td class="col-plays">${m.playCount || 0}</td>
      <td class="col-time">${m.totalSeconds >= 1 ? formatDuration(Math.round(m.totalSeconds)) : '—'}</td>
      <td class="col-likes">${m.likeCount || 0}</td>
      <td class="tags-cell">${renderRowTags(m.tags)}</td>
      <td class="actions-cell">
        <button class="btn btn-sm" onclick="editMix('${esc(m.id)}')">Edit</button>
        <button class="btn btn-sm" onclick="copyMixLink('${esc(m.id)}')" title="Copy a share link to just this mix">Link</button>
        <button class="btn btn-sm btn-danger" onclick="deleteMix('${esc(m.id)}')">Delete</button>
      </td>
    </tr>
  `).join('');

  // Update sort indicators
  document.querySelectorAll('#mix-table th[data-sort]').forEach(th => {
    const arrow = th.querySelector('.sort-arrow');
    if (th.dataset.sort === sortField) {
      arrow.classList.add('active');
      arrow.innerHTML = sortDir === 'asc' ? '&#9650;' : '&#9660;';
    } else {
      arrow.classList.remove('active');
      arrow.innerHTML = '&#9650;';
    }
  });
}

// ── Mix Modal ──────────────────────────────────────────────────────
async function openMixModal(mix) {
  const modal = document.getElementById('mix-modal');
  const title = document.getElementById('mix-modal-title');
  const idField = document.getElementById('mix-id');

  // In API mode, load the latest server copy so the form never edits stale data
  // (a stale form would overwrite fields like peaks/src/thumb on save).
  if (mix && API_URL && authToken) {
    try {
      const resp = await apiFetch(`/api/mixes/${encodeURIComponent(mix.id)}`);
      if (resp.ok) mix = await resp.json();
    } catch (_) { /* fall back to the in-memory copy */ }
  }

  if (mix) {
    title.textContent = 'Edit Mix';
    document.getElementById('mix-edit-id').value = mix.id;
    idField.value = mix.id;
    idField.readOnly = true;
    document.getElementById('mix-title').value = mix.title;
    document.getElementById('mix-artist').value = mix.artist || '';
    document.getElementById('mix-description').value = mix.description || '';
    document.getElementById('mix-src').value = mix.src || '';
    document.getElementById('mix-thumb').value = mix.thumb || '';
    document.getElementById('mix-peaks').value = mix.peaks || '';
    document.getElementById('mix-color').value = mix.color || '#ff5500';
    document.getElementById('mix-tags').value = (mix.tags || []).join(', ');
    document.getElementById('mix-release-date').value = mix.releaseDate || '';
    document.getElementById('mix-duration').value = mix.duration || '';
    document.getElementById('mix-tracklist').value = mix.tracklist || '';
  } else {
    title.textContent = 'Add Mix';
    document.getElementById('mix-edit-id').value = '';
    document.getElementById('mix-form').reset();
    document.getElementById('mix-color').value = '#ff5500';
    idField.readOnly = false;
  }

  syncColorPicker('mix-color', 'mix-color-picker');
  renderTracklistPreview();
  modal.classList.add('open');
}

function closeMixModal() {
  document.getElementById('mix-modal').classList.remove('open');
  document.getElementById('mix-form').reset();
}

async function saveMix(e) {
  e.preventDefault();

  const editId = document.getElementById('mix-edit-id').value;
  const id = document.getElementById('mix-id').value.trim();
  const tagsStr = document.getElementById('mix-tags').value;
  const durationStr = document.getElementById('mix-duration').value;

  // Validate unique ID
  if (!editId) {
    const existing = manifest.mixes.find(m => m.id === id);
    if (existing) {
      toast('A mix with this ID already exists.', 'error');
      return;
    }
  }

  const tracklistText = document.getElementById('mix-tracklist').value;

  const mixData = {
    id,
    title: document.getElementById('mix-title').value.trim(),
    artist: document.getElementById('mix-artist').value.trim(),
    description: document.getElementById('mix-description').value.trim(),
    src: document.getElementById('mix-src').value.trim(),
    thumb: document.getElementById('mix-thumb').value.trim(),
    peaks: document.getElementById('mix-peaks').value.trim(),
    color: document.getElementById('mix-color').value.trim() || '#ff5500',
    tags: tagsStr ? tagsStr.split(',').map(t => t.trim()).filter(Boolean) : [],
    duration: durationStr ? parseFloat(durationStr) : null,
    releaseDate: document.getElementById('mix-release-date').value || null,
    tracklist: tracklistText,
    tracks: parseTracklist(tracklistText),
  };

  if (API_URL && authToken) {
    // API mode — persist to D1
    try {
      const resp = editId
        ? await apiFetch(`/api/mixes/${encodeURIComponent(editId)}`, { method: 'PUT', body: JSON.stringify(mixData) })
        : await apiFetch('/api/mixes', { method: 'POST', body: JSON.stringify(mixData) });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        toast(err.error || `Save failed: ${resp.status}`, 'error');
        return;
      }
      const saved = await resp.json();
      if (editId) {
        const idx = manifest.mixes.findIndex(m => m.id === editId);
        if (idx >= 0) manifest.mixes[idx] = saved;
      } else {
        manifest.mixes.push(saved);
      }
    } catch (err) {
      toast('Save failed: ' + err.message, 'error');
      return;
    }
  } else {
    // Offline mode — local only
    if (editId) {
      const idx = manifest.mixes.findIndex(m => m.id === editId);
      if (idx >= 0) manifest.mixes[idx] = mixData;
    } else {
      manifest.mixes.push(mixData);
    }
  }

  closeMixModal();
  renderMixes();
  toast(editId ? 'Mix updated.' : 'Mix added.');
}

// Global functions for inline onclick handlers
window.editMix = function (id) {
  const mix = manifest.mixes.find(m => m.id === id);
  if (mix) openMixModal(mix);
};

// Copy a share link that opens the player page showing just this one mix.
window.copyMixLink = function (id) {
  const playerBase = new URL('..', location.href).href; // admin lives at <site>/admin/
  // A real account scopes via ?user=<id>; the bootstrap/owner uses the default manifest.
  const uid = (currentUser && currentUser.email) ? currentUser.id : null;
  const url = uid
    ? `${playerBase}?user=${encodeURIComponent(uid)}&mix=${encodeURIComponent(id)}`
    : `${playerBase}?mix=${encodeURIComponent(id)}`;
  navigator.clipboard.writeText(url).then(() => toast('Single-mix link copied.'));
};

window.deleteMix = function (id) {
  const mix = manifest.mixes.find(m => m.id === id);
  if (!mix) return;
  showConfirm(`Delete "${mix.title}"? This will also remove it from any playlists.`, async () => {
    if (API_URL && authToken) {
      try {
        const resp = await apiFetch(`/api/mixes/${encodeURIComponent(id)}`, { method: 'DELETE' });
        if (!resp.ok) { toast('Delete failed', 'error'); return; }
      } catch (err) { toast('Delete failed: ' + err.message, 'error'); return; }
    }
    manifest.mixes = manifest.mixes.filter(m => m.id !== id);
    manifest.playlists.forEach(pl => {
      pl.mixIds = (pl.mixIds || []).filter(mid => mid !== id);
    });
    renderMixes();
    renderPlaylists();
    toast('Mix deleted.');
  });
};

// ── Playlists Rendering ────────────────────────────────────────────
function renderPlaylists() {
  const search = document.getElementById('playlist-search').value.toLowerCase();
  let playlists = manifest.playlists.filter(p =>
    p.title.toLowerCase().includes(search) ||
    (p.creator || '').toLowerCase().includes(search)
  );

  playlists.sort((a, b) => {
    let va = a[playlistSortField] || '';
    let vb = b[playlistSortField] || '';
    if (typeof va === 'string') va = va.toLowerCase();
    if (typeof vb === 'string') vb = vb.toLowerCase();
    if (va < vb) return playlistSortDir === 'asc' ? -1 : 1;
    if (va > vb) return playlistSortDir === 'asc' ? 1 : -1;
    return 0;
  });

  const tbody = document.getElementById('playlist-tbody');
  const empty = document.getElementById('playlist-empty');

  if (playlists.length === 0) {
    tbody.innerHTML = '';
    empty.style.display = 'block';
    return;
  }

  empty.style.display = 'none';
  tbody.innerHTML = playlists.map(p => `
    <tr data-id="${esc(p.id)}">
      <td>${esc(p.title)}</td>
      <td>${esc(p.creator || '')}</td>
      <td>${p.mixIds.length} track${p.mixIds.length !== 1 ? 's' : ''}</td>
      <td class="actions-cell">
        <button class="btn btn-sm" onclick="editPlaylist('${esc(p.id)}')">Edit</button>
        <button class="btn btn-sm btn-danger" onclick="deletePlaylist('${esc(p.id)}')">Delete</button>
      </td>
    </tr>
  `).join('');
}

// ── Playlist Modal ─────────────────────────────────────────────────
function openPlaylistModal(playlist) {
  const modal = document.getElementById('playlist-modal');
  const title = document.getElementById('playlist-modal-title');
  const idField = document.getElementById('playlist-id');

  if (playlist) {
    title.textContent = 'Edit Playlist';
    document.getElementById('playlist-edit-id').value = playlist.id;
    idField.value = playlist.id;
    idField.readOnly = true;
    document.getElementById('playlist-title').value = playlist.title;
    document.getElementById('playlist-creator').value = playlist.creator || '';
    document.getElementById('playlist-description').value = playlist.description || '';
    document.getElementById('playlist-thumb').value = playlist.thumb || '';
    document.getElementById('playlist-color').value = playlist.color || '#ff5500';
  } else {
    title.textContent = 'Add Playlist';
    document.getElementById('playlist-edit-id').value = '';
    document.getElementById('playlist-form').reset();
    document.getElementById('playlist-color').value = '#ff5500';
    idField.readOnly = false;
  }

  syncColorPicker('playlist-color', 'playlist-color-picker');

  // Build mix checklist
  const list = document.getElementById('playlist-mix-list');
  const selectedIds = playlist ? playlist.mixIds : [];

  // Show selected mixes first (in order), then unselected
  const ordered = [
    ...selectedIds.map(id => manifest.mixes.find(m => m.id === id)).filter(Boolean),
    ...manifest.mixes.filter(m => !selectedIds.includes(m.id))
  ];

  list.innerHTML = ordered.map((m, i) => `
    <li class="playlist-mix-item" data-mix-id="${esc(m.id)}">
      <span class="drag-handle" title="Drag to reorder"><svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><rect x="3" y="2" width="4" height="2" rx="0.5"/><rect x="9" y="2" width="4" height="2" rx="0.5"/><rect x="3" y="7" width="4" height="2" rx="0.5"/><rect x="9" y="7" width="4" height="2" rx="0.5"/><rect x="3" y="12" width="4" height="2" rx="0.5"/><rect x="9" y="12" width="4" height="2" rx="0.5"/></svg></span>
      <input type="checkbox" ${selectedIds.includes(m.id) ? 'checked' : ''}>
      <span class="mix-num">${i + 1}.</span>
      <span class="mix-label">${esc(m.title)}${m.artist ? ' — ' + esc(m.artist) : ''}</span>
    </li>
  `).join('');

  initPlaylistDragDrop(list);
  modal.classList.add('open');
}

function closePlaylistModal() {
  document.getElementById('playlist-modal').classList.remove('open');
  document.getElementById('playlist-form').reset();
}

async function savePlaylist(e) {
  e.preventDefault();

  const editId = document.getElementById('playlist-edit-id').value;
  const id = document.getElementById('playlist-id').value.trim();

  if (!editId) {
    const existing = manifest.playlists.find(p => p.id === id);
    if (existing) {
      toast('A playlist with this ID already exists.', 'error');
      return;
    }
  }

  // Collect checked mix IDs in DOM order
  const mixIds = [];
  document.querySelectorAll('#playlist-mix-list .playlist-mix-item').forEach(item => {
    if (item.querySelector('input[type="checkbox"]').checked) {
      mixIds.push(item.dataset.mixId);
    }
  });

  const plData = {
    id,
    title: document.getElementById('playlist-title').value.trim(),
    description: document.getElementById('playlist-description').value.trim(),
    creator: document.getElementById('playlist-creator').value.trim(),
    thumb: document.getElementById('playlist-thumb').value.trim() || null,
    color: document.getElementById('playlist-color').value.trim() || '#ff5500',
    mixIds
  };

  if (API_URL && authToken) {
    try {
      const resp = editId
        ? await apiFetch(`/api/playlists/${encodeURIComponent(editId)}`, { method: 'PUT', body: JSON.stringify(plData) })
        : await apiFetch('/api/playlists', { method: 'POST', body: JSON.stringify(plData) });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        toast(err.error || `Save failed: ${resp.status}`, 'error');
        return;
      }
      const saved = await resp.json();
      if (editId) {
        const idx = manifest.playlists.findIndex(p => p.id === editId);
        if (idx >= 0) manifest.playlists[idx] = saved;
      } else {
        manifest.playlists.push(saved);
      }
    } catch (err) {
      toast('Save failed: ' + err.message, 'error');
      return;
    }
  } else {
    if (editId) {
      const idx = manifest.playlists.findIndex(p => p.id === editId);
      if (idx >= 0) manifest.playlists[idx] = plData;
    } else {
      manifest.playlists.push(plData);
    }
  }

  closePlaylistModal();
  renderPlaylists();
  toast(editId ? 'Playlist updated.' : 'Playlist added.');
}

window.editPlaylist = function (id) {
  const pl = manifest.playlists.find(p => p.id === id);
  if (pl) openPlaylistModal(pl);
};

window.deletePlaylist = function (id) {
  const pl = manifest.playlists.find(p => p.id === id);
  if (!pl) return;
  showConfirm(`Delete playlist "${pl.title}"?`, async () => {
    if (API_URL && authToken) {
      try {
        const resp = await apiFetch(`/api/playlists/${encodeURIComponent(id)}`, { method: 'DELETE' });
        if (!resp.ok) { toast('Delete failed', 'error'); return; }
      } catch (err) { toast('Delete failed: ' + err.message, 'error'); return; }
    }
    manifest.playlists = manifest.playlists.filter(p => p.id !== id);
    renderPlaylists();
    toast('Playlist deleted.');
  });
};

// ── Playlist Drag & Drop Reorder ───────────────────────────────────
function initPlaylistDragDrop(list) {
  let dragItem = null;
  let placeholder = null;
  let startY = 0;
  let offsetY = 0;

  list.querySelectorAll('.drag-handle').forEach(handle => {
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const item = handle.closest('.playlist-mix-item');
      if (!item) return;

      dragItem = item;
      startY = e.clientY;
      const rect = item.getBoundingClientRect();
      offsetY = e.clientY - rect.top;

      // Create placeholder
      placeholder = document.createElement('li');
      placeholder.className = 'playlist-mix-placeholder';
      placeholder.style.height = rect.height + 'px';
      item.parentNode.insertBefore(placeholder, item);

      // Make item float
      dragItem.classList.add('dragging');
      dragItem.style.position = 'fixed';
      dragItem.style.left = rect.left + 'px';
      dragItem.style.top = rect.top + 'px';
      dragItem.style.width = rect.width + 'px';
      dragItem.style.zIndex = '10';

      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    });
  });

  function onMove(e) {
    if (!dragItem || !placeholder) return;

    // Move the dragged item
    dragItem.style.top = (e.clientY - offsetY) + 'px';

    // Find which item we're hovering over
    const items = [...list.querySelectorAll('.playlist-mix-item:not(.dragging)')];
    for (const item of items) {
      const rect = item.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      if (e.clientY < midY) {
        list.insertBefore(placeholder, item);
        return;
      }
    }
    // Past all items — put at end
    list.appendChild(placeholder);
  }

  function onUp() {
    if (!dragItem || !placeholder) return;

    // Insert the real item where the placeholder is
    list.insertBefore(dragItem, placeholder);
    placeholder.remove();
    placeholder = null;

    // Reset styles
    dragItem.classList.remove('dragging');
    dragItem.style.position = '';
    dragItem.style.left = '';
    dragItem.style.top = '';
    dragItem.style.width = '';
    dragItem.style.zIndex = '';
    dragItem = null;

    renumberPlaylistItems(list);

    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
  }

  // Clicking the label/checkbox area toggles the checkbox
  list.addEventListener('click', (e) => {
    const item = e.target.closest('.playlist-mix-item');
    if (!item || e.target.closest('.drag-handle')) return;
    if (e.target.tagName !== 'INPUT') {
      const cb = item.querySelector('input[type="checkbox"]');
      if (cb) cb.checked = !cb.checked;
    }
  });
}

function renumberPlaylistItems(list) {
  list.querySelectorAll('.playlist-mix-item').forEach((item, i) => {
    const num = item.querySelector('.mix-num');
    if (num) num.textContent = (i + 1) + '.';
  });
}

// ── Import / Export ────────────────────────────────────────────────
function exportManifest() {
  const json = JSON.stringify(manifest, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'manifest.json';
  a.click();
  URL.revokeObjectURL(url);
  toast('Manifest exported.');
}

function importManifest(e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const data = JSON.parse(ev.target.result);
      if (!data.mixes || !Array.isArray(data.mixes)) {
        throw new Error('Invalid manifest: missing mixes array');
      }
      manifest = data;
      if (!manifest.site) manifest.site = { title: '', tagline: '', accent: '#ff5500' };
      if (!manifest.playlists) manifest.playlists = [];
      renderMixes();
      renderPlaylists();
      toast('Manifest imported.', 'success');
    } catch (err) {
      toast('Failed to import: ' + err.message, 'error');
    }
  };
  reader.readAsText(file);
  e.target.value = '';
}

// ── Confirm Dialog ─────────────────────────────────────────────────
function showConfirm(message, callback) {
  document.getElementById('confirm-message').textContent = message;
  confirmCallback = callback;
  document.getElementById('confirm-dialog').classList.add('open');
}

function closeConfirm() {
  document.getElementById('confirm-dialog').classList.remove('open');
  confirmCallback = null;
}

// ── Toast ──────────────────────────────────────────────────────────
function toast(message, type = 'success') {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = `toast ${type} show`;
  clearTimeout(el._timeout);
  el._timeout = setTimeout(() => {
    el.classList.remove('show');
  }, 2500);
}

// ── File Upload to R2 ──────────────────────────────────────────────

// Render/update an inline progress widget (text + bar) in a .upload-progress el.
function setProgress(el, text, pct = 0) {
  let fill = el.querySelector('.progress-fill');
  if (!fill) {
    el.className = 'upload-progress';
    el.innerHTML = `<span class="progress-text"></span> <div class="progress-bar"><div class="progress-fill"></div></div>`;
    fill = el.querySelector('.progress-fill');
  }
  el.querySelector('.progress-text').textContent = text;
  fill.style.width = `${pct}%`;
}

function setProgressDone(el, text) {
  el.className = 'upload-progress success';
  el.textContent = text;
}

function setProgressError(el, text) {
  el.className = 'upload-progress error';
  el.textContent = text;
}

/**
 * Upload a Blob/File to R2 under `key`. Direct upload through the Worker for
 * files < 95MB, presigned PUT for larger. Returns the public R2 URL.
 */
async function uploadBlobToR2(blob, key, { onProgress } = {}) {
  // Without a public bucket URL we'd store a relative key, which the player
  // page then resolves against its own origin (e.g. localhost). Refuse instead.
  if (!R2_PUBLIC_URL) {
    throw new Error('R2 Public URL is not configured — set R2_PUBLIC_URL in the Worker\'s wrangler.toml [vars] (or log in again and fill the "R2 Public URL" field).');
  }
  const contentType = blob.type || 'application/octet-stream';

  if (blob.size < 95 * 1024 * 1024) {
    const resp = await fetch(`${API_URL}/upload`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': contentType,
        'X-File-Key': key,
      },
      body: blob,
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
      throw new Error(err.error || `Upload failed: ${resp.status}`);
    }
    const data = await resp.json();
    return R2_PUBLIC_URL ? `${R2_PUBLIC_URL}/${data.key}` : data.key;
  }

  // Large file — presigned URL with upload progress
  const presignResp = await apiFetch('/presign', {
    method: 'POST',
    body: JSON.stringify({ key, contentType }),
  });
  if (!presignResp.ok) {
    const err = await presignResp.json().catch(() => ({ error: 'Presign failed' }));
    throw new Error(err.error);
  }
  // The Worker scopes the key to the user's namespace and returns it.
  const { url: presignedUrl, key: scopedKey } = await presignResp.json();
  const finalKey = scopedKey || key;

  await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', presignedUrl);
    if (contentType) xhr.setRequestHeader('Content-Type', contentType);
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
    });
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Upload failed: ${xhr.status}`));
    });
    xhr.addEventListener('error', () => reject(new Error('Upload network error')));
    xhr.send(blob);
  });

  return R2_PUBLIC_URL ? `${R2_PUBLIC_URL}/${finalKey}` : finalKey;
}

// Simple uploader for cover images and manual peaks overrides.
async function handleFileUpload(input) {
  if (!API_URL || !authToken) {
    toast('Upload requires API mode. Log in with your Worker URL first.', 'error');
    input.value = '';
    return;
  }

  const file = input.files[0];
  if (!file) return;

  const prefix = input.dataset.upload; // 'covers' or 'peaks'
  const key = `${prefix}/${file.name}`;
  const btn = input.closest('.upload-btn');
  const progressEl = btn.closest('.form-group').querySelector('.upload-progress');

  const fieldMap = { audio: 'mix-src', covers: 'mix-thumb', peaks: 'mix-peaks' };
  const targetInput = document.getElementById(fieldMap[prefix]);

  btn.classList.add('uploading');
  setProgress(progressEl, `Uploading ${file.name}…`, 0);

  try {
    const url = await uploadBlobToR2(file, key, {
      onProgress: (pct) => setProgress(progressEl, `Uploading ${file.name}… ${pct}%`, pct),
    });
    setProgressDone(progressEl, `Uploaded: ${key}`);
    if (targetInput) targetInput.value = url;
    toast(`${file.name} uploaded to R2.`);
  } catch (err) {
    setProgressError(progressEl, `Failed: ${err.message}`);
    toast(`Upload failed: ${err.message}`, 'error');
  } finally {
    btn.classList.remove('uploading');
    input.value = '';
  }
}

/**
 * Audio picker pipeline: upload the audio, auto-generate the waveform peaks
 * and duration in the browser, upload the peaks JSON, and fill every field —
 * so adding a mix is just "choose the file + type the details".
 */
async function handleAudioSelected(input) {
  const file = input.files[0];
  if (!file) return;

  const offline = !API_URL || !authToken;
  const btn = input.closest('.upload-btn');
  const progressEl = document.getElementById('upload-audio-progress');
  const base = file.name.replace(/\.[^.]+$/, '');

  btn.classList.add('uploading');
  try {
    // 1. Duration from metadata (instant) — fill the field right away.
    setProgress(progressEl, 'Reading audio…', 0);
    let duration = 0;
    try {
      duration = await OffgridPeaks.getAudioDuration(file);
      if (duration) setMixDuration(duration);
    } catch (_) { /* non-fatal — peaks decode also yields duration */ }

    // 2. Generate peaks in the browser; upload audio concurrently (API mode).
    //    Very large files are skipped — decoding them in-browser would exhaust
    //    memory. ~120 MB ≈ an hour-plus mix; use the CLI for those.
    const sizeMb = Math.round(file.size / (1024 * 1024));
    const tooBig = file.size > 320 * 1024 * 1024;
    setProgress(progressEl, offline ? 'Generating waveform…' : `Uploading ${file.name}${tooBig ? '' : ' & generating waveform'}…`, 0);

    let peaksResult = null;
    const peaksPromise = tooBig
      ? Promise.resolve()
      : OffgridPeaks.generatePeaks(file)
        .then((r) => { peaksResult = r; })
        .catch((err) => { console.warn('Peak generation failed:', err); });

    let audioUrl = null;
    if (!offline) {
      const uploadPromise = uploadBlobToR2(file, `audio/${file.name}`, {
        onProgress: (pct) => setProgress(progressEl, `Uploading ${file.name}… ${pct}%`, pct),
      });
      [audioUrl] = await Promise.all([uploadPromise, peaksPromise]);
      document.getElementById('mix-src').value = audioUrl;
    } else {
      await peaksPromise;
    }

    // 3. Persist the peaks JSON.
    if (peaksResult && peaksResult.peaks && peaksResult.peaks.length) {
      if (peaksResult.duration && !document.getElementById('mix-duration').value) {
        setMixDuration(peaksResult.duration);
      }
      const peaksBlob = new Blob([JSON.stringify(peaksResult)], { type: 'application/json' });

      if (!offline) {
        setProgress(progressEl, 'Saving waveform…', 100);
        const peaksUrl = await uploadBlobToR2(peaksBlob, `peaks/${base}.peaks.json`, {});
        document.getElementById('mix-peaks').value = peaksUrl;
        setProgressDone(progressEl, `Ready — audio + waveform (${formatDuration(peaksResult.duration)})`);
        toast('Audio uploaded, waveform generated.');
      } else {
        // Offline: no R2 — hand the peaks file to the user to place locally.
        downloadBlob(peaksBlob, `${base}.peaks.json`);
        document.getElementById('mix-peaks').value = `${base}.peaks.json`;
        setProgressDone(progressEl, `Waveform generated (${formatDuration(peaksResult.duration)}) — peaks file downloaded.`);
        toast('Waveform generated and downloaded. Place it next to your audio.');
      }
      maybePrefillFromFilename(base);
    } else {
      const why = tooBig
        ? `This mix is ${sizeMb} MB — too large to build a waveform in the browser.`
        : `The waveform couldn't be generated in the browser.`;
      const fix = 'Run `node generate-peaks.js <file>`, then upload the .peaks.json under Advanced and Save.';
      setProgressError(progressEl, `${offline ? '' : 'Audio uploaded. '}${why} ${fix}`);
      toast('Waveform needs the CLI for this file — see the upload status.', 'error');
      maybePrefillFromFilename(base);
    }
  } catch (err) {
    setProgressError(progressEl, `Failed: ${err.message}`);
    toast(`Upload failed: ${err.message}`, 'error');
  } finally {
    btn.classList.remove('uploading');
    input.value = '';
  }
}

function setMixDuration(secs) {
  const el = document.getElementById('mix-duration');
  if (el) el.value = Math.round(secs * 100) / 100;
}

// Fill ID/title from the filename when the user hasn't typed them yet.
function maybePrefillFromFilename(base) {
  const idEl = document.getElementById('mix-id');
  const titleEl = document.getElementById('mix-title');
  if (idEl && !idEl.readOnly && !idEl.value.trim()) idEl.value = slugify(base);
  if (titleEl && !titleEl.value.trim()) {
    titleEl.value = base.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Auth / Login ───────────────────────────────────────────────────
const LOGIN_FIELD_STYLE = "background:#1a1a1a;border:1px solid #333;border-radius:6px;color:#f0f0f0;padding:10px 14px;font-size:13px;font-family:'IBM Plex Sans',sans-serif;outline:none;";

// GET /config on the Worker — deployment values a client needs before login.
// Returns { ok: true, r2PublicUrl: string|null, needsSetup: boolean } or
// { ok: false } when the Worker is unreachable. A non-OK status (e.g. 404 from
// an older Worker) counts as reachable-but-unconfigured.
async function fetchWorkerConfig(apiUrl) {
  try {
    const resp = await fetch(`${apiUrl}/config`);
    if (!resp.ok) return { ok: true, r2PublicUrl: null, needsSetup: false };
    const body = await resp.json().catch(() => ({}));
    const u = typeof body.r2PublicUrl === 'string' ? body.r2PublicUrl.trim().replace(/\/+$/, '') : '';
    return { ok: true, r2PublicUrl: u || null, needsSetup: body.needsSetup === true };
  } catch (_) {
    return { ok: false };
  }
}

function showLogin() {
  document.querySelector('.page').style.display = 'none';
  let loginEl = document.getElementById('login-screen');
  if (!loginEl) {
    loginEl = document.createElement('div');
    loginEl.id = 'login-screen';
    document.body.appendChild(loginEl);
  }
  const inviteToken = getInviteToken();
  renderLoginForm(loginEl, inviteToken ? 'invite' : 'signin', inviteToken);
}

function renderLoginForm(loginEl, mode, inviteToken) {
  const field = (id, ph, type = 'text', val = '') =>
    `<input type="${type}" id="${id}" placeholder="${ph}" value="${val}" style="${LOGIN_FIELD_STYLE}">`;

  const titles = { signin: 'Off Grid Admin', bootstrap: 'First-time Setup', invite: 'Accept Invite' };
  const submitLabels = { signin: 'Sign in', bootstrap: 'Create admin', invite: 'Set password & continue' };

  // Prefill the Worker/R2 URLs: deployment config wins, then the values an
  // inviter embedded in the invite link, then the last-used (cached) values.
  const inv = mode === 'invite' ? getInviteParams() : null;
  const apiVal = CONFIG_API_URL || (inv && inv.api) || API_URL;
  const r2Val = (inv && inv.r2) || R2_PUBLIC_URL;

  // On config-driven deployments the URL fields stay hidden (they're resolved
  // from config.local.js + the Worker's GET /config) and are only revealed as
  // a fallback when something is missing or unreachable.
  const cfgDriven = !!CONFIG_API_URL;
  const urlRow = (rowId, inner) =>
    `<div id="${rowId}" style="display:${cfgDriven ? 'none' : 'flex'};flex-direction:column;">${inner}</div>`;

  let fields =
    urlRow('row-api-url', field('login-api-url', 'Worker URL (e.g., https://offgrid-api.workers.dev)', 'text', apiVal)) +
    urlRow('row-r2-url', field('login-r2-url', 'R2 Public URL (e.g., https://pub-xxxxx.r2.dev)', 'text', r2Val));
  if (mode === 'signin') {
    fields += field('login-email', 'Email', 'email') + field('login-password', 'Password', 'password');
  } else if (mode === 'bootstrap') {
    fields += field('login-admin-token', 'ADMIN_TOKEN (bootstrap secret)', 'password') +
      field('login-email', 'Your email', 'email') +
      field('login-password', 'Choose a password (8+ chars)', 'password') +
      field('login-name', 'Display name (optional)', 'text');
  } else { // invite
    fields += field('login-password', 'Choose a password (8+ chars)', 'password') +
      field('login-name', 'Display name (optional)', 'text');
  }

  // On config-driven deployments the extra buttons stay out of the way:
  // "First-time setup" renders hidden and is revealed only when the Worker
  // reports no admin account exists yet; offline mode isn't offered at all.
  const switcher = mode === 'signin'
    ? `<button type="button" class="btn btn-sm" id="link-bootstrap" style="font-size:11px;${cfgDriven ? 'display:none;' : ''}">First-time setup</button>`
    : (mode === 'bootstrap'
      ? `<button type="button" class="btn btn-sm" id="link-signin" style="font-size:11px;">Back to sign in</button>`
      : '');
  const offline = mode === 'signin' && !cfgDriven
    ? `<button type="button" class="btn btn-sm" id="btn-offline-mode" style="font-size:11px;">Use offline (file mode)</button>`
    : '';

  loginEl.innerHTML = `
    <div style="max-width:360px;margin:90px auto;padding:40px 24px;text-align:center;">
      <div style="font-family:'IBM Plex Mono',monospace;font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#ff5500;margin-bottom:20px;">${titles[mode]}</div>
      <form id="login-form" style="display:flex;flex-direction:column;gap:12px;">
        ${fields}
        <button type="submit" class="btn btn-primary" style="padding:10px 16px;">${submitLabels[mode]}</button>
        <div id="login-error" style="color:#ff4444;font-size:12px;display:none;"></div>
        <div style="margin-top:12px;display:flex;gap:10px;justify-content:center;">${switcher}${offline}</div>
      </form>
    </div>`;

  const showErr = (msg) => {
    const e = document.getElementById('login-error');
    e.textContent = msg; e.style.display = 'block';
  };

  document.getElementById('login-form').addEventListener('submit', (e) => {
    e.preventDefault();
    submitLogin(mode, inviteToken, showErr);
  });

  const lb = document.getElementById('link-bootstrap');
  if (lb) lb.addEventListener('click', () => renderLoginForm(loginEl, 'bootstrap'));
  const ls = document.getElementById('link-signin');
  if (ls) ls.addEventListener('click', () => renderLoginForm(loginEl, 'signin'));

  const off = document.getElementById('btn-offline-mode');
  if (off) off.addEventListener('click', () => {
    loginEl.remove();
    document.querySelector('.page').style.display = 'block';
    loadManifest().then(() => loadStats()).then(() => { bindEvents(); renderMixes(); renderPlaylists(); });
  });

  // Config-driven: resolve the R2 public URL from the Worker. Reveal the URL
  // fields only when something can't be resolved (fallback to manual entry).
  if (cfgDriven) {
    fetchWorkerConfig(CONFIG_API_URL).then((cfg) => {
      const reveal = (rowId) => {
        const row = document.getElementById(rowId);
        if (row) row.style.display = 'flex';
      };
      const r2Input = document.getElementById('login-r2-url');
      if (!cfg.ok) {
        reveal('row-api-url');
        reveal('row-r2-url');
        showErr('Could not reach the configured Worker — check the URLs below.');
      } else if (cfg.r2PublicUrl) {
        // Worker config is the source of truth — beats invite/cached prefills.
        if (r2Input) r2Input.value = cfg.r2PublicUrl;
      } else {
        // Worker reachable but its R2_PUBLIC_URL var isn't set.
        reveal('row-r2-url');
      }
      // Fresh instance with no admin yet — offer first-time setup.
      if (cfg.ok && cfg.needsSetup) {
        const lb = document.getElementById('link-bootstrap');
        if (lb) lb.style.display = '';
      }
    });
  }
}

async function submitLogin(mode, inviteToken, showErr) {
  // If a required URL is missing while its row is hidden (config-driven form),
  // reveal it so the user can act on the error.
  const revealRow = (rowId) => {
    const row = document.getElementById(rowId);
    if (row) row.style.display = 'flex';
  };
  const apiUrl = (document.getElementById('login-api-url').value || '').trim().replace(/\/+$/, '');
  const r2Url = (document.getElementById('login-r2-url').value || '').trim().replace(/\/+$/, '');
  if (!apiUrl) {
    revealRow('row-api-url');
    return showErr('Worker URL is required.');
  }
  if (!r2Url) {
    revealRow('row-r2-url');
    return showErr('R2 Public URL is required (uploaded files are referenced from it).');
  }

  try {
    let resp;
    if (mode === 'signin') {
      const email = document.getElementById('login-email').value.trim();
      const password = document.getElementById('login-password').value;
      if (!email || !password) return showErr('Email and password are required.');
      resp = await fetch(`${apiUrl}/auth/login`, jsonPost({ email, password }));
    } else if (mode === 'bootstrap') {
      const adminToken = document.getElementById('login-admin-token').value.trim();
      const email = document.getElementById('login-email').value.trim();
      const password = document.getElementById('login-password').value;
      const displayName = document.getElementById('login-name').value.trim();
      if (!adminToken || !email || !password) return showErr('ADMIN_TOKEN, email and password are required.');
      resp = await fetch(`${apiUrl}/auth/bootstrap`, jsonPost({ email, password, displayName }, adminToken));
    } else { // invite
      const password = document.getElementById('login-password').value;
      const displayName = document.getElementById('login-name').value.trim();
      if (!password) return showErr('Password is required.');
      resp = await fetch(`${apiUrl}/auth/accept-invite`, jsonPost({ token: inviteToken, password, displayName }));
    }

    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) return showErr(body.error || `Error ${resp.status}`);
    if (!body.token) return showErr('No session token returned.');

    localStorage.setItem('offgrid_api_url', apiUrl);
    localStorage.setItem('offgrid_r2_url', r2Url);
    localStorage.setItem('offgrid_token', body.token);
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    location.reload();
  } catch (err) {
    showErr(`Connection failed: ${err.message}`);
  }
}

function jsonPost(data, bearer) {
  const headers = { 'Content-Type': 'application/json' };
  if (bearer) headers['Authorization'] = `Bearer ${bearer}`;
  return { method: 'POST', headers, body: JSON.stringify(data) };
}

function showApp() {
  const loginEl = document.getElementById('login-screen');
  if (loginEl) loginEl.remove();
  document.querySelector('.page').style.display = 'block';

  // Add logout button if in API mode
  if (API_URL && authToken) {
    const headerActions = document.querySelector('.header-actions');
    if (!document.getElementById('btn-logout')) {
      const logoutBtn = document.createElement('button');
      logoutBtn.id = 'btn-logout';
      logoutBtn.className = 'btn btn-sm';
      logoutBtn.textContent = 'Logout';
      logoutBtn.title = `Signed in to ${API_URL.replace(/^https?:\/\//, '')}`;
      logoutBtn.addEventListener('click', () => {
        localStorage.removeItem('offgrid_token');
        // Config-driven deployments re-derive the URLs; only clear the cached
        // values when they were typed in at login.
        if (!CONFIG_API_URL) {
          localStorage.removeItem('offgrid_api_url');
          localStorage.removeItem('offgrid_r2_url');
        }
        location.reload();
      });
      headerActions.appendChild(logoutBtn);
    }

    // Add Publish button for API mode
    if (!document.getElementById('btn-publish')) {
      const publishBtn = document.createElement('button');
      publishBtn.id = 'btn-publish';
      publishBtn.className = 'btn btn-primary';
      publishBtn.textContent = 'Publish';
      publishBtn.title = 'Regenerate manifest.json from D1 and write to R2';
      publishBtn.addEventListener('click', publishManifest);
      headerActions.insertBefore(publishBtn, headerActions.firstChild);
    }

    // Reveal admin-only Users tab + show identity
    if (currentUser && currentUser.role === 'admin') {
      const usersTab = document.getElementById('tab-users');
      if (usersTab) usersTab.style.display = '';
      const me = document.getElementById('users-me');
      if (me) me.textContent = (currentUser.email
        ? `Signed in as ${currentUser.email}`
        : 'Signed in with bootstrap token')
        + ` · Worker: ${API_URL.replace(/^https?:\/\//, '')}`;
      renderUsers();
    }
  }
}

async function publishManifest() {
  if (!API_URL || !authToken) return;
  try {
    const resp = await apiFetch('/api/manifest/publish', { method: 'POST' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    toast(`Published: ${data.mixCount} mixes, ${data.playlistCount} playlists.`);
    if (data.manifestKey && R2_PUBLIC_URL) {
      showManifestUrl(`${R2_PUBLIC_URL}/${data.manifestKey}`, data.legacyManifest);
    }
  } catch (err) {
    toast('Publish failed: ' + err.message, 'error');
  }
}

// Show the user's manifest URL (what they embed) after a publish.
function showManifestUrl(url, isLegacy) {
  let bar = document.getElementById('manifest-url-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'manifest-url-bar';
    bar.style.cssText = 'margin:0 0 16px;padding:10px 14px;background:#161616;border:1px solid #2a2a2a;border-radius:6px;font-size:12px;display:flex;gap:10px;align-items:center;';
    const panel = document.getElementById('panel-mixes');
    panel.insertBefore(bar, panel.firstChild);
  }
  // The admin lives at <site>/admin/, so the player page is one level up.
  const playerBase = new URL('..', location.href).href;
  // Prefer the clean ?user=<id> link (derived from the users/<id>/ manifest key);
  // fall back to the explicit ?manifest=<url> form.
  const idMatch = url.match(/\/users\/([^/]+)\/data\/manifest\.json$/);
  const previewUrl = idMatch
    ? `${playerBase}?user=${encodeURIComponent(idMatch[1])}`
    : `${playerBase}?manifest=${encodeURIComponent(url)}`;

  bar.innerHTML = `
    <span style="color:#888;white-space:nowrap;">Your manifest URL${isLegacy ? ' (also at the legacy path)' : ''}:</span>
    <input type="text" readonly value="${url}" onclick="this.select()"
      style="flex:1;background:#1a1a1a;border:1px solid #333;border-radius:4px;color:#f0f0f0;padding:6px 10px;font-family:'IBM Plex Mono',monospace;font-size:11px;">
    <button class="btn btn-sm" id="copy-manifest-url">Copy</button>
    <a class="btn btn-sm btn-primary" id="preview-manifest" href="${previewUrl}" target="_blank" rel="noopener" style="white-space:nowrap;">▶ Preview</a>`;
  document.getElementById('copy-manifest-url').addEventListener('click', () => {
    navigator.clipboard.writeText(url).then(() => toast('Manifest URL copied.'));
  });
}

// ── API Helper ─────────────────────────────────────────────────────
// ── Users management (admin) ───────────────────────────────────────
async function renderUsers() {
  const tbody = document.getElementById('users-tbody');
  const empty = document.getElementById('users-empty');
  if (!tbody) return;
  try {
    const resp = await apiFetch('/api/users');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const users = await resp.json();
    tbody.innerHTML = '';
    if (!users.length) { empty.style.display = 'block'; return; }
    empty.style.display = 'none';

    for (const u of users) {
      const isSelf = currentUser && u.id === currentUser.id;
      const tr = document.createElement('tr');
      tr.innerHTML =
        `<td>${esc(u.email)}${isSelf ? ' <span class="hint">(you)</span>' : ''}</td>` +
        `<td>${esc(u.displayName || '—')}</td>` +
        `<td>${esc(u.role)}</td>` +
        `<td>${esc(u.status)}</td>` +
        `<td class="actions-cell"></td>`;
      const actions = tr.querySelector('.actions-cell');
      if (!isSelf) {
        const roleBtn = mkBtn(u.role === 'admin' ? 'Make user' : 'Make admin', 'btn btn-sm',
          () => patchUser(u.id, { role: u.role === 'admin' ? 'user' : 'admin' }));
        const statusBtn = mkBtn(u.status === 'active' ? 'Disable' : 'Enable', 'btn btn-sm',
          () => patchUser(u.id, { status: u.status === 'active' ? 'disabled' : 'active' }));
        const delBtn = mkBtn('Delete', 'btn btn-sm btn-danger',
          () => showConfirm(`Delete ${u.email}?`, () => deleteUser(u.id)));
        actions.append(roleBtn, statusBtn, delBtn);
      }
      tbody.appendChild(tr);
    }
  } catch (err) {
    toast(`Could not load users: ${err.message}`, 'error');
  }
}

function mkBtn(label, className, onClick) {
  const b = document.createElement('button');
  b.className = className;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

async function patchUser(id, changes) {
  try {
    const resp = await apiFetch(`/api/users/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(changes) });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) return toast(body.error || `Update failed: ${resp.status}`, 'error');
    toast('User updated.');
    renderUsers();
  } catch (err) { toast(`Update failed: ${err.message}`, 'error'); }
}

async function deleteUser(id) {
  try {
    const resp = await apiFetch(`/api/users/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) return toast(body.error || `Delete failed: ${resp.status}`, 'error');
    toast('User deleted.');
    renderUsers();
  } catch (err) { toast(`Delete failed: ${err.message}`, 'error'); }
}

function openInviteModal() {
  document.getElementById('invite-form').reset();
  document.getElementById('invite-result').style.display = 'none';
  document.getElementById('btn-send-invite').style.display = '';
  document.getElementById('invite-modal').classList.add('open');
}

function closeInviteModal() {
  document.getElementById('invite-modal').classList.remove('open');
}

async function submitInvite(e) {
  e.preventDefault();
  const email = document.getElementById('invite-email').value.trim();
  const role = document.getElementById('invite-role').value;
  if (!email) return;
  try {
    const resp = await apiFetch('/api/users/invite', { method: 'POST', body: JSON.stringify({ email, role }) });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) return toast(body.error || `Invite failed: ${resp.status}`, 'error');

    // Embed the Worker + R2 URLs so the invitee doesn't have to be told them.
    const hash = new URLSearchParams({ invite: body.inviteToken });
    if (API_URL) hash.set('api', API_URL);
    if (R2_PUBLIC_URL) hash.set('r2', R2_PUBLIC_URL);
    const link = `${location.origin}${location.pathname}#${hash.toString()}`;
    const linkEl = document.getElementById('invite-link');
    linkEl.value = link;
    document.getElementById('invite-result').style.display = '';
    document.getElementById('btn-send-invite').style.display = 'none';
    linkEl.focus();
    linkEl.select();
    toast('Invite created — copy the link.');
  } catch (err) {
    toast(`Invite failed: ${err.message}`, 'error');
  }
}

function apiFetch(path, options = {}) {
  const url = `${API_URL}${path}`;
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }
  return fetch(url, { ...options, headers });
}

// ── Helpers ────────────────────────────────────────────────────────
function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 60);
}

function esc(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

// Render up to 3 tag chips; overflow collapses into a "+N" chip whose
// tooltip lists the hidden tags, so rows stay one line tall.
function renderRowTags(tags) {
  if (!tags || !tags.length) return '';
  const MAX = 3;
  const chips = tags.slice(0, MAX).map(t => `<span class="tag">${esc(t)}</span>`);
  if (tags.length > MAX) {
    chips.push(`<span class="tag tag-more" title="${esc(tags.slice(MAX).join(', ')).replace(/"/g, '&quot;')}">+${tags.length - MAX}</span>`);
  }
  return `<div class="tag-list">${chips.join('')}</div>`;
}

function formatDuration(secs) {
  if (!secs || isNaN(secs)) return '—';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ── Tracklist parsing ──────────────────────────────────────────────
// Turn a raw tracklist textarea into structured tracks. Tolerant of common
// formats: "04:32 Artist - Title", "1. Artist – Title [04:32]", "[04:32] ...",
// and lines with no timestamp.
function parseTracklist(text) {
  if (!text) return [];
  const tracks = [];
  for (const line of text.split(/\r?\n/)) {
    let rest = line.trim();
    if (!rest) continue;

    // Strip a leading track number like "1." or "12)"
    rest = rest.replace(/^\d{1,3}[.)]\s*/, '');

    // Pull out a link (e.g. Bandcamp/Discogs) before anything else, so its
    // colons don't get mistaken for a timestamp.
    let url = '';
    const um = rest.match(/\bhttps?:\/\/\S+/i);
    if (um) {
      url = um[0].split(/["'<>`]/)[0]   // stop at any HTML/attribute-breakout char
        .replace(/[)\].,;]+$/, '');     // trim trailing punctuation/brackets
      rest = (rest.slice(0, um.index) + rest.slice(um.index + um[0].length)).trim();
      rest = rest.replace(/[|–—-]\s*$/, '').trim(); // drop a trailing separator
    }

    // Pull the first timestamp (MM:SS or HH:MM:SS), optionally bracketed.
    let time = '';
    let seconds = null;
    const tm = rest.match(/\[?\(?\b(\d{1,2}:\d{2}(?::\d{2})?)\b\)?\]?/);
    if (tm) {
      time = tm[1];
      seconds = timeToSeconds(time);
      rest = (rest.slice(0, tm.index) + rest.slice(tm.index + tm[0].length)).trim();
      rest = rest.replace(/^[-–—:.\s]+/, '').replace(/[-–—\s]+$/, '').trim();
    }

    // Split remaining "Artist - Title" on a dash surrounded by spaces.
    let artist = '';
    let title = rest;
    const parts = rest.split(/\s[-–—]\s/);
    if (parts.length >= 2) {
      artist = parts[0].trim();
      title = parts.slice(1).join(' - ').trim();
    }

    if (!artist && !title) continue;
    tracks.push({ time, seconds, artist, title, url });
  }
  return tracks;
}

function timeToSeconds(t) {
  const parts = t.split(':').map(Number);
  if (parts.some(isNaN)) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return null;
}

// Normalize a user-entered color to the #rrggbb form that <input type="color">
// requires. Accepts values with or without a leading '#' and expands #rgb
// shorthand. Returns null when the value isn't a parseable hex color.
function normalizeHex(value) {
  let v = (value || '').trim();
  if (!v) return null;
  if (v[0] !== '#') v = '#' + v;
  if (/^#[0-9a-fA-F]{3}$/.test(v)) {
    v = '#' + v[1] + v[1] + v[2] + v[2] + v[3] + v[3];
  }
  return /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : null;
}

// Bidirectionally bind a hex text input and its native color-picker swatch:
// typing updates the swatch, picking fills the text field.
function wireColorField(textId, pickerId) {
  const text = document.getElementById(textId);
  const picker = document.getElementById(pickerId);
  if (!text || !picker) return;
  text.addEventListener('input', () => {
    const hex = normalizeHex(text.value);
    if (hex) picker.value = hex;
  });
  picker.addEventListener('input', () => {
    text.value = picker.value;
  });
}

// Push the current text-field color into the swatch (used when opening a modal).
function syncColorPicker(textId, pickerId) {
  const picker = document.getElementById(pickerId);
  const hex = normalizeHex(document.getElementById(textId).value);
  if (picker && hex) picker.value = hex;
}

function renderTracklistPreview() {
  const el = document.getElementById('tracklist-preview');
  if (!el) return;
  const input = document.getElementById('mix-tracklist');
  const tracks = parseTracklist(input ? input.value : '');
  if (!tracks.length) { el.innerHTML = ''; return; }
  el.innerHTML =
    `<div class="tracklist-preview-head">${tracks.length} track${tracks.length === 1 ? '' : 's'} detected</div>` +
    '<ol class="tracklist-preview-list">' +
    tracks.map((t) => {
      const meta = [t.artist, t.title].filter(Boolean).map(esc).join(' — ');
      const safe = /^https?:\/\//i.test(t.url || '');
      const link = safe ? ` <a href="${esc(t.url)}" target="_blank" rel="noopener" title="${esc(t.url)}">🔗</a>` : '';
      return `<li><span class="tl-time">${esc(t.time || '–')}</span> ${meta || '<em>(unparsed)</em>'}${link}</li>`;
    }).join('') +
    '</ol>';
}

// Format seconds as a timestamp: "0:00", "4:32", or "1:23:45".
function formatTimestamp(secs) {
  secs = Math.max(0, Math.floor(secs || 0));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = String(secs % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

// Give every track line a timestamp. Lines that already have one are left
// alone; lines without get an evenly-distributed time (position × mix duration
// ÷ track count), so the user has sensible starting times to fine-tune.
// Requires a known mix duration (auto-set from the audio); no-op otherwise.
function fillMissingTimestamps() {
  const ta = document.getElementById('mix-tracklist');
  if (!ta) return;
  const duration = parseFloat(document.getElementById('mix-duration').value);
  if (!(duration > 0)) return;

  const lines = ta.value.split(/\r?\n/);
  const trackLines = [];
  lines.forEach((ln, i) => { if (ln.trim()) trackLines.push(i); });
  const n = trackLines.length;
  if (!n) return;

  const hasTimestamp = /\b\d{1,2}:\d{2}(?::\d{2})?\b/;
  let changed = false;
  trackLines.forEach((lineNo, pos) => {
    const line = lines[lineNo];
    if (hasTimestamp.test(line)) return; // already timestamped
    const ts = formatTimestamp((pos * duration) / n);
    const idx = line.match(/^(\s*\d{1,3}[.)]\s*)/); // preserve a leading "1." index
    lines[lineNo] = idx ? `${idx[1]}${ts} ${line.slice(idx[1].length)}` : `${ts} ${line}`;
    changed = true;
  });

  if (changed) {
    ta.value = lines.join('\n');
    renderTracklistPreview();
  }
}
