// src/main/main.js
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const ConfigManager = require('./configManager');
const ProjectManager = require('./projectManager');
const ZipProcessor = require('./zipProcessor');
const WatcherManager = require('./watcherManager');

let mainWindow;
let configManager;
let projectManager;
let zipProcessor;
let watcherManager;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#0f1117',
    show: false,
    icon: path.join(__dirname, '../../assets/icon.png')
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    initializeApp();
  });

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }
}

async function initializeApp() {
  try {
    configManager = new ConfigManager();
    await configManager.init();

    // If no root folder chosen yet, tell the renderer to show setup screen
    if (configManager.needsSetup()) {
      mainWindow.webContents.send('needs-setup', true);
      return;
    }

    await bootManagers();
  } catch (err) {
    console.error('Failed to initialize app:', err);
    sendError('App initialization failed: ' + err.message);
  }
}

// Called after setup is complete OR on normal launch when root already set
async function bootManagers() {
  projectManager = new ProjectManager(configManager);
  await projectManager.init();

  zipProcessor = new ZipProcessor(configManager, projectManager);

  watcherManager = new WatcherManager(projectManager, zipProcessor, (event) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('watcher-event', event);
    }
  });

  const projects = projectManager.getAllProjects();
  for (const project of projects) {
    watcherManager.startWatcher(project.name);
  }

  sendStateUpdate();
}

function sendStateUpdate() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('state-update', {
      projects: projectManager ? projectManager.getAllProjects() : [],
      config: configManager ? configManager.getConfig() : {},
      watcherStatus: watcherManager ? watcherManager.getStatus() : {}
    });
  }
}

function sendError(message) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app-error', message);
  }
}

// ─── IPC: Setup ──────────────────────────────────────────────────────────────

// Browse for the ZipMover root folder (setup screen + settings)
ipcMain.handle('browse-zipmover-root', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Choose ZipMover Root Folder'
  });
  if (result.canceled) return { success: false };
  return { success: true, path: result.filePaths[0] };
});

// Confirm and save the chosen root folder, then boot managers
ipcMain.handle('set-app-root', async (event, { folderPath }) => {
  try {
    await configManager.setAppRoot(folderPath);
    await bootManagers();
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Change root folder from settings (stop watchers, rebind)
ipcMain.handle('change-app-root', async (event, { folderPath }) => {
  try {
    if (watcherManager) watcherManager.stopAll();
    await configManager.setAppRoot(folderPath);
    // Reinit project manager with new root
    projectManager = new ProjectManager(configManager);
    await projectManager.init();
    zipProcessor = new ZipProcessor(configManager, projectManager);
    watcherManager = new WatcherManager(projectManager, zipProcessor, (event) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('watcher-event', event);
      }
    });
    const projects = projectManager.getAllProjects();
    for (const project of projects) {
      watcherManager.startWatcher(project.name);
    }
    sendStateUpdate();
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── IPC: Shell ──────────────────────────────────────────────────────────────

// Open a project folder in Explorer / Finder / file manager
ipcMain.handle('open-project-folder', async (event, { name }) => {
  try {
    const project = projectManager.getAllProjects().find(p => p.name === name);
    if (!project) throw new Error('Project not found');
    await shell.openPath(project.projectDir);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Open the ZipMover root folder
ipcMain.handle('open-root-folder', async () => {
  try {
    await shell.openPath(configManager.getAppRoot());
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── IPC: Projects ───────────────────────────────────────────────────────────

ipcMain.handle('scan-root-folders', async (event, { destinationRoot }) => {
  try {
    const folders = await projectManager.scanRootFolders(destinationRoot);
    return { success: true, folders };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('parse-gitignore', async (event, { destinationRoot }) => {
  try {
    const excluded = await projectManager.parseGitignoreFolders(destinationRoot);
    return { success: true, excluded };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('update-exclusions', async (event, { name, excludedFolders }) => {
  try {
    const map = await projectManager.updateExclusionsAndRebuild(name, excludedFolders);
    sendStateUpdate();
    return { success: true, map };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('create-project', async (event, { name, destinationRoot, excludedFolders }) => {
  try {
    const project = await projectManager.createProject(name, destinationRoot, excludedFolders || []);
    watcherManager.startWatcher(name);
    sendStateUpdate();
    return { success: true, project };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('delete-project', async (event, { name }) => {
  try {
    watcherManager.stopWatcher(name);
    await projectManager.deleteProject(name);
    sendStateUpdate();
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('rebuild-map', async (event, { name, excludedFolders }) => {
  try {
    const map = await projectManager.rebuildMap(name, excludedFolders);
    sendStateUpdate();
    return { success: true, map };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('get-project-details', async (event, { name }) => {
  try {
    const details = await projectManager.getProjectDetails(name);
    return { success: true, details };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('get-project-map', async (event, { name }) => {
  try {
    const map = projectManager.getProjectMap(name);
    return { success: true, map };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('update-map-entry', async (event, { projectName, filename, destination }) => {
  try {
    await projectManager.updateMapEntry(projectName, filename, destination);
    sendStateUpdate();
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('toggle-watcher', async (event, { name, active }) => {
  try {
    if (active) { watcherManager.startWatcher(name); }
    else { watcherManager.stopWatcher(name); }
    sendStateUpdate();
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('browse-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select Destination Root Folder'
  });
  if (result.canceled) return { success: false };
  return { success: true, path: result.filePaths[0] };
});

ipcMain.handle('update-config', async (event, updates) => {
  try {
    await configManager.updateConfig(updates);
    sendStateUpdate();
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('get-state', async () => {
  return {
    projects: projectManager ? projectManager.getAllProjects() : [],
    config: configManager ? configManager.getConfig() : {},
    watcherStatus: watcherManager ? watcherManager.getStatus() : {},
    needsSetup: configManager ? configManager.needsSetup() : true
  };
});

ipcMain.handle('process-zip', async (event, { projectName, zipPath }) => {
  try {
    const result = await zipProcessor.processZip(projectName, zipPath);
    sendStateUpdate();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('run-complete', { projectName, result });
    }
    return { success: true, result };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// App lifecycle
app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (watcherManager) watcherManager.stopAll();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
