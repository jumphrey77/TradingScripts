// src/main/watcherManager.js
// Manages per-project chokidar file watchers

const path = require('path');
const chokidar = require('chokidar');

class WatcherManager {
  constructor(projectManager, zipProcessor, onEvent) {
    this.projects = projectManager;
    this.processor = zipProcessor;
    this.onEvent = onEvent;   // Callback to send events to renderer
    this.watchers = {};       // name -> chokidar watcher
    this.status = {};         // name -> { active, lastEvent }
    this.debounceTimers = {}; // name+file -> timer
  }

  startWatcher(projectName) {
    if (this.watchers[projectName]) {
      this.stopWatcher(projectName);
    }

    const allProjects = this.projects.getAllProjects();
    const project = allProjects.find(p => p.name === projectName);
    if (!project) return;

    const watchPath = project.projectDir;

    const watcher = chokidar.watch(watchPath, {
      ignored: [
        /(^|[/\\])\../,            // dot files
        /FileBackups/,
        /ZipArchive/,
        /NewFilesDetected/,
        /WorkingRun/,
        /project_map\.json/,
        /run_log\.json/
      ],
      persistent: true,
      ignoreInitial: true,
      depth: 0,                    // Only watch root of project folder
      awaitWriteFinish: {
        stabilityThreshold: 1500,  // Wait for file to finish writing
        pollInterval: 200
      }
    });

    watcher.on('add', (filePath) => {
      if (filePath.toLowerCase().endsWith('.zip')) {
        this._handleZipDetected(projectName, filePath);
      }
    });

    watcher.on('error', (err) => {
      this.onEvent({
        type: 'watcher-error',
        projectName,
        message: err.message,
        timestamp: new Date().toISOString()
      });
    });

    this.watchers[projectName] = watcher;
    this.status[projectName] = {
      active: true,
      watchPath,
      startedAt: new Date().toISOString(),
      lastEvent: null
    };

    this.onEvent({
      type: 'watcher-started',
      projectName,
      timestamp: new Date().toISOString()
    });
  }

  stopWatcher(projectName) {
    if (this.watchers[projectName]) {
      this.watchers[projectName].close();
      delete this.watchers[projectName];
    }
    if (this.status[projectName]) {
      this.status[projectName].active = false;
    }
    this.onEvent({
      type: 'watcher-stopped',
      projectName,
      timestamp: new Date().toISOString()
    });
  }

  stopAll() {
    for (const name of Object.keys(this.watchers)) {
      this.stopWatcher(name);
    }
  }

  getStatus() {
    return { ...this.status };
  }

  _handleZipDetected(projectName, zipPath) {
    // Debounce - in case multiple events fire for the same file
    const key = `${projectName}::${zipPath}`;
    if (this.debounceTimers[key]) {
      clearTimeout(this.debounceTimers[key]);
    }

    this.debounceTimers[key] = setTimeout(async () => {
      delete this.debounceTimers[key];

      this.onEvent({
        type: 'zip-detected',
        projectName,
        zipPath,
        zipName: path.basename(zipPath),
        timestamp: new Date().toISOString()
      });

      if (this.status[projectName]) {
        this.status[projectName].lastEvent = {
          type: 'processing',
          zipName: path.basename(zipPath),
          timestamp: new Date().toISOString()
        };
      }

      try {
        const result = await this.processor.processZip(projectName, zipPath);

        if (this.status[projectName]) {
          this.status[projectName].lastEvent = {
            type: result.status,
            zipName: result.zipName,
            runNumber: result.runNumber,
            timestamp: result.finishedAt
          };
        }

        this.onEvent({
          type: 'run-complete',
          projectName,
          result
        });

      } catch (err) {
        this.onEvent({
          type: 'run-failed',
          projectName,
          error: err.message,
          timestamp: new Date().toISOString()
        });
      }
    }, 800);
  }
}

module.exports = WatcherManager;
