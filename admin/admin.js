/**
 * Off Grid Admin — Manifest editor
 * Reads/writes data/manifest.json for managing mixes and playlists.
 *
 * Modes:
 *   - File mode (default): reads manifest.json, exports as download
 *   - API mode: reads/writes via Cloudflare Worker API (set API_URL in config)
 */

// ── Config ─────────────────────────────────────────────────────────
// Set API_URL to the Worker URL to enable API mode (e.g., 'https://offgrid-api.your-subdomain.workers.dev')
// Leave empty/null for file-only mode
const API_URL = localStorage.getItem('offgrid_api_url') || '';

// R2 public bucket URL — uploaded files will be referenced with this prefix
const R2_PUBLIC_URL = localStorage.getItem('offgrid_r2_url') || '';

// ── State ──────────────────────────────────────────────────────────
let manifest = { site: { title: '', tagline: '', accent: '#ff5500' }, mixes: [], playlists: [] };
let sortField = 'title';
let sortDir = 'asc';
let playlistSortField = 'title';
let playlistSortDir = 'asc';
let confirmCallback = null;
let authToken = localStorage.getItem('offgrid_token') || '';

// ── Init ───────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Always show login if no API URL is configured yet
  if (!API_URL || !authToken) {
    showLogin();
    return;
  }
  await loadManifest();
  bindEvents();
  renderMixes();
  renderPlaylists();
  showApp();
});

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

// ── Events ─────────────────────────────────────────────────────────
function bindEvents() {
  // Tabs
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`panel-${tab.dataset.tab}`).classList.add('active');
    });
  });

  // Mix CRUD
  document.getElementById('btn-add-mix').addEventListener('click', () => openMixModal());
  document.getElementById('btn-cancel-mix').addEventListener('click', closeMixModal);
  document.getElementById('mix-form').addEventListener('submit', saveMix);
  document.getElementById('mix-modal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeMixModal();
  });

  // Playlist CRUD
  document.getElementById('btn-add-playlist').addEventListener('click', () => openPlaylistModal());
  document.getElementById('btn-cancel-playlist').addEventListener('click', closePlaylistModal);
  document.getElementById('playlist-form').addEventListener('submit', savePlaylist);
  document.getElementById('playlist-modal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closePlaylistModal();
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

  // Color preview
  document.getElementById('mix-color').addEventListener('input', (e) => {
    document.getElementById('mix-color-preview').style.background = e.target.value;
  });

  // Live tracklist parse preview
  document.getElementById('mix-tracklist').addEventListener('input', renderTracklistPreview);
  document.getElementById('playlist-color').addEventListener('input', (e) => {
    document.getElementById('playlist-color-preview').style.background = e.target.value;
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
      <td>${esc(m.title)}</td>
      <td>${esc(m.artist || '')}</td>
      <td>${m.duration ? formatDuration(m.duration) : '—'}</td>
      <td>${(m.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join('')}</td>
      <td class="actions-cell">
        <button class="btn btn-sm" onclick="editMix('${esc(m.id)}')">Edit</button>
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
function openMixModal(mix) {
  const modal = document.getElementById('mix-modal');
  const title = document.getElementById('mix-modal-title');
  const idField = document.getElementById('mix-id');

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

  document.getElementById('mix-color-preview').style.background =
    document.getElementById('mix-color').value;
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
window.editMix = function(id) {
  const mix = manifest.mixes.find(m => m.id === id);
  if (mix) openMixModal(mix);
};

window.deleteMix = function(id) {
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

  document.getElementById('playlist-color-preview').style.background =
    document.getElementById('playlist-color').value;

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

window.editPlaylist = function(id) {
  const pl = manifest.playlists.find(p => p.id === id);
  if (pl) openPlaylistModal(pl);
};

window.deletePlaylist = function(id) {
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
  const { url: presignedUrl } = await presignResp.json();

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

  return R2_PUBLIC_URL ? `${R2_PUBLIC_URL}/${key}` : key;
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
    setProgress(progressEl, offline ? 'Generating waveform…' : `Uploading ${file.name} & generating waveform…`, 0);

    let peaksResult = null;
    const peaksPromise = OffgridPeaks.generatePeaks(file)
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
      setProgressError(progressEl, offline
        ? `Couldn't generate the waveform for this file.`
        : `Audio uploaded — waveform couldn't be generated. Add peaks under Advanced.`);
      toast('Waveform could not be auto-generated (see Advanced).', 'error');
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
function showLogin() {
  document.querySelector('.page').style.display = 'none';
  let loginEl = document.getElementById('login-screen');
  if (!loginEl) {
    loginEl = document.createElement('div');
    loginEl.id = 'login-screen';
    loginEl.innerHTML = `
      <div style="max-width:360px;margin:120px auto;padding:40px 24px;text-align:center;">
        <div style="font-family:'IBM Plex Mono',monospace;font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#ff5500;margin-bottom:20px;">Off Grid Admin</div>
        <form id="login-form" style="display:flex;flex-direction:column;gap:12px;">
          <input type="text" id="login-api-url" placeholder="Worker URL (e.g., https://offgrid-api.workers.dev)"
            value="${API_URL}" style="background:#1a1a1a;border:1px solid #333;border-radius:6px;color:#f0f0f0;padding:10px 14px;font-size:13px;font-family:'IBM Plex Sans',sans-serif;outline:none;">
          <input type="text" id="login-r2-url" placeholder="R2 Public URL (e.g., https://pub-xxxxx.r2.dev)"
            value="${R2_PUBLIC_URL}" style="background:#1a1a1a;border:1px solid #333;border-radius:6px;color:#f0f0f0;padding:10px 14px;font-size:13px;font-family:'IBM Plex Sans',sans-serif;outline:none;">
          <input type="password" id="login-token" placeholder="Admin token"
            style="background:#1a1a1a;border:1px solid #333;border-radius:6px;color:#f0f0f0;padding:10px 14px;font-size:13px;font-family:'IBM Plex Sans',sans-serif;outline:none;">
          <button type="submit" class="btn btn-primary" style="padding:10px 16px;">Login</button>
          <div id="login-error" style="color:#ff4444;font-size:12px;display:none;"></div>
          <div style="margin-top:12px;">
            <button type="button" class="btn btn-sm" id="btn-offline-mode" style="font-size:11px;">Use offline (file mode)</button>
          </div>
        </form>
      </div>
    `;
    document.body.appendChild(loginEl);

    document.getElementById('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const apiUrl = document.getElementById('login-api-url').value.trim().replace(/\/+$/, '');
      const token = document.getElementById('login-token').value.trim();
      const errorEl = document.getElementById('login-error');

      if (!apiUrl || !token) {
        errorEl.textContent = 'Both fields are required.';
        errorEl.style.display = 'block';
        return;
      }

      try {
        const resp = await fetch(`${apiUrl}/files?limit=1`, {
          headers: { 'Authorization': `Bearer ${token}` },
        });
        if (resp.status === 401) {
          errorEl.textContent = 'Invalid token.';
          errorEl.style.display = 'block';
          return;
        }
        if (!resp.ok) {
          errorEl.textContent = `Server error: ${resp.status}`;
          errorEl.style.display = 'block';
          return;
        }

        // Save credentials
        const r2Url = document.getElementById('login-r2-url').value.trim().replace(/\/+$/, '');
        localStorage.setItem('offgrid_api_url', apiUrl);
        localStorage.setItem('offgrid_r2_url', r2Url);
        localStorage.setItem('offgrid_token', token);
        authToken = token;

        // Reload
        location.reload();
      } catch (err) {
        errorEl.textContent = `Connection failed: ${err.message}`;
        errorEl.style.display = 'block';
      }
    });

    document.getElementById('btn-offline-mode').addEventListener('click', () => {
      loginEl.remove();
      document.querySelector('.page').style.display = 'block';
      loadManifest().then(() => {
        bindEvents();
        renderMixes();
        renderPlaylists();
      });
    });
  }
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
      logoutBtn.addEventListener('click', () => {
        localStorage.removeItem('offgrid_token');
        localStorage.removeItem('offgrid_api_url');
        localStorage.removeItem('offgrid_r2_url');
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
  }
}

async function publishManifest() {
  if (!API_URL || !authToken) return;
  try {
    const resp = await apiFetch('/api/manifest/publish', { method: 'POST' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    toast(`Published: ${data.mixCount} mixes, ${data.playlistCount} playlists.`);
  } catch (err) {
    toast('Publish failed: ' + err.message, 'error');
  }
}

// ── API Helper ─────────────────────────────────────────────────────
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
    tracks.push({ time, seconds, artist, title });
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
      return `<li><span class="tl-time">${esc(t.time || '–')}</span> ${meta || '<em>(unparsed)</em>'}</li>`;
    }).join('') +
    '</ol>';
}
