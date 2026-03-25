// src/main/fileDropHandler.js
// Handles single-file and zip drops from the UI drag-and-drop zones

const path = require('path');
const fs = require('fs-extra');

class FileDropHandler {
  constructor(configManager, projectManager, zipProcessor) {
    this.config = configManager;
    this.projects = projectManager;
    this.processor = zipProcessor;
  }

  // Main entry point — called from IPC 'handle-drop'
  // Returns { action, result, conflicts } where action = 'zip'|'single'|'conflict'
  async handleDrop(projectName, filePath) {
    const ext = path.extname(filePath).toLowerCase();

    if (ext === '.zip') {
      return this._handleZipDrop(projectName, filePath);
    } else {
      return this._handleSingleFileDrop(projectName, filePath);
    }
  }

  async _handleZipDrop(projectName, filePath) {
    // Copy zip into the project folder so the processor can pick it up
    const project = this.projects.getAllProjects().find(p => p.name === projectName);
    if (!project) throw new Error(`Project "${projectName}" not found`);

    const destZipPath = path.join(project.projectDir, path.basename(filePath));
    await fs.copy(filePath, destZipPath, { overwrite: true });

    const result = await this.processor.processZip(projectName, destZipPath);
    return { action: 'zip', result };
  }

  async _handleSingleFileDrop(projectName, filePath) {
    const filename = path.basename(filePath);
    const project = this.projects.getAllProjects().find(p => p.name === projectName);
    if (!project) throw new Error(`Project "${projectName}" not found`);

    const map = this.projects.getProjectMap(projectName);
    if (!map) throw new Error(`No map for project "${projectName}"`);

    // Check ALL projects for this filename to detect cross-project conflicts
    const allProjects = this.projects.getAllProjects();
    const matchingProjects = allProjects.filter(p => {
      if (!p.name) return false;
      const m = this.projects.getProjectMap(p.name);
      return m && m.files && m.files[filename];
    });

    // If multiple DROP-enabled projects match, return conflict for UI to resolve
    if (matchingProjects.length > 1) {
      const dropEnabledMatches = matchingProjects.filter(p => {
        const m = this.projects.getProjectMap(p.name);
        return m && m.allowDropToUI !== false;
      });
      if (dropEnabledMatches.length > 1 && dropEnabledMatches.find(p => p.name !== projectName)) {
        return {
          action: 'conflict',
          filename,
          filePath,
          conflicts: dropEnabledMatches.map(p => p.name)
        };
      }
    }

    // Deploy the single file
    const result = await this._deploySingleFile(projectName, filename, filePath, map);
    return { action: 'single', result };
  }

  async _deploySingleFile(projectName, filename, filePath, map) {
    const cfg = this.config.getConfig();
    const project = this.projects.getAllProjects().find(p => p.name === projectName);
    const runNumber = this.projects.incrementRunNumber(projectName);
    await this.projects.saveMap(projectName);

    const runResult = {
      runNumber,
      zipName: filename,  // Re-use zipName field for display
      startedAt: new Date().toISOString(),
      finishedAt: null,
      filesDeployed: [],
      filesBackedUp: [],
      filesUnmatched: [],
      collisionAlerts: [],
      errors: [],
      status: 'running',
      isSingleFile: true
    };

    const tokenizedDest = map.files[filename];

    if (!tokenizedDest) {
      // Not in map — send to NewFilesDetected
      const unmatchedDir = path.join(project.projectDir, 'NewFilesDetected');
      await fs.ensureDir(unmatchedDir);
      await fs.copy(filePath, path.join(unmatchedDir, filename), { overwrite: true });
      runResult.filesUnmatched.push({ filename, suggestion: 'Update map to deploy next time' });
      runResult.status = 'completed_with_errors';
    } else {
      const absoluteDest = this.projects.resolveDestination(projectName, tokenizedDest);

      // Backup
      const backupRunDir = path.join(project.projectDir, 'FileBackups', `Run${String(runNumber).padStart(3,'0')}`);
      await fs.ensureDir(backupRunDir);
      if (await fs.pathExists(absoluteDest)) {
        await fs.copy(absoluteDest, path.join(backupRunDir, filename));
        runResult.filesBackedUp.push({ filename, backedUpFrom: absoluteDest });
      }

      // Deploy
      try {
        await fs.ensureDir(path.dirname(absoluteDest));
        await fs.copy(filePath, absoluteDest, { overwrite: true });
        runResult.filesDeployed.push({ filename, destination: absoluteDest });
        runResult.status = 'success';
      } catch (err) {
        runResult.errors.push({ filename, error: err.message });
        runResult.status = 'failed';
      }
    }

    runResult.finishedAt = new Date().toISOString();
    await this.projects.logRun(projectName, runResult);
    await this.projects.pruneBackups(projectName, cfg.backupRetentionRuns || 10);
    return runResult;
  }

  // Called after user resolves a conflict — deploy to specific project
  async resolveConflict(projectName, filename, filePath) {
    const map = this.projects.getProjectMap(projectName);
    if (!map) throw new Error(`No map for project "${projectName}"`);
    const result = await this._deploySingleFile(projectName, filename, filePath, map);
    return { action: 'single', result };
  }
}

module.exports = FileDropHandler;
