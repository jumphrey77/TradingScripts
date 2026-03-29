// src/renderer/app.js
// ZipMover Renderer — Full UI logic

const zm = window.zipmover;

// ─── App State ───────────────────────────────────────────────────────────────

const state = {
  projects: [],
  config: {},
  watcherStatus: {},
  currentProject: null,
  currentProjectDetails: null,
  lastRunResult: null,
  alerts: []
};

// ─── DOM References ───────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

const els = {
  projectList:       $('projectList'),
  emptyState:        $('emptyState'),
  dashboardContent:  $('dashboardContent'),
  projectCards:      $('projectCards'),
  alertBanner:       $('alertBanner'),
  runSummaryPanel:   $('runSummaryPanel'),
  watcherSummary:    $('watcherSummary'),
  viewDashboard:     $('viewDashboard'),
  viewProject:       $('viewProject'),
  viewSettings:      $('viewSettings'),
  projectDetailTitle:$('projectDetailTitle'),
  projectDetailContent: $('projectDetailContent'),
  settingsContent:   $('settingsContent'),
  modalNewProject:   $('modalNewProject'),
  modalMapEntry:     $('modalMapEntry'),
  inputProjectName:  $('inputProjectName'),
  inputDestRoot:     $('inputDestRoot'),
  createProjectError:$('createProjectError'),
  mapEntryFilename:  $('mapEntryFilename'),
  inputMapEntryDest: $('inputMapEntryDest'),
  mapEntryError:     $('mapEntryError'),
  loadingOverlay:    $('loadingOverlay'),
  loadingText:       $('loadingText')
};

let mapEntryCallback = null;   // Used by map entry modal
let pendingUnmatchedFile = null;

// ─── Utility ─────────────────────────────────────────────────────────────────

function showLoading(msg = 'Working…') {
  els.loadingText.textContent = msg;
  els.loadingOverlay.style.display = 'flex';
}

function hideLoading() {
  els.loadingOverlay.style.display = 'none';
}

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDuration(startIso, endIso) {
  if (!startIso || !endIso) return '';
  const ms = new Date(endIso) - new Date(startIso);
  return ms < 1000 ? `${ms}ms` : `${(ms/1000).toFixed(1)}s`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

// ─── View Navigation ──────────────────────────────────────────────────────────

function showView(viewId) {
  ['viewSetup','viewDashboard','viewProject','viewSettings'].forEach(id => {
    $(id).classList.remove('active');
  });
  $(viewId).classList.add('active');
}

// ─── Render Sidebar ───────────────────────────────────────────────────────────

function renderSidebar() {
  const isDashboard = !state.currentProject && $('viewDashboard').classList.contains('active');
  const dashItem = `
    <div class="project-nav-item nav-dashboard ${isDashboard ? 'active' : ''}" id="navDashboard">
      <span style="font-size:14px">⊞</span>
      <span class="project-nav-name">Dashboard</span>
    </div>
  `;
  const items = state.projects.map(p => {
    const status = state.watcherStatus[p.name];
    const isActive = status && status.active;
    const isCurrent = state.currentProject === p.name;
    return `
      <div class="project-nav-item ${isCurrent ? 'active' : ''}" data-project="${escapeHtml(p.name)}">
        <div class="watcher-dot ${isActive ? '' : 'inactive'}"></div>
        <span class="project-nav-name">${escapeHtml(p.name)}</span>
      </div>
    `;
  }).join('');

  const labelHtml = `<div class="project-list-label">PROJECTS</div>`;
  els.projectList.innerHTML = dashItem + labelHtml + (items || '<div style="padding:8px 16px;font-size:11px;color:var(--text-muted)">No projects yet</div>');

  // Bind project clicks
  els.projectList.querySelectorAll('.project-nav-item:not(.nav-dashboard)').forEach(el => {
    el.addEventListener('click', () => openProject(el.dataset.project));
  });
  const navDash = $('navDashboard');
  if (navDash) navDash.addEventListener('click', () => {
    state.currentProject = null;
    renderSidebar();
    showView('viewDashboard');
  });
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

function renderDashboard() {
  if (state.projects.length === 0) {
    els.emptyState.style.display = 'flex';
    els.dashboardContent.style.display = 'none';
    return;
  }

  els.emptyState.style.display = 'none';
  els.dashboardContent.style.display = 'block';

  // Watcher summary
  const activeCount = Object.values(state.watcherStatus).filter(s => s.active).length;
  els.watcherSummary.textContent = `${activeCount} / ${state.projects.length} watchers active`;

  // Project cards
  els.projectCards.innerHTML = state.projects.map(p => {
    const status = state.watcherStatus[p.name];
    const isActive = status && status.active;
    const lastEvent = status && status.lastEvent;
    const isProcessing = lastEvent && lastEvent.type === 'processing';

    let badgeClass = isProcessing ? 'processing' : (isActive ? 'watching' : 'idle');
    let badgeLabel = isProcessing ? '⚙ Processing' : (isActive ? '● Watching' : '○ Idle');

    const lastRun = p.lastRun;
    const runCount = lastRun ? lastRun.runNumber : 0;

    return `
      <div class="project-card" data-project="${escapeHtml(p.name)}">
        <div class="project-card-header">
          <div class="project-card-name">${escapeHtml(p.name)}</div>
          <div class="status-badge ${badgeClass}">${badgeLabel}</div>
        </div>
        <div class="project-card-meta">${escapeHtml(p.destinationRoot || '—')}</div>
        <div class="project-card-stats">
          <div class="stat">
            <div class="stat-value">${p.fileCount || 0}</div>
            <div class="stat-label">Mapped Files</div>
          </div>
          <div class="stat">
            <div class="stat-value">${runCount}</div>
            <div class="stat-label">Runs</div>
          </div>
          <div class="stat">
            <div class="stat-value stat-value-sm">${lastRun ? formatDate(lastRun.finishedAt) : '—'}</div>
            <div class="stat-label">Last Run</div>
          </div>
        </div>
        ${p.allowDropToUI !== false ? `
        <div class="drop-zone-target" data-project="${escapeHtml(p.name)}" id="dropzone-${escapeHtml(p.name)}">
          <div class="drop-zone-icon">📦</div>
          <div class="drop-zone-label">Drop ZIP or single file</div>
          <div class="drop-zone-path">${escapeHtml(p.projectDir || '')}</div>
        </div>` : `
        <div class="drop-zone-disabled">
          <div class="drop-zone-path" style="padding:8px 0">${escapeHtml(p.projectDir || '')}</div>
        </div>`}
        <div class="card-actions">
          <button class="btn-open-folder" data-open-project="${escapeHtml(p.name)}">📂 Open</button>
          <button class="btn-toggle-drop ${p.allowDropToUI !== false ? 'active' : ''}" data-project="${escapeHtml(p.name)}" title="Toggle drag-and-drop for this project">
            ${p.allowDropToUI !== false ? '⬇ Drop ON' : '⬇ Drop OFF'}
          </button>
        </div>
      </div>
    `;
  }).join('');

  els.projectCards.querySelectorAll('.project-card').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.btn-open-folder')) return;
      if (e.target.closest('.btn-toggle-drop')) return;
      if (e.target.closest('.drop-zone-target')) return;
      openProject(el.dataset.project);
    });
  });

  els.projectCards.querySelectorAll('.btn-open-folder').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      zm.openProjectFolder(el.dataset.openProject);
    });
  });

  // Toggle Allow Drop to UI
  els.projectCards.querySelectorAll('.btn-toggle-drop').forEach(el => {
    el.addEventListener('click', async (e) => {
      e.stopPropagation();
      const name = el.dataset.project;
      const project = state.projects.find(p => p.name === name);
      const newVal = !(project && project.allowDropToUI !== false);
      await zm.updateProjectSettings(name, { allowDropToUI: newVal });
      const s = await zm.getState();
      applyState(s);
    });
  });

  // Bind drag-and-drop to project drop zones
  els.projectCards.querySelectorAll('.drop-zone-target').forEach(el => {
    const projectName = el.dataset.project;
    el.addEventListener('dragover',  e => { e.preventDefault(); e.stopPropagation(); el.classList.add('drag-over'); e.dataTransfer.dropEffect = 'copy'; });
    el.addEventListener('dragleave', e => { if (!el.contains(e.relatedTarget)) el.classList.remove('drag-over'); });
    el.addEventListener('drop',      e => handleDashboardDrop(e, el, projectName));
  });

  // Show last run summary if available
  if (state.lastRunResult) {
    renderRunSummary(state.lastRunResult.projectName, state.lastRunResult.result);
  }
}

function renderRunSummary(projectName, result) {
  if (!result) return;

  const statusClass = result.status === 'success' ? 'success'
    : result.status === 'completed_with_errors' ? 'completed_with_errors' : 'failed';

  const duration = formatDuration(result.startedAt, result.finishedAt);

  let sectionsHtml = '';

  if (result.filesDeployed.length > 0) {
    sectionsHtml += `
      <div class="run-section">
        <h4>✅ Deployed (${result.filesDeployed.length})</h4>
        <ul class="run-file-list">
          ${result.filesDeployed.map(f => `<li class="deployed">${escapeHtml(f.filename)}</li>`).join('')}
        </ul>
      </div>
    `;
  }

  if (result.filesUnmatched.length > 0) {
    sectionsHtml += `
      <div class="run-section">
        <h4>⚠ Unmatched — In NewFilesDetected (${result.filesUnmatched.length})</h4>
        <ul class="run-file-list">
          ${result.filesUnmatched.map(f => `<li class="unmatched">${escapeHtml(f.filename)}</li>`).join('')}
        </ul>
      </div>
    `;
  }

  if (result.errors.length > 0) {
    sectionsHtml += `
      <div class="run-section">
        <h4>✗ Errors (${result.errors.length})</h4>
        <ul class="run-file-list">
          ${result.errors.map(e => `<li class="error">${escapeHtml(e.filename)}: ${escapeHtml(e.error)}</li>`).join('')}
        </ul>
      </div>
    `;
  }

  els.runSummaryPanel.innerHTML = `
    <div class="run-summary-header">
      <div class="run-summary-title">
        <span class="run-status-pill ${statusClass}">${result.status.toUpperCase().replace('_',' ')}</span>
        Run #${result.runNumber} — ${escapeHtml(projectName)} — ${escapeHtml(result.zipName)}
      </div>
      <div class="run-summary-datetime">
        <span class="run-datetime-value">${formatDate(result.finishedAt)}</span>
        <span class="run-datetime-duration">${duration}</span>
      </div>
    </div>
    <div class="run-summary-body">${sectionsHtml || '<div style="color:var(--text-muted);font-size:12px;">No files processed.</div>'}</div>
  `;
  els.runSummaryPanel.style.display = 'block';

  // Show collision alerts if any
  if (result.collisionAlerts && result.collisionAlerts.length > 0) {
    showAttentionAlert(
      '⚠ FILENAME COLLISION DETECTED IN MAP',
      'The following filenames appear in multiple locations in your destination. Only one destination is mapped. Review the map and resolve manually.',
      result.collisionAlerts
    );
  }

  // Show unmatched alert
  if (result.filesUnmatched.length > 0) {
    showAlert(
      'alert-warning',
      '📂 New / Unmatched Files Detected',
      `${result.filesUnmatched.length} file(s) had no map entry and were placed in <strong>NewFilesDetected</strong>. Open the project to assign destinations and update the map.`,
      true
    );
  }
}

function showAlert(type, title, message, dismissible = true) {
  els.alertBanner.className = `alert-banner ${type}`;
  els.alertBanner.innerHTML = `
    <div class="alert-icon">${type === 'alert-warning' ? '⚠' : type === 'alert-danger' ? '🚨' : type === 'alert-success' ? '✅' : 'ℹ'}</div>
    <div class="alert-body">
      <div class="alert-title">${title}</div>
      <div class="alert-message">${message}</div>
    </div>
    ${dismissible ? `<button class="alert-dismiss" id="alertDismiss">✕</button>` : ''}
  `;
  els.alertBanner.style.display = 'flex';
  if (dismissible) {
    $('alertDismiss').addEventListener('click', () => {
      els.alertBanner.style.display = 'none';
    });
  }
}

function showAttentionAlert(title, message, items) {
  const itemsHtml = items.map(i => `<li>${escapeHtml(i)}</li>`).join('');
  els.alertBanner.innerHTML = `
    <div class="attention-banner">
      <div class="attention-icon">🚨</div>
      <div class="attention-body">
        <h3>${title}</h3>
        <p>${message}</p>
        <ul>${itemsHtml}</ul>
      </div>
    </div>
  `;
  els.alertBanner.style.display = 'block';
  els.alertBanner.className = '';  // Remove color class, attention-banner handles its own style
}

function filterMapEntries(query) {
  const q = (query || '').toLowerCase().trim();
  const container = $('mapEntries');
  if (!container) return;
  container.querySelectorAll('.map-entry').forEach(el => {
    if (!q) { el.style.display = ''; return; }
    const name = (el.dataset.filename || '').toLowerCase();
    const dest = (el.dataset.dest || '').toLowerCase();
    el.style.display = (name.includes(q) || dest.includes(q)) ? '' : 'none';
  });
}

// ─── Project Detail ───────────────────────────────────────────────────────────

async function openProject(name) {
  state.currentProject = name;
  renderSidebar();
  showView('viewProject');

  els.projectDetailTitle.textContent = name;
  els.projectDetailContent.innerHTML = `<div style="color:var(--text-muted);font-size:13px;padding:20px 0">Loading…</div>`;

  const res = await zm.getProjectDetails(name);
  if (!res.success) {
    els.projectDetailContent.innerHTML = `<div class="form-error">${escapeHtml(res.error)}</div>`;
    return;
  }

  state.currentProjectDetails = res.details;
  renderProjectDetail(res.details);
}

function renderProjectDetail(details) {
  const map = details.map || {};
  const runLog = details.runLog || [];
  const status = state.watcherStatus[details.name] || {};
  const files = map.files || {};
  const collisions = map.collisions || [];
  const fileEntries = Object.entries(files);

  // ── PROJECT INFO (compact) ─────────────────────────────────────────────────
  const excludedFolders = map.excludedFolders || [];
  const excludedFilesList = map.excludedFiles || [];
  const allExcluded = [
    ...excludedFolders.map(f => ({ name: f, type: 'folder' })),
    ...excludedFilesList.map(f => ({ name: f, type: 'file' }))
  ];
  const excludedDisplay = allExcluded.length > 0
    ? allExcluded.map(e => `<span class="exclusion-tag exclusion-tag-${e.type}" title="${e.type === 'file' ? 'Excluded file' : 'Excluded folder'}">${escapeHtml(e.name)}</span>`).join(' ')
    : '<span style="color:var(--text-muted);font-size:11px">None</span>';

  const infoHtml = `
    <div class="detail-card">
      <div class="detail-card-header">
        <div class="detail-card-title">PROJECT INFO</div>
        <button class="btn-open-root" id="btnOpenProjectFolder" style="font-size:11px;padding:4px 10px">📂 Open Folder</button>
      </div>
      <div class="detail-card-body" style="padding:10px 16px">
        <table class="info-table">
          <tr><td>Destination</td><td style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px" title="${escapeHtml(map.destinationRoot || '')}">${escapeHtml(map.destinationRoot || '—')}</td></tr>
          <tr><td>Map Built</td><td>${formatDate(map.builtAt)}</td></tr>
          <tr><td>Watcher</td><td>${status.active ? '<span style="color:var(--accent)">● Active</span>' : '<span style="color:var(--text-muted)">○ Inactive</span>'}</td></tr>
          <tr><td>Next Run #</td><td>${map.nextRunNumber || 1}</td></tr>
          <tr>
            <td>Excluded</td>
            <td>
              <div class="exclusions-summary">
                ${excludedDisplay}
                <button class="btn-edit-exclusions" id="btnEditExclusions">Edit…</button>
              </div>
            </td>
          </tr>
        </table>
      </div>
    </div>
  `;

  // ── RUN HISTORY ────────────────────────────────────────────────────────────
  const runLogHtml = `
    <div class="detail-card">
      <div class="detail-card-header">
        <div class="detail-card-title">RUN HISTORY</div>
        <div style="display:flex;gap:6px;align-items:center">
          <span id="zipArchiveCount" style="font-family:var(--font-mono);font-size:10px;color:var(--text-muted)"></span>
          <button class="btn-secondary" style="font-size:11px;padding:4px 8px" id="btnClearArchive" title="Delete all archived zips">🗜 Archive</button>
          ${runLog.length > 0 ? '<button class="btn-secondary" style="font-size:11px;padding:4px 8px" id="btnViewLog">📋 Log</button>' : ''}
          ${runLog.length > 0 ? '<button class="btn-danger-sm" style="font-size:11px;padding:4px 8px" id="btnClearLog">🗑</button>' : ''}
        </div>
      </div>
      <div class="detail-card-body" style="padding:0">
        ${runLog.length === 0
          ? '<div style="color:var(--text-muted);font-size:12px;padding:12px 16px">No runs yet. Drop a zip into this project folder.</div>'
          : `<table class="run-log-table" style="width:100%">
              <thead><tr><th>Run</th><th>Zip</th><th>Status</th><th>Files</th><th>Time</th></tr></thead>
              <tbody>
                ${runLog.map(r => `
                  <tr>
                    <td>#${r.runNumber}</td>
                    <td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(r.zipName)}">${escapeHtml(r.zipName)}</td>
                    <td><span class="run-status-pill ${r.status}">${r.status.replace(/_/g,' ')}</span></td>
                    <td>${r.filesDeployed.length}↑${r.filesUnmatched.length ? ' '+r.filesUnmatched.length+'?' : ''}${r.errors.length ? ' '+r.errors.length+'✗' : ''}</td>
                    <td style="white-space:nowrap;text-align:right">${formatDate(r.finishedAt)}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>`
        }
      </div>
    </div>
  `;

  // ── UNMATCHED FILES ────────────────────────────────────────────────────────
  const unmatchedHtml = `
    <div class="detail-card">
      <div class="detail-card-header"><div class="detail-card-title">UNMATCHED FILES</div></div>
      <div class="detail-card-body">
        <div style="color:var(--text-muted);font-size:12px;line-height:1.6">
          Files with no map entry go to
          <code style="color:var(--accent);background:var(--bg-base);padding:1px 5px;border-radius:3px">NewFilesDetected/</code>.
          Click a map entry to assign its destination.
        </div>
      </div>
    </div>
  `;

  // ── EXCLUDED FILES ─────────────────────────────────────────────────────────
  const excludedFiles = map.excludedFiles || [];
  const excludedFilesHtml = `
    <div class="detail-card">
      <div class="detail-card-header">
        <div class="detail-card-title">EXCLUDED FILES</div>
        <button class="btn-edit-exclusions" id="btnAddExcludedFile">+ Add</button>
      </div>
      <div class="detail-card-body">
        ${excludedFiles.length === 0
          ? '<div style="color:var(--text-muted);font-size:12px">No files excluded. Click + Add to exclude files like <code style=\'color:var(--accent);\'>.gitignore</code> from deployment.</div>'
          : excludedFiles.map(f => `
              <div class="excluded-file-row">
                <span class="excluded-file-name">${escapeHtml(f)}</span>
                <button class="btn-remove-excluded" data-file="${escapeHtml(f)}">✕</button>
              </div>`).join('')
        }
      </div>
    </div>
  `;

  // ── WILDCARDS ──────────────────────────────────────────────────────────────
  const wildcards = map.wildcards || [];
  const wildcardsHtml = `
    <div class="detail-card" id="wildcardsCard">
      <div class="detail-card-header">
        <div class="detail-card-title">WILDCARD PATTERNS (${wildcards.length})</div>
        <button class="btn-edit-exclusions" id="btnAddWildcard">+ Add</button>
      </div>
      <div class="detail-card-body" style="padding:8px 12px">
        ${wildcards.length === 0
          ? `<div style="color:var(--text-muted);font-size:12px;line-height:1.6">
              No wildcard patterns yet. Add patterns to match versioned or variable filenames.<br>
              <span style="font-family:var(--font-mono);font-size:11px;color:var(--accent)">Example: BlahBlahBlahv*.*</span>
             </div>`
          : wildcards.map(wc => `
              <div class="wildcard-row" data-pattern="${escapeHtml(wc.pattern)}">
                <div class="wildcard-info">
                  <span class="wildcard-pattern">${escapeHtml(wc.pattern)}</span>
                  <span class="wildcard-arrow">&#x2192;</span>
                  <span class="wildcard-dest">${escapeHtml(wc.destination)}</span>
                  ${wc.description ? `<span class="wildcard-desc">${escapeHtml(wc.description)}</span>` : ''}
                </div>
                <div class="wildcard-actions">
                  <button class="btn-wc-edit" data-pattern="${escapeHtml(wc.pattern)}">Edit</button>
                  <button class="btn-wc-delete" data-pattern="${escapeHtml(wc.pattern)}">&#x2715;</button>
                </div>
              </div>`).join('')
        }
      </div>
    </div>
  `;

  // ── FILE MAP (with size column, fills full height) ─────────────────────────
  const mapHtml = `
    <div class="detail-card detail-card-full-height">
      <div class="detail-card-header">
        <div class="detail-card-title">FILE MAP (${fileEntries.length})</div>
        <button class="btn-secondary" style="font-size:11px;padding:4px 10px" id="btnRebuildMapDetail">↻ Rebuild</button>
      </div>
      <div class="detail-card-body" style="padding:10px 12px;display:flex;flex-direction:column;flex:1;min-height:0">
        <input type="text" class="map-search" id="mapSearch" placeholder="Filter by filename…" />
        <div class="map-entries map-entries-tall" id="mapEntries">
          <div class="map-header-row">
            <div class="map-col-name">File Name</div>
            <div class="map-col-dest">Path</div>
            <div class="map-col-size">Size</div>
            <div class="map-col-wildcard">Wildcard</div>
          </div>
          <div id="mapEntriesLoading" style="color:var(--text-muted);font-size:11px;padding:8px 4px">Loading sizes…</div>
        </div>
      </div>
    </div>
  `;

  // ── COLLISION ALERT ────────────────────────────────────────────────────────
  let collisionHtml = '';
  if (collisions.length > 0) {
    const itemsHtml = collisions.map(c => `<li>${escapeHtml(c)}</li>`).join('');
    collisionHtml = `
      <div class="attention-banner" style="margin-bottom:16px">
        <div class="attention-icon">🚨</div>
        <div class="attention-body">
          <h3>⚠ FILENAME COLLISIONS IN MAP</h3>
          <p>These filenames exist in multiple locations. Only the last scanned path is mapped:</p>
          <ul>${itemsHtml}</ul>
        </div>
      </div>
    `;
  }

  // ── NEW LAYOUT: 2 columns — Col1 (3 stacked cards) | Col2 (tall file map) ──
  els.projectDetailContent.innerHTML = `
    ${collisionHtml}
    <div class="detail-grid-v2" style="grid-template-columns:1fr 1fr">
      <div class="detail-col-left">
        ${infoHtml}
        ${runLogHtml}
        ${unmatchedHtml}
        ${wildcardsHtml}
      </div>
      <div class="detail-col-right">
        ${mapHtml}
      </div>
    </div>
  `;

  // ── Bind buttons ──────────────────────────────────────────────────────────
  on('btnEditExclusions', 'click', () => openExclusionsModal(details.name));
  on('btnOpenProjectFolder', 'click', () => zm.openProjectFolder(details.name));

  // Wildcard: add
  on('btnAddWildcard', 'click', () => openWildcardModal(details.name, null));

  // Wildcard: edit & delete (delegated)
  document.querySelectorAll('.btn-wc-edit').forEach(btn => {
    btn.addEventListener('click', () => {
      const wc = (map.wildcards || []).find(w => w.pattern === btn.dataset.pattern);
      if (wc) openWildcardModal(details.name, wc);
    });
  });
  document.querySelectorAll('.btn-wc-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Remove wildcard pattern "' + btn.dataset.pattern + '"?')) return;
      await zm.removeWildcard(details.name, btn.dataset.pattern);
      openProject(details.name);
    });
  });
  on('btnRebuildMapDetail', 'click', () => rebuildMap(details.name));

  const btnViewLog = $('btnViewLog');
  if (btnViewLog) btnViewLog.addEventListener('click', () => zm.openRunLog(details.name));

  const btnClearLog = $('btnClearLog');
  if (btnClearLog) {
    btnClearLog.addEventListener('click', async () => {
      if (!confirm('Clear all run history for "' + details.name + '"? This cannot be undone.')) return;
      const res = await zm.clearRunLog(details.name);
      if (res.success) openProject(details.name);
      else alert('Failed: ' + res.error);
    });
  }

  // Zip archive count + clear
  zm.getZipArchiveCount(details.name).then(r => {
    const el = $('zipArchiveCount');
    if (el && r.success) el.textContent = r.count + ' archived';
  });
  const btnClearArchive = $('btnClearArchive');
  if (btnClearArchive) {
    btnClearArchive.addEventListener('click', async () => {
      const countRes = await zm.getZipArchiveCount(details.name);
      const count = countRes.success ? countRes.count : '?';
      if (!confirm('Delete all ' + count + ' archived zip files for "' + details.name + '"?')) return;
      const res = await zm.clearZipArchive(details.name);
      if (res.success) { alert('Deleted ' + res.count + ' zip file(s).'); openProject(details.name); }
      else alert('Failed: ' + res.error);
    });
  }



  // ── Map search filter — works on live DOM including async-loaded entries ──
  $('mapSearch').addEventListener('input', e => {
    filterMapEntries(e.target.value);
  });

  // ── Load file sizes async then render map entries ─────────────────────────
  zm.getMapWithSizes(details.name).then(res => {
    const mapContainer = $('mapEntries');
    if (!mapContainer) return;
    const filesWithSizes = res.success ? (res.map.filesWithSizes || {}) : {};

    const excludedFilesSet = new Set((map.excludedFiles || []).map(f => f.toLowerCase()));
    const wildcardPatterns = map.wildcards || [];

    // Build a lookup: filename → which wildcard pattern covers it
    function getWildcardForFile(fname) {
      for (const wc of wildcardPatterns) {
        // Must handle [*] BEFORE escaping other chars
        let p = wc.pattern.replace(/\[\*\]/g, '\x00SC\x00');
        p = p.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        p = p.replace(/\x00SC\x00/g, '.');
        p = p.replace(/\*/g, '.*');
        if (new RegExp('^' + p + '$', 'i').test(fname)) return wc.pattern;
      }
      return null;
    }

    const entriesHtml = fileEntries.map(([filename, dest]) => {
      const info = filesWithSizes[filename] || {};
      const isExcluded = excludedFilesSet.has(filename.toLowerCase());
      const matchingWildcard = getWildcardForFile(filename);
      const size = isExcluded ? '—' : (info.size != null
        ? (info.size < 1024 ? info.size+'B' : info.size < 1048576 ? (info.size/1024).toFixed(1)+'KB' : (info.size/1048576).toFixed(2)+'MB')
        : '—');
      return `
        <div class="map-entry ${isExcluded ? 'map-entry-excluded' : ''}" data-filename="${escapeHtml(filename)}" data-dest="${escapeHtml(dest)}">
          <div class="map-col-name map-entry-name">${escapeHtml(filename)}${collisions.includes(filename) ? ' <span class="map-collision-tag">!</span>' : ''}</div>
          <div class="map-col-dest map-entry-dest ${isExcluded ? 'excluded-path' : ''}">${isExcluded ? 'excluded' : escapeHtml(dest)}</div>
          <div class="map-col-size">${size}</div>
          <div class="map-col-wildcard">${matchingWildcard ? `<span class="wildcard-match-tag" title="Matched by wildcard">${escapeHtml(matchingWildcard)}</span>` : ''}</div>
        </div>
      `;
    }).join('');

    // Replace loading indicator, keep header
    const loading = $('mapEntriesLoading');
    if (loading) loading.remove();
    mapContainer.insertAdjacentHTML('beforeend', entriesHtml);

    // Rebind click handlers
    mapContainer.querySelectorAll('.map-entry').forEach(el => {
      el.addEventListener('click', () => openMapEntryEditor(details.name, el.dataset.filename, el.dataset.dest));
    });
    // Re-apply any active filter after async load
    const searchEl = $('mapSearch');
    if (searchEl && searchEl.value) filterMapEntries(searchEl.value);
  });
}

// ─── Map Entry Editor ─────────────────────────────────────────────────────────

function openMapEntryEditor(projectName, filename, currentDest, callback) {
  els.mapEntryFilename.textContent = filename;
  els.inputMapEntryDest.value = currentDest || '';
  els.mapEntryError.style.display = 'none';
  mapEntryCallback = callback || null;

  els.modalMapEntry.style.display = 'flex';
  els.inputMapEntryDest.focus();

  // Store context
  els.modalMapEntry.dataset.projectName = projectName;
  els.modalMapEntry.dataset.filename = filename;
}

async function saveMapEntry() {
  const projectName = els.modalMapEntry.dataset.projectName;
  const filename = els.modalMapEntry.dataset.filename;
  const destination = els.inputMapEntryDest.value.trim();

  if (!destination) {
    els.mapEntryError.textContent = 'Please enter a destination path.';
    els.mapEntryError.style.display = 'block';
    return;
  }

  showLoading('Updating map…');
  const res = await zm.updateMapEntry(projectName, filename, destination);
  hideLoading();

  if (!res.success) {
    els.mapEntryError.textContent = res.error;
    els.mapEntryError.style.display = 'block';
    return;
  }

  els.modalMapEntry.style.display = 'none';
  if (mapEntryCallback) mapEntryCallback();

  // Refresh project view
  if (state.currentProject === projectName) {
    openProject(projectName);
  }
}

// ─── New Project Wizard ───────────────────────────────────────────────────────

let wizardFolderData = [];   // [{ name, fromGitignore }]

function openNewProjectModal() {
  els.inputProjectName.value = '';
  els.inputDestRoot.value = '';
  $('chkHasGitignore').checked = false;
  els.createProjectError.style.display = 'none';
  // Reset to step 1
  $('wizardStep1').style.display = 'block';
  $('wizardStep2').style.display = 'none';
  $('wizardStepNum').textContent = '1';
  els.modalNewProject.style.display = 'flex';
  els.inputProjectName.focus();
}

function closeNewProjectModal() {
  els.modalNewProject.style.display = 'none';
  wizardFolderData = [];
}

async function wizardAdvanceToStep2() {
  const name = els.inputProjectName.value.trim();
  const dest = els.inputDestRoot.value.trim();
  const hasGitignore = $('chkHasGitignore').checked;

  els.createProjectError.style.display = 'none';

  if (!name) {
    els.createProjectError.textContent = 'Please enter a project name.';
    els.createProjectError.style.display = 'block';
    return;
  }
  if (!dest) {
    els.createProjectError.textContent = 'Please select a destination root folder.';
    els.createProjectError.style.display = 'block';
    return;
  }

  // Show step 2
  $('wizardStep1').style.display = 'none';
  $('wizardStep2').style.display = 'block';
  $('wizardStepNum').textContent = '2';
  $('folderChecklist').style.display = 'none';
  $('folderChecklistLoading').style.display = 'flex';
  $('folderChecklistError').style.display = 'none';

  // Scan folders + optionally parse gitignore in parallel
  const [foldersRes, gitignoreRes] = await Promise.all([
    zm.scanRootFolders(dest),
    hasGitignore ? zm.parseGitignore(dest) : Promise.resolve({ success: true, excluded: [] })
  ]);

  $('folderChecklistLoading').style.display = 'none';

  if (!foldersRes.success) {
    $('folderChecklistError').textContent = 'Could not scan destination: ' + foldersRes.error;
    $('folderChecklistError').style.display = 'block';
    return;
  }

  const gitignoreExcluded = new Set(
    (gitignoreRes.excluded || []).map(f => f.toLowerCase())
  );

  wizardFolderData = foldersRes.folders.map(name => ({
    name,
    fromGitignore: gitignoreExcluded.has(name.toLowerCase())
  }));

  renderFolderChecklist('folderChecklist', wizardFolderData);
  $('folderChecklist').style.display = 'flex';
}

function renderFolderChecklist(containerId, folderData) {
  const container = $(containerId);

  if (folderData.length === 0) {
    container.innerHTML = '<div class="folder-checklist-empty">No subfolders found in destination root.</div>';
    return;
  }

  container.innerHTML = folderData.map((f, i) => `
    <label class="folder-check-item">
      <input type="checkbox" data-index="${i}" ${f.fromGitignore ? '' : 'checked'} />
      <span class="folder-check-name">${escapeHtml(f.name)}</span>
      ${f.fromGitignore ? '<span class="folder-gitignore-tag">.gitignore</span>' : ''}
    </label>
  `).join('');
}

function getCheckedFolderNames(containerId) {
  // Returns array of folder names that are UNCHECKED (= excluded)
  const excluded = [];
  $(containerId).querySelectorAll('input[type="checkbox"]').forEach(cb => {
    const idx = parseInt(cb.dataset.index, 10);
    const folder = wizardFolderData[idx] || exclusionFolderData[idx];
    if (folder && !cb.checked) {
      excluded.push(folder.name);
    }
  });
  return excluded;
}

function getExclusionCheckedNames(containerId, folderData) {
  const excluded = [];
  $(containerId).querySelectorAll('input[type="checkbox"]').forEach((cb, i) => {
    if (!cb.checked) excluded.push(folderData[i].name);
  });
  return excluded;
}

async function createProject() {
  const name = els.inputProjectName.value.trim();
  const dest = els.inputDestRoot.value.trim();

  // Collect excluded folders from checklist
  const excluded = getCheckedFolderNames('folderChecklist');

  showLoading('Creating project and building file map…');
  closeNewProjectModal();

  const res = await zm.createProject(name, dest, excluded);
  hideLoading();

  if (!res.success) {
    showAlert('alert-danger', 'Failed to Create Project', escapeHtml(res.error));
    return;
  }

  const stateRes = await zm.getState();
  applyState(stateRes);
  openProject(name);
}

// ─── Edit Exclusions Modal ────────────────────────────────────────────────────

let exclusionFolderData = [];   // [{ name, fromGitignore:false }]
let exclusionProjectName = null;

async function openExclusionsModal(projectName) {
  exclusionProjectName = projectName;
  const project = state.projects.find(p => p.name === projectName);
  if (!project) return;

  // Pre-fill excluded files from the live map (not the project summary)
  // Use currentProjectDetails if available, otherwise fetch fresh
  let currentExcludedFiles = [];
  if (state.currentProjectDetails && state.currentProjectDetails.name === projectName) {
    currentExcludedFiles = (state.currentProjectDetails.map && state.currentProjectDetails.map.excludedFiles) || [];
  } else {
    const mapRes = await zm.getProjectMap(projectName);
    currentExcludedFiles = (mapRes.success && mapRes.map && mapRes.map.excludedFiles) || [];
  }
  const filesField = $('inputExcludedFiles');
  if (filesField) filesField.value = currentExcludedFiles.join(', ');

  exclusionFolderData = [];
  $('exclusionChecklist').style.display = 'none';
  $('exclusionChecklistLoading').style.display = 'flex';
  $('exclusionChecklistError').style.display = 'none';
  $('modalExclusions').style.display = 'flex';

  const foldersRes = await zm.scanRootFolders(project.destinationRoot);
  $('exclusionChecklistLoading').style.display = 'none';

  if (!foldersRes.success) {
    $('exclusionChecklistError').textContent = 'Could not scan destination: ' + foldersRes.error;
    $('exclusionChecklistError').style.display = 'block';
    return;
  }

  const currentExcludedFolders = new Set((project.excludedFolders || []).map(f => f.toLowerCase()));
  exclusionFolderData = foldersRes.folders.map(name => ({
    name,
    excluded: currentExcludedFolders.has(name.toLowerCase())
  }));

  const container = $('exclusionChecklist');
  if (exclusionFolderData.length === 0) {
    container.innerHTML = '<div class="folder-checklist-empty">No subfolders found.</div>';
  } else {
    container.innerHTML = exclusionFolderData.map((f, i) => `
      <label class="folder-check-item">
        <input type="checkbox" data-index="${i}" ${f.excluded ? '' : 'checked'} />
        <span class="folder-check-name">${escapeHtml(f.name)}</span>
      </label>
    `).join('');
  }
  container.style.display = 'flex';
}

async function saveExclusions() {
  if (!exclusionProjectName) return;

  // Collect excluded folders = unchecked
  const newExcludedFolders = [];
  $('exclusionChecklist').querySelectorAll('input[type="checkbox"]').forEach((cb, i) => {
    if (!cb.checked) newExcludedFolders.push(exclusionFolderData[i].name);
  });

  // Collect excluded files from comma-separated input
  const filesRaw = ($('inputExcludedFiles') || {}).value || '';
  const newExcludedFiles = filesRaw.split(',')
    .map(f => f.trim()).filter(f => f.length > 0);

  const includedCount = exclusionFolderData.length - newExcludedFolders.length;
  // Confirm BEFORE hiding the modal so it stays open if user cancels
  if (!confirm('Rebuilding will re-scan ' + includedCount + ' folder' + (includedCount !== 1 ? 's' : '') + '. Continue?')) return;

  $('modalExclusions').style.display = 'none';
  showLoading('Updating exclusions and rebuilding map…');

  // Save excluded files first (no rebuild needed for files)
  await zm.updateProjectSettings(exclusionProjectName, { excludedFiles: newExcludedFiles });

  // Then rebuild with new folder exclusions
  const res = await zm.updateExclusions(exclusionProjectName, newExcludedFolders);
  hideLoading();

  if (!res.success) {
    showAlert('alert-danger', 'Rebuild Failed', escapeHtml(res.error));
    return;
  }

  const stateRes = await zm.getState();
  applyState(stateRes);

  if (state.currentProject === exclusionProjectName) {
    await openProject(exclusionProjectName);  // refreshes state.currentProjectDetails
  }
}

async function rebuildMap(name) {
  showLoading('Scanning destination and rebuilding map…');
  const res = await zm.rebuildMap(name);
  hideLoading();

  if (!res.success) {
    showAlert('alert-danger', 'Map Rebuild Failed', escapeHtml(res.error));
    return;
  }

  const map = res.map;
  if (map.collisions && map.collisions.length > 0) {
    // Will be shown in detail view
  }

  // Refresh state & view
  const stateRes = await zm.getState();
  applyState(stateRes);

  if (state.currentProject === name) {
    openProject(name);
  }
}

// ─── Settings ─────────────────────────────────────────────────────────────────

function renderSettings() {
  const cfg = state.config;
  els.settingsContent.innerHTML = `
    <div class="settings-section">
      <div class="settings-section-title">BACKUP RETENTION</div>
      <div class="settings-body">
        <div class="settings-row">
          <div class="settings-label">
            <strong>Keep Last N Runs</strong>
            <span>Backup files older than N runs are automatically deleted per project.</span>
          </div>
          <input type="number" class="settings-input" id="inputRetention" min="1" max="100" value="${cfg.backupRetentionRuns || 10}" />
        </div>
      </div>
    </div>

    <div class="settings-section">
      <div class="settings-section-title">ZIP ARCHIVE NAMING</div>
      <div class="settings-body">
        <div class="settings-row">
          <div class="settings-label">
            <strong>Archive Filename Pattern</strong>
            <span>Tokens: {NNN} = run number, {YYYY}{MM}{DD} = date, {HH}{mm} = time, {originalName} = original zip name.</span>
          </div>
          <input type="text" class="settings-input settings-input-wide" id="inputZipPattern" value="${escapeHtml(cfg.zipArchivePattern || '')}" />
        </div>
      </div>
    </div>

    <div class="settings-section">
      <div class="settings-section-title">WATCHER</div>
      <div class="settings-body">
        <div class="settings-row">
          <div class="settings-label">
            <strong>Debounce Delay (ms)</strong>
            <span>How long to wait after a zip file appears before processing. Prevents partial-download issues.</span>
          </div>
          <input type="number" class="settings-input" id="inputDebounce" min="500" max="10000" step="100" value="${cfg.watcherDebounceMs || 1500}" />
        </div>
      </div>
    </div>

    <div class="settings-section">
      <div class="settings-section-title">ZIPMOVER ROOT FOLDER</div>
      <div class="settings-body">
        <div class="settings-row">
          <div class="settings-label">
            <strong>Root Folder</strong>
            <span>Project subfolders are created here. You drop zip files into these subfolders.</span>
          </div>
          <button class="btn-open-root" id="btnOpenRootSettings">&#x1F4C2; Open</button>
        </div>
        <div class="root-path-display">
          <span class="root-path-value">${escapeHtml(cfg.appRoot || '—')}</span>
          <button class="btn-edit-exclusions" id="btnChangeRoot">Change…</button>
        </div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:4px">
          Note: changing the root folder does not move existing project folders.
        </div>
      </div>
    </div>

    <div style="display:flex;justify-content:flex-end;margin-top:8px">
      <button class="btn-primary" id="btnSaveSettings">Save Settings</button>
    </div>
  `;

  $('btnOpenRootSettings').addEventListener('click', () => zm.openRootFolder());

  $('btnChangeRoot').addEventListener('click', async () => {
    const res = await zm.browseZipMoverRoot();
    if (!res.success) return;
    if (!confirm(`Change ZipMover root to:\n${res.path}\n\nExisting project folders will not be moved.`)) return;
    showLoading('Changing root folder…');
    const changeRes = await zm.changeAppRoot(res.path);
    hideLoading();
    if (!changeRes.success) {
      alert('Failed to change root: ' + changeRes.error);
      return;
    }
    const stateRes = await zm.getState();
    applyState(stateRes);
    renderSettings(); // Re-render to show new path
  });

  $('btnSaveSettings').addEventListener('click', async () => {
    const retention = parseInt($('inputRetention').value, 10);
    const pattern   = $('inputZipPattern').value.trim();
    const debounce  = parseInt($('inputDebounce').value, 10);

    if (isNaN(retention) || retention < 1) { alert('Invalid retention value'); return; }
    if (!pattern) { alert('Pattern cannot be empty'); return; }
    if (isNaN(debounce) || debounce < 500) { alert('Debounce must be at least 500ms'); return; }

    showLoading('Saving settings…');
    await zm.updateConfig({ backupRetentionRuns: retention, zipArchivePattern: pattern, watcherDebounceMs: debounce });
    const stateRes = await zm.getState();
    applyState(stateRes);
    hideLoading();

    showView('viewDashboard');
    state.currentProject = null;
    renderSidebar();
    renderDashboard();
    showAlert('alert-success', 'Settings Saved', 'Your configuration has been updated.', true);
  });
}

// ─── State Application ────────────────────────────────────────────────────────

function applyState(newState) {
  state.projects = newState.projects || [];
  state.config = newState.config || {};
  state.watcherStatus = newState.watcherStatus || {};
  if (newState.appVersion) {
    document.querySelectorAll('.version-tag').forEach(el => {
      el.textContent = 'v' + newState.appVersion;
    });
  }
  renderSidebar();
  renderDashboard();
}

// ─── Setup Screen ─────────────────────────────────────────────────────────────

function showSetupScreen() {
  // Hide sidebar during setup
  document.getElementById('sidebar').style.display = 'none';
  showView('viewSetup');
}

function hideSetupScreen() {
  document.getElementById('sidebar').style.display = '';
}

async function confirmSetup() {
  const folderPath = $('inputSetupRoot').value.trim();
  $('setupError').style.display = 'none';

  if (!folderPath) {
    $('setupError').textContent = 'Please choose a root folder first.';
    $('setupError').style.display = 'block';
    return;
  }

  showLoading('Setting up ZipMover…');
  const res = await zm.setAppRoot(folderPath);
  hideLoading();

  if (!res.success) {
    $('setupError').textContent = res.error || 'Setup failed. Please try again.';
    $('setupError').style.display = 'block';
    return;
  }

  hideSetupScreen();
  const stateRes = await zm.getState();
  applyState(stateRes);
  showView('viewDashboard');
}

// ─── Processing / Completion Alert ───────────────────────────────────────────

function showProcessingAlert(projectName, zipName) {
  els.alertBanner.className = 'alert-banner alert-info';
  els.alertBanner.innerHTML = `
    <div class="alert-icon">📦</div>
    <div class="alert-body">
      <div class="alert-title">Zip Detected — ${escapeHtml(projectName)}</div>
      <div class="alert-message processing-msg">Processing <strong>${escapeHtml(zipName)}</strong>…</div>
    </div>
  `;
  els.alertBanner.style.display = 'flex';
  els.alertBanner.dataset.processingProject = projectName;
}

function resolveProcessingAlert(projectName, result) {
  // Only update if the banner is still showing the processing state for this project
  const isMatch = els.alertBanner.dataset.processingProject === projectName;
  const isProcessingMsg = els.alertBanner.querySelector('.processing-msg');

  const statusIcon  = result.status === 'success' ? '✅' : result.status === 'completed_with_errors' ? '⚠' : '✗';
  const statusClass = result.status === 'success' ? 'alert-success' : result.status === 'completed_with_errors' ? 'alert-warning' : 'alert-danger';
  const statusText  = result.status === 'success' ? 'Complete' : result.status === 'completed_with_errors' ? 'Complete with warnings' : 'Failed';
  const summary     = `${result.filesDeployed.length} deployed` +
    (result.filesUnmatched.length ? `, ${result.filesUnmatched.length} unmatched` : '') +
    (result.errors.length ? `, ${result.errors.length} error(s)` : '');

  els.alertBanner.className = `alert-banner ${statusClass}`;
  els.alertBanner.innerHTML = `
    <div class="alert-icon">${statusIcon}</div>
    <div class="alert-body">
      <div class="alert-title">${statusText} — ${escapeHtml(projectName)} — Run #${result.runNumber}</div>
      <div class="alert-message">${escapeHtml(result.zipName)} · ${summary}</div>
    </div>
    <button class="alert-dismiss" id="alertDismiss" title="Dismiss">✕</button>
  `;
  els.alertBanner.style.display = 'flex';
  delete els.alertBanner.dataset.processingProject;

  $('alertDismiss').addEventListener('click', () => {
    els.alertBanner.style.display = 'none';
  });
}

// ─── Dashboard Drop Handler ───────────────────────────────────────────────────

async function handleDashboardDrop(e, el, projectName) {
  e.preventDefault();
  e.stopPropagation();
  el.classList.remove('drag-over');

  // Collect files using items API (more reliable in Electron contextIsolation)
  const fileList = [];
  if (e.dataTransfer.items) {
    for (const item of e.dataTransfer.items) {
      if (item.kind === 'file') {
        const f = item.getAsFile();
        if (f) fileList.push(f);
      }
    }
  } else {
    fileList.push(...e.dataTransfer.files);
  }

  if (fileList.length === 0) return;

  for (const file of fileList) {
    el.classList.add('drop-processing');
    showAlert('alert-info', `📦 Processing — ${projectName}`, `Deploying <strong>${escapeHtml(file.name)}</strong>…`, false);

    // Try webUtils.getPathForFile first (Electron 28+ with contextIsolation)
    // Fall back to file.path (older Electron) then file.name as last resort indicator
    let filePath = null;
    try { filePath = zm.getPathForFile(file); } catch (_) {}
    if (!filePath) filePath = file.path || null;

    console.log('[Drop] file.name:', file.name, '| resolved path:', filePath);

    if (!filePath) {
      el.classList.remove('drop-processing');
      showAlert('alert-danger', 'Drop Failed', `Could not resolve path for "${escapeHtml(file.name)}". Open DevTools (Ctrl+Shift+I) and check console for details.`, true);
      continue;
    }
    const res = await zm.handleDrop(projectName, filePath);
    console.log('[Drop] handleDrop result:', JSON.stringify({ success: res.success, action: res.action, status: res.result && res.result.status }));
    el.classList.remove('drop-processing');

    if (!res.success) {
      el.classList.add('drop-error'); setTimeout(() => el.classList.remove('drop-error'), 1500);
      showAlert('alert-danger', 'Drop Failed', escapeHtml(res.error), true);
      return;
    }

    if (res.action === 'conflict') {
      showConflictDialog(res.filename, res.filePath, res.conflicts);
      return;
    }

    el.classList.add('drop-success'); setTimeout(() => el.classList.remove('drop-success'), 1800);
    const result = res.result;
    resolveProcessingAlert(projectName, result);
    state.lastRunResult = { projectName, result };
    const newState = await zm.getState();
    applyState(newState);
    renderRunSummary(projectName, result);
  }
}

function showConflictDialog(filename, filePath, projectNames) {
  const choice = projectNames.length > 0
    ? window.prompt(`"${filename}" matches multiple projects:\n${projectNames.join(', ')}\n\nType the exact project name to deploy to:`)
    : null;
  if (!choice) return;
  const matched = projectNames.find(n => n.toLowerCase() === choice.toLowerCase());
  if (!matched) { alert('No matching project found.'); return; }
  zm.resolveConflict(matched, filename, filePath).then(async res => {
    if (res.success) {
      const newState = await zm.getState();
      applyState(newState);
      renderRunSummary(matched, res.result);
    }
  });
}

// ─── Wildcard Modal ───────────────────────────────────────────────────────────

let _wildcardProjectName = null;
let _wildcardEditingPattern = null;

function openWildcardModal(projectName, existingWc) {
  _wildcardProjectName = projectName;
  _wildcardEditingPattern = existingWc ? existingWc.pattern : null;

  $('wildcardModalTitle').textContent = existingWc ? 'Edit Wildcard Pattern' : 'Add Wildcard Pattern';
  $('inputWcPattern').value    = existingWc ? existingWc.pattern     : '';
  $('inputWcDestination').value = existingWc ? existingWc.destination : '{root}\\{filename}';
  $('inputWcDescription').value = existingWc ? (existingWc.description || '') : '';
  $('wildcardError').style.display = 'none';
  $('modalWildcard').style.display = 'flex';
  $('inputWcPattern').focus();
}

async function saveWildcard() {
  const pattern     = $('inputWcPattern').value.trim();
  const destination = $('inputWcDestination').value.trim();
  const description = $('inputWcDescription').value.trim();

  $('wildcardError').style.display = 'none';

  if (!pattern) {
    $('wildcardError').textContent = 'Please enter a pattern.';
    $('wildcardError').style.display = 'block';
    return;
  }
  if (!destination) {
    $('wildcardError').textContent = 'Please enter a destination path.';
    $('wildcardError').style.display = 'block';
    return;
  }
  if (!destination.includes('{filename}')) {
    $('wildcardError').textContent = 'Destination must include {filename} token.';
    $('wildcardError').style.display = 'block';
    return;
  }

  $('modalWildcard').style.display = 'none';

  let res;
  if (_wildcardEditingPattern) {
    res = await zm.updateWildcard(_wildcardProjectName, _wildcardEditingPattern, { pattern, destination, description });
  } else {
    res = await zm.addWildcard(_wildcardProjectName, pattern, destination, description);
  }

  if (!res.success) {
    showAlert('alert-danger', 'Wildcard Error', escapeHtml(res.error), true);
    return;
  }

  openProject(_wildcardProjectName);
}

// ─── Event Bindings ───────────────────────────────────────────────────────────

// Safe element binder — logs warning instead of crashing on missing elements
function on(id, event, handler) {
  const el = document.getElementById(id);
  if (el) el.addEventListener(event, handler);
  else console.warn('[ZipMover] Missing DOM element:', id);
}

function bindEvents() {
  // CRITICAL: Prevent default on document-level drag events.
  // Without this, OS-level file drops (from Windows Explorer) are rejected
  // before they reach any child element's drop handler.
  document.addEventListener('dragover',  e => { e.preventDefault(); e.stopPropagation(); });
  document.addEventListener('dragleave', e => { e.preventDefault(); e.stopPropagation(); });
  document.addEventListener('drop',      e => {
    e.preventDefault();
    e.stopPropagation();
    // If a file lands on the document body (missed the zone), log it
    if (!e.target.closest('.drop-zone-target')) {
      console.log('[Drop] Missed zone — landed on:', e.target.className || e.target.tagName,
        '| files:', Array.from(e.dataTransfer.files).map(f => f.name));
    }
  });

  // Setup screen
  $('btnBrowseSetupRoot').addEventListener('click', async () => {
    const res = await zm.browseZipMoverRoot();
    if (res.success) $('inputSetupRoot').value = res.path;
  });
  $('inputSetupRoot').addEventListener('keydown', e => { if (e.key === 'Enter') confirmSetup(); });
  $('btnConfirmSetup').addEventListener('click', confirmSetup);

  // Open ZipMover root folder from dashboard header
  on('btnOpenRootFolder', 'click', () => zm.openRootFolder());

  // New project wizard
  $('btnNewProject').addEventListener('click', openNewProjectModal);
  $('btnNewProjectEmpty').addEventListener('click', openNewProjectModal);
  $('btnModalClose').addEventListener('click', closeNewProjectModal);
  $('btnModalCancel').addEventListener('click', closeNewProjectModal);

  // Step 1 → Step 2
  $('btnWizardNext').addEventListener('click', wizardAdvanceToStep2);
  $('inputProjectName').addEventListener('keydown', e => { if (e.key === 'Enter') els.inputDestRoot.focus(); });

  // Step 2 → back / create
  $('btnWizardBack').addEventListener('click', () => {
    $('wizardStep2').style.display = 'none';
    $('wizardStep1').style.display = 'block';
    $('wizardStepNum').textContent = '1';
  });
  $('btnModalCreate').addEventListener('click', createProject);

  // Check all / uncheck all in wizard checklist
  $('btnCheckAll').addEventListener('click', () => {
    $('folderChecklist').querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = true);
  });
  $('btnUncheckAll').addEventListener('click', () => {
    $('folderChecklist').querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
  });

  // Browse folder
  $('btnBrowse').addEventListener('click', async () => {
    const res = await zm.browseFolder();
    if (res.success) els.inputDestRoot.value = res.path;
  });

  // Exclusions modal
  $('btnExclusionsClose').addEventListener('click', () => { $('modalExclusions').style.display = 'none'; });
  $('btnExclusionsCancel').addEventListener('click', () => { $('modalExclusions').style.display = 'none'; });
  $('btnExclusionsSave').addEventListener('click', saveExclusions);
  $('btnExclusionCheckAll').addEventListener('click', () => {
    $('exclusionChecklist').querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = true);
  });
  $('btnExclusionUncheckAll').addEventListener('click', () => {
    $('exclusionChecklist').querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
  });

  // Map entry modal
  $('btnMapEntryClose').addEventListener('click', () => { els.modalMapEntry.style.display = 'none'; });
  $('btnMapEntryCancel').addEventListener('click', () => { els.modalMapEntry.style.display = 'none'; });
  $('btnMapEntrySave').addEventListener('click', saveMapEntry);
  $('inputMapEntryDest').addEventListener('keydown', e => { if (e.key === 'Enter') saveMapEntry(); });

  // Back buttons
  $('btnBack').addEventListener('click', () => {
    state.currentProject = null;
    renderSidebar();
    showView('viewDashboard');
  });

  $('btnBackFromSettings').addEventListener('click', () => {
    showView('viewDashboard');
  });

  // Rebuild map (header button on project view)
  $('btnRebuildMap').addEventListener('click', () => {
    if (state.currentProject) rebuildMap(state.currentProject);
  });

  // Delete project
  $('btnDeleteProject').addEventListener('click', async () => {
    if (!state.currentProject) return;
    if (!confirm(`Delete project "${state.currentProject}"?\n\nThe project folder on disk is kept; only the tracking record is removed.`)) return;

    showLoading('Removing project…');
    const res = await zm.deleteProject(state.currentProject);
    hideLoading();

    if (!res.success) {
      alert('Delete failed: ' + res.error);
      return;
    }

    state.currentProject = null;
    const stateRes = await zm.getState();
    applyState(stateRes);
    showView('viewDashboard');
  });

  // Settings
  on('btnCompact', 'click', () => zm.openCompact());

  $('btnSettings').addEventListener('click', () => {
    renderSettings();
    showView('viewSettings');
  });

  // ── IPC event listeners ──

  zm.onStateUpdate(newState => {
    // Only apply passive state updates (watcher status changes etc.)
    // onRunComplete handles its own full refresh — don't double-apply
    applyState(newState);
  });

  zm.onWatcherEvent(evt => {
    if (evt.type === 'zip-detected') {
      showProcessingAlert(evt.projectName, evt.zipName);
      if (!state.watcherStatus[evt.projectName]) state.watcherStatus[evt.projectName] = {};
      state.watcherStatus[evt.projectName].lastEvent = { type: 'processing', zipName: evt.zipName };
      renderSidebar();
      renderDashboard();
    }
    if (evt.type === 'watcher-started' || evt.type === 'watcher-stopped') {
      zm.getState().then(applyState);
    }
  });

  zm.onRunComplete(({ projectName, result }) => {
    state.lastRunResult = { projectName, result };

    // Small delay to let sendStateUpdate from main arrive first,
    // then fetch fresh state for accurate lastRun/fileCount
    setTimeout(() => {
      zm.getState().then(newState => {
        applyState(newState);

        // Navigate to dashboard and show summary
        state.currentProject = null;
        showView('viewDashboard');
        renderSidebar();
        renderDashboard();

        // Resolve "Processing…" → completion banner
        resolveProcessingAlert(projectName, result);
        renderRunSummary(projectName, result);

        if (result.collisionAlerts && result.collisionAlerts.length > 0) {
          showAttentionAlert(
            '⚠ FILENAME COLLISION DETECTED',
            'The following filenames exist in multiple destination paths. Only one was used. Review and fix the map:',
            result.collisionAlerts
          );
        }
      });
    }, 150);
  });

  zm.onAppError(message => {
    showAlert('alert-danger', 'Application Error', escapeHtml(message), true);
  });

  // Close modals on overlay click
  $('modalNewProject').addEventListener('click', e => {
    if (e.target === $('modalNewProject')) closeNewProjectModal();
  });

  $('modalMapEntry').addEventListener('click', e => {
    if (e.target === els.modalMapEntry) els.modalMapEntry.style.display = 'none';
  });

  $('modalExclusions').addEventListener('click', e => {
    if (e.target === $('modalExclusions')) $('modalExclusions').style.display = 'none';
  });

  // Wildcard modal bindings
  on('btnWildcardClose',  'click', () => { $('modalWildcard').style.display = 'none'; });
  on('btnWildcardCancel', 'click', () => { $('modalWildcard').style.display = 'none'; });
  on('btnWildcardSave',   'click', saveWildcard);
  on('btnWcBrowse', 'click', async () => {
    const res = await zm.browseFolder();
    if (res.success) {
      const dest = res.path.replace(/\\/g, '\\\\') + '\\\\{filename}';
      $('inputWcDestination').value = '{root}\\\\' + res.path.split('\\').pop() + '\\\\{filename}';
    }
  });
  on('inputWcPattern',     'keydown', e => { if (e.key === 'Enter') $('inputWcDestination').focus(); });
  on('inputWcDestination', 'keydown', e => { if (e.key === 'Enter') saveWildcard(); });

  $('modalWildcard').addEventListener('click', e => {
    if (e.target === $('modalWildcard')) $('modalWildcard').style.display = 'none';
  });
}

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  bindEvents();
  showLoading('Starting ZipMover…');

  try {
    const initialState = await zm.getState();
    console.log('[Renderer] get-state returned:', JSON.stringify({
      projectCount: initialState.projects ? initialState.projects.length : 'undefined',
      needsSetup: initialState.needsSetup,
      hasConfig: !!initialState.config,
      appVersion: initialState.appVersion
    }));
    if (initialState.needsSetup) {
      hideLoading();
      showSetupScreen();
      return;
    }
    applyState(initialState);
  } catch (err) {
    console.error('Init failed:', err);
    showAlert('alert-danger', 'Failed to load', 'Could not load initial state. Please restart the app.');
  } finally {
    hideLoading();
  }
}

document.addEventListener('DOMContentLoaded', init);
