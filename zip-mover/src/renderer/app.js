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

  // Keep the label
  const labelHtml = `<div class="project-list-label">PROJECTS</div>`;
  els.projectList.innerHTML = labelHtml + (items || '<div style="padding:8px 16px;font-size:11px;color:var(--text-muted)">No projects yet</div>');

  // Bind clicks
  els.projectList.querySelectorAll('.project-nav-item').forEach(el => {
    el.addEventListener('click', () => openProject(el.dataset.project));
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
        <div class="project-card-drop-path">
          <span class="project-card-drop-label">DROP HERE</span>
          <span class="project-card-drop-value">${escapeHtml(p.projectDir || '—')}</span>
        </div>
        <button class="btn-open-folder" data-open-project="${escapeHtml(p.name)}">📂 Open Folder</button>
      </div>
    `;
  }).join('');

  els.projectCards.querySelectorAll('.project-card').forEach(el => {
    el.addEventListener('click', (e) => {
      // Don't open project detail when clicking the Open Folder button
      if (e.target.closest('.btn-open-folder')) return;
      openProject(el.dataset.project);
    });
  });

  els.projectCards.querySelectorAll('.btn-open-folder').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      zm.openProjectFolder(el.dataset.openProject);
    });
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
      <div style="font-family:var(--font-mono);font-size:11px;color:var(--text-muted)">${duration} · ${formatDate(result.finishedAt)}</div>
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

  // Info table
  const excludedFolders = map.excludedFolders || [];
  const excludedDisplay = excludedFolders.length > 0
    ? excludedFolders.map(f => `<span class="exclusion-tag">${escapeHtml(f)}</span>`).join(' ')
    : '<span style="color:var(--text-muted);font-size:11px">None</span>';

  const infoHtml = `
    <div class="detail-card">
      <div class="detail-card-header"><div class="detail-card-title">PROJECT INFO</div></div>
      <div class="detail-card-body">
        <table class="info-table">
          <tr><td>Destination</td><td>${escapeHtml(map.destinationRoot || '—')}</td></tr>
          <tr><td>Mapped Files</td><td>${fileEntries.length}</td></tr>
          <tr><td>Map Built</td><td>${formatDate(map.builtAt)}</td></tr>
          <tr><td>Watcher</td><td>${status.active ? '<span style="color:var(--accent)">● Active</span>' : '<span style="color:var(--text-muted)">○ Inactive</span>'}</td></tr>
          <tr><td>Next Run #</td><td>${map.nextRunNumber || 1}</td></tr>
          <tr><td>Retention</td><td>${state.config.backupRetentionRuns || 10} runs</td></tr>
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

  // Collision alert
  let collisionHtml = '';
  if (collisions.length > 0) {
    const itemsHtml = collisions.map(c => `<li>${escapeHtml(c)}</li>`).join('');
    collisionHtml = `
      <div class="attention-banner" style="margin-bottom:16px">
        <div class="attention-icon">🚨</div>
        <div class="attention-body">
          <h3>⚠ FILENAME COLLISIONS IN MAP</h3>
          <p>These filenames exist in multiple locations. Only the last scanned path is mapped. Resolve by updating the map entries manually:</p>
          <ul>${itemsHtml}</ul>
        </div>
      </div>
    `;
  }

  // Map viewer
  const mapHtml = `
    <div class="detail-card">
      <div class="detail-card-header">
        <div class="detail-card-title">FILE MAP (${fileEntries.length})</div>
        <button class="btn-secondary" style="font-size:11px;padding:4px 10px" id="btnRebuildMapDetail">↻ Rebuild</button>
      </div>
      <div class="detail-card-body">
        <input type="text" class="map-search" id="mapSearch" placeholder="Filter by filename…" />
        <div class="map-entries" id="mapEntries">
          ${fileEntries.map(([filename, dest]) => `
            <div class="map-entry" data-filename="${escapeHtml(filename)}" data-dest="${escapeHtml(dest)}">
              <div class="map-entry-name">${escapeHtml(filename)}</div>
              ${collisions.includes(filename) ? '<span class="map-collision-tag">COLLISION</span>' : ''}
              <div class="map-entry-dest">${escapeHtml(dest)}</div>
            </div>
          `).join('')}
        </div>
      </div>
    </div>
  `;

  // Run log
  const runLogHtml = `
    <div class="detail-card">
      <div class="detail-card-header">
        <div class="detail-card-title">RUN HISTORY</div>
        ${runLog.length > 0 ? '<button class="btn-secondary" style="font-size:11px;padding:4px 10px" id="btnViewLog">&#x1F4CB; View Log File</button>' : ''}
      </div>
      <div class="detail-card-body" style="max-height:360px;overflow-y:auto">
        ${runLog.length === 0
          ? '<div style="color:var(--text-muted);font-size:12px">No runs yet. Drop a zip into this project folder.</div>'
          : `<table class="run-log-table">
              <thead><tr><th>Run</th><th>Zip</th><th>Status</th><th>Files</th><th>Time</th></tr></thead>
              <tbody>
                ${runLog.map(r => `
                  <tr>
                    <td>#${r.runNumber}</td>
                    <td title="${escapeHtml(r.zipName)}">${escapeHtml(r.zipName.length > 22 ? r.zipName.substring(0,22)+'…' : r.zipName)}</td>
                    <td><span class="run-status-pill ${r.status}">${r.status.replace(/_/g,' ')}</span></td>
                    <td>${r.filesDeployed.length}↑ ${r.filesUnmatched.length ? r.filesUnmatched.length+'?' : ''} ${r.errors.length ? r.errors.length+'✗' : ''}</td>
                    <td>${formatDate(r.finishedAt)}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>`
        }
      </div>
    </div>
  `;

  // Unmatched files (from NewFilesDetected)
  // We'll show a placeholder for now — in a real run these come from run results
  const unmatchedHtml = `
    <div class="detail-card">
      <div class="detail-card-header"><div class="detail-card-title">UNMATCHED FILES</div></div>
      <div class="detail-card-body">
        <div id="unmatchedFiles">
          <div style="color:var(--text-muted);font-size:12px;line-height:1.6">
            Files that had no map entry are placed in <code style="color:var(--accent);background:var(--bg-base);padding:1px 5px;border-radius:3px">NewFilesDetected/</code>.
            After a run, unmatched files will appear here for you to assign destinations.
          </div>
        </div>
      </div>
    </div>
  `;

  els.projectDetailContent.innerHTML = `
    ${collisionHtml}
    <div class="detail-grid">
      ${infoHtml}
      ${mapHtml}
    </div>
    <div class="detail-grid" style="margin-top:16px">
      ${runLogHtml}
      ${unmatchedHtml}
    </div>
  `;

  // Edit exclusions button
  $('btnEditExclusions').addEventListener('click', () => openExclusionsModal(details.name));

  // Map search filter
  $('mapSearch').addEventListener('input', e => {
    const q = e.target.value.toLowerCase();
    $('mapEntries').querySelectorAll('.map-entry').forEach(el => {
      const match = el.dataset.filename.toLowerCase().includes(q) || el.dataset.dest.toLowerCase().includes(q);
      el.style.display = match ? '' : 'none';
    });
  });

  // Map entry click → edit
  $('mapEntries').querySelectorAll('.map-entry').forEach(el => {
    el.addEventListener('click', () => openMapEntryEditor(details.name, el.dataset.filename, el.dataset.dest));
  });

  // Rebuild map button in detail
  $('btnRebuildMapDetail').addEventListener('click', () => rebuildMap(details.name));

  // View log button (only rendered when runs exist)
  const btnViewLog = $('btnViewLog');
  if (btnViewLog) {
    btnViewLog.addEventListener('click', () => zm.openRunLog(details.name));
  }
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

  const currentExcluded = new Set((project.excludedFolders || []).map(f => f.toLowerCase()));

  exclusionFolderData = foldersRes.folders.map(name => ({
    name,
    excluded: currentExcluded.has(name.toLowerCase())
  }));

  // Render checklist — checked = included (not excluded)
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

  // Collect excluded = unchecked
  const newExcluded = [];
  $('exclusionChecklist').querySelectorAll('input[type="checkbox"]').forEach((cb, i) => {
    if (!cb.checked) newExcluded.push(exclusionFolderData[i].name);
  });

  const includedCount = exclusionFolderData.length - newExcluded.length;

  if (!confirm(`Rebuilding will re-scan ${includedCount} folder${includedCount !== 1 ? 's' : ''}. Continue?`)) return;

  $('modalExclusions').style.display = 'none';
  showLoading('Updating exclusions and rebuilding map…');

  const res = await zm.updateExclusions(exclusionProjectName, newExcluded);
  hideLoading();

  if (!res.success) {
    showAlert('alert-danger', 'Rebuild Failed', escapeHtml(res.error));
    return;
  }

  const stateRes = await zm.getState();
  applyState(stateRes);

  if (state.currentProject === exclusionProjectName) {
    openProject(exclusionProjectName);
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

// ─── Event Bindings ───────────────────────────────────────────────────────────

function bindEvents() {
  // Setup screen
  $('btnBrowseSetupRoot').addEventListener('click', async () => {
    const res = await zm.browseZipMoverRoot();
    if (res.success) $('inputSetupRoot').value = res.path;
  });
  $('inputSetupRoot').addEventListener('keydown', e => { if (e.key === 'Enter') confirmSetup(); });
  $('btnConfirmSetup').addEventListener('click', confirmSetup);

  // Open ZipMover root folder from dashboard header
  $('btnOpenRootFolder').addEventListener('click', () => zm.openRootFolder());

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
  $('btnSettings').addEventListener('click', () => {
    renderSettings();
    showView('viewSettings');
  });

  // ── IPC event listeners ──

  zm.onNeedsSetup(() => {
    hideLoading();
    showSetupScreen();
  });

  zm.onStateUpdate(newState => {
    applyState(newState);
    if (state.currentProject) {
      openProject(state.currentProject);
    }
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

    zm.getState().then(newState => {
      applyState(newState);

      showView('viewDashboard');
      state.currentProject = null;
      renderSidebar();
      renderDashboard();

      // Replace the "Processing…" alert with a completion alert (dismissible)
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
}

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  bindEvents();
  showLoading('Starting ZipMover…');

  try {
    const initialState = await zm.getState();
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
