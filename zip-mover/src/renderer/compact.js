// compact.js — ZipMover compact floating panel renderer
const zm = window.zipmover;

let state = { projects: [], watcherStatus: {}, config: {} };
let pendingConflict = null;

const $ = id => document.getElementById(id);

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  bindEvents();
  const s = await zm.getState();
  applyState(s);
  resizeToFit();
}

function applyState(newState) {
  state = newState;
  renderZones();
  resizeToFit();
}

// ─── Render ───────────────────────────────────────────────────────────────────
function renderZones() {
  const dropProjects = state.projects.filter(p => p.allowDropToUI !== false);
  const container = $('compactZones');

  if (dropProjects.length === 0) {
    container.innerHTML = '<div style="color:var(--text-muted);font-size:11px;padding:16px;text-align:center;grid-column:1/-1">No active drop projects.<br>Enable "Allow Drop to UI" in project settings.</div>';
    container.classList.add('single-col');
    return;
  }

  container.classList.toggle('single-col', dropProjects.length === 1);

  container.innerHTML = dropProjects.map(p => {
    const ws = state.watcherStatus[p.name] || {};
    const isProcessing = ws.lastEvent && ws.lastEvent.type === 'processing';
    const lastRun = p.lastRun;
    const lastRunStatus = lastRun ? lastRun.status : null;

    return `
      <div class="compact-zone ${isProcessing ? 'processing' : ''}"
           data-project="${esc(p.name)}"
           id="zone-${esc(p.name)}">
        <div class="compact-watcher-dot ${ws.active ? '' : 'inactive'}"></div>
        <div class="compact-zone-icon">${isProcessing ? '⚙' : '📦'}</div>
        <div class="compact-zone-name">${esc(p.name)}</div>
        <div class="compact-zone-hint">Drop ZIP or file here</div>
        ${lastRunStatus ? (() => {
          const tip = lastRun
            ? `Run #${lastRun.runNumber} | ${lastRun.status} | ${lastRun.filesDeployed ? lastRun.filesDeployed.length : 0} deployed${lastRun.filesUnmatched && lastRun.filesUnmatched.length ? ' | '+lastRun.filesUnmatched.length+' unmatched' : ''} | ${lastRun.finishedAt ? new Date(lastRun.finishedAt).toLocaleString() : ''}`
            : '';
          return `<div class="compact-last-run ${lastRunStatus}" title="${tip.replace(/"/g,'&quot;')}">Run #${lastRun.runNumber}</div>`;
        })() : ''}
      </div>
    `;
  }).join('');

  // Bind drag-and-drop to each zone
  container.querySelectorAll('.compact-zone').forEach(el => {
    const projectName = el.dataset.project;
    el.addEventListener('dragover',  e => onDragOver(e, el));
    el.addEventListener('dragleave', e => onDragLeave(e, el));
    el.addEventListener('drop',      e => onDrop(e, el, projectName));
  });
}

function resizeToFit() {
  // Use scrollHeight for accurate measurement after render
  requestAnimationFrame(() => {
    const app = document.getElementById('compactApp');
    const height = app ? app.scrollHeight + 4 : 200;
    zm.compactResize(Math.min(Math.max(height, 100), 700));
  });
}

// ─── Drag & Drop ──────────────────────────────────────────────────────────────
function onDragOver(e, el) {
  e.preventDefault();
  e.stopPropagation();
  el.classList.add('drag-over');
  e.dataTransfer.dropEffect = 'copy';
}

function onDragLeave(e, el) {
  if (!el.contains(e.relatedTarget)) {
    el.classList.remove('drag-over');
  }
}

async function onDrop(e, el, projectName) {
  e.preventDefault();
  e.stopPropagation();
  el.classList.remove('drag-over');

  // Use items API for reliable path resolution in contextIsolation mode
  const fileList = [];
  if (e.dataTransfer.items) {
    for (const item of e.dataTransfer.items) {
      if (item.kind === 'file') { const f = item.getAsFile(); if (f) fileList.push(f); }
    }
  } else {
    fileList.push(...e.dataTransfer.files);
  }
  if (fileList.length === 0) return;

  for (const file of fileList) {
    let filePath = null;
    try { filePath = zm.getPathForFile(file); } catch (_) {}
    if (!filePath) filePath = file.path || null;
    if (!filePath) {
      setStatus('Could not resolve path for ' + file.name, 'error');
      continue;
    }
    await processDroppedFile(el, projectName, filePath);
  }
}

async function processDroppedFile(el, projectName, filePath) {
  setStatus(`Processing ${filePath.split(/[\\/]/).pop()}…`, '');
  el.classList.add('processing');

  const res = await zm.handleDrop(projectName, filePath);

  el.classList.remove('processing');

  if (!res.success) {
    setZoneError(el, res.error);
    setStatus(res.error, 'error');
    return;
  }

  if (res.action === 'conflict') {
    // Show conflict modal
    pendingConflict = { filePath, filename: res.filename, conflicts: res.conflicts };
    showConflictModal(res.filename, res.conflicts);
    return;
  }

  // Success or completed_with_errors
  const result = res.result;
  const ok = result.status === 'success';
  setZoneFlash(el, ok ? 'drop-success' : 'drop-error');
  setStatus(
    ok
      ? `✓ Run #${result.runNumber} — ${result.filesDeployed.length} file(s) deployed`
      : `⚠ Run #${result.runNumber} — ${result.filesUnmatched.length} unmatched`,
    ok ? 'success' : 'warning'
  );

  // Refresh state
  const newState = await zm.getState();
  applyState(newState);
}

// ─── Zone visual feedback ──────────────────────────────────────────────────────
function setZoneFlash(el, cls) {
  el.classList.add(cls);
  setTimeout(() => el.classList.remove(cls), 1800);
}

function setZoneError(el, msg) {
  setZoneFlash(el, 'drop-error');
}

function setStatus(msg, type = '') {
  const s = $('compactStatus');
  s.textContent = msg;
  s.className = 'compact-status-text ' + type;
}

// ─── Conflict modal ───────────────────────────────────────────────────────────
function showConflictModal(filename, projectNames) {
  $('conflictMsg').textContent = `"${filename}" matches multiple projects. Which one?`;
  const btns = $('conflictButtons');
  btns.innerHTML = projectNames.map(name => `
    <button class="conflict-btn" data-project="${esc(name)}">→ ${esc(name)}</button>
  `).join('');
  btns.querySelectorAll('.conflict-btn').forEach(btn => {
    btn.addEventListener('click', () => resolveConflict(btn.dataset.project));
  });
  $('conflictModal').style.display = 'flex';
}

async function resolveConflict(projectName) {
  $('conflictModal').style.display = 'none';
  if (!pendingConflict) return;
  const { filePath, filename } = pendingConflict;
  pendingConflict = null;

  setStatus(`Deploying to ${projectName}…`, '');
  const res = await zm.resolveConflict(projectName, filename, filePath);

  if (res.success) {
    setStatus(`✓ Deployed to ${projectName}`, 'success');
    const newState = await zm.getState();
    applyState(newState);
  } else {
    setStatus(res.error, 'error');
  }
}

// ─── Event bindings ───────────────────────────────────────────────────────────
function bindEvents() {
  // Document-level drag prevention for OS file drops
  document.addEventListener('dragover', e => { e.preventDefault(); e.stopPropagation(); });
  document.addEventListener('drop', e => {
    e.preventDefault();
    e.stopPropagation();
    console.log('[Compact Drop] on doc, target:', e.target.className);
  });

  $('btnCloseCompact').addEventListener('click', () => zm.closeCompact());
  $('btnExpandToFull').addEventListener('click', () => zm.closeCompact());
  $('btnConflictCancel').addEventListener('click', () => {
    $('conflictModal').style.display = 'none';
    pendingConflict = null;
    setStatus('Cancelled.', '');
  });

  zm.onStateUpdate(s => applyState(s));

  zm.onWatcherEvent(evt => {
    if (evt.type === 'zip-detected') {
      setStatus(`Processing ${evt.zipName}…`, '');
      const el = document.getElementById(`zone-${evt.projectName}`);
      if (el) el.classList.add('processing');
    }
  });

  zm.onRunComplete(({ projectName, result }) => {
    const el = document.getElementById(`zone-${projectName}`);
    if (el) el.classList.remove('processing');
    const ok = result.status === 'success';
    if (el) setZoneFlash(el, ok ? 'drop-success' : 'drop-error');
    setStatus(
      ok ? `✓ ${projectName} — Run #${result.runNumber} complete` : `⚠ ${projectName} — Run #${result.runNumber} warnings`,
      ok ? 'success' : 'warning'
    );
    zm.getState().then(applyState);
  });

  zm.onAppError(msg => setStatus(msg, 'error'));
  zm.onCompactEvent(evt => {
    if (evt.type === 'compact-closed') { /* handled by window close */ }
  });
}

function esc(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

document.addEventListener('DOMContentLoaded', init);
