// src/main/zipProcessor.js
// Core engine: extracts zip, maps files, backs up, deploys

const path = require('path');
const fs = require('fs-extra');
const AdmZip = require('adm-zip');

class ZipProcessor {
  constructor(configManager, projectManager) {
    this.config = configManager;
    this.projects = projectManager;
  }

  async processZip(projectName, zipPath) {
    const cfg = this.config.getConfig();
    const project = this.projects.getAllProjects().find(p => p.name === projectName);
    if (!project) throw new Error(`Project "${projectName}" not found`);

    const map = this.projects.getProjectMap(projectName);
    if (!map) throw new Error(`No map found for project "${projectName}"`);

    // Increment run number
    const runNumber = this.projects.incrementRunNumber(projectName);
    await this.projects.saveMap(projectName);

    const runResult = {
      runNumber,
      zipName: path.basename(zipPath),
      startedAt: new Date().toISOString(),
      finishedAt: null,
      filesDeployed: [],
      filesBackedUp: [],
      filesUnmatched: [],
      filesExcluded: [],
      collisionAlerts: [],
      errors: [],
      status: 'running'
    };

    // ── Step 1: Move zip to working folder ──────────────────────────────────
    const workingFolderName = this.config.formatWorkingFolderName(runNumber);
    const workingDir = path.join(project.projectDir, workingFolderName);
    await fs.ensureDir(workingDir);

    const workingZipPath = path.join(workingDir, path.basename(zipPath));
    await fs.move(zipPath, workingZipPath);

    try {
      // ── Step 2: Extract zip ────────────────────────────────────────────────
      const extractDir = path.join(workingDir, 'extracted');
      await fs.ensureDir(extractDir);

      const zip = new AdmZip(workingZipPath);
      zip.extractAllTo(extractDir, true);

      // Collect all extracted files (recursively - flatten to just filenames)
      const extractedFiles = await this._collectFiles(extractDir);

      // ── Step 3: Check for map collisions (alert only) ─────────────────────
      if (map.collisions && map.collisions.length > 0) {
        runResult.collisionAlerts = map.collisions;
      }

      // ── Step 4: Back up and deploy each file ──────────────────────────────
      const backupRunDir = path.join(project.projectDir, 'FileBackups', `Run${String(runNumber).padStart(3,'0')}`);
      await fs.ensureDir(backupRunDir);

      for (const { filename, fullPath } of extractedFiles) {
        const tokenizedDest = map.files[filename];

        // ── Excluded file check ───────────────────────────────────────────
        const excludedFiles = new Set((map.excludedFiles || []).map(f => f.toLowerCase()));
        if (excludedFiles.has(filename.toLowerCase())) {
          const excludedDir = path.join(project.projectDir, 'Excluded');
          await fs.ensureDir(excludedDir);
          await fs.copy(fullPath, path.join(excludedDir, filename), { overwrite: true });
          runResult.filesExcluded.push({ filename, reason: 'In excluded files list' });
          continue;
        }

        if (!tokenizedDest) {
          // ── Unmatched file ────────────────────────────────────────────────
          const unmatchedDir = path.join(project.projectDir, 'NewFilesDetected');
          await fs.ensureDir(unmatchedDir);
          const unmatchedDest = path.join(unmatchedDir, filename);
          await fs.copy(fullPath, unmatchedDest, { overwrite: true });
          runResult.filesUnmatched.push({
            filename,
            placedAt: unmatchedDest,
            suggestion: 'Manually place this file and update the project map'
          });
          continue;
        }

        const absoluteDest = this.projects.resolveDestination(projectName, tokenizedDest);

        // ── Backup destination file before overwriting ────────────────────
        if (await fs.pathExists(absoluteDest)) {
          const backupPath = path.join(backupRunDir, filename);
          await fs.copy(absoluteDest, backupPath);
          runResult.filesBackedUp.push({
            filename,
            backedUpFrom: absoluteDest,
            backedUpTo: backupPath
          });
        }

        // ── Deploy ────────────────────────────────────────────────────────
        try {
          await fs.ensureDir(path.dirname(absoluteDest));
          await fs.copy(fullPath, absoluteDest, { overwrite: true });
          runResult.filesDeployed.push({
            filename,
            source: fullPath,
            destination: absoluteDest
          });
        } catch (deployErr) {
          runResult.errors.push({
            filename,
            error: deployErr.message
          });
        }
      }

      // ── Step 5: Archive the zip ────────────────────────────────────────────
      const archiveName = this.config.formatZipArchiveName(path.basename(zipPath), runNumber);
      const archiveDest = path.join(project.projectDir, 'ZipArchive', archiveName);
      await fs.move(workingZipPath, archiveDest);

      // ── Step 6: Clean up working folder ───────────────────────────────────
      await fs.remove(workingDir);

      // ── Step 7: Prune old backups ──────────────────────────────────────────
      await this.projects.pruneBackups(projectName, cfg.backupRetentionRuns);

      runResult.status = runResult.errors.length > 0 ? 'completed_with_errors' : 'success';

    } catch (err) {
      runResult.errors.push({ filename: 'FATAL', error: err.message });
      runResult.status = 'failed';
      // Clean up working dir on failure too
      try { await fs.remove(workingDir); } catch (_) {}
    }

    runResult.finishedAt = new Date().toISOString();

    // ── Step 8: Log the run ────────────────────────────────────────────────
    await this.projects.logRun(projectName, runResult);

    return runResult;
  }

  // Recursively collect all files from a directory, returning { filename, fullPath }
  async _collectFiles(dir) {
    const results = [];
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      // Skip shell brace-expansion artifacts e.g. {main,renderer,shared}
      if (entry.name.startsWith('{') && entry.name.endsWith('}')) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const sub = await this._collectFiles(fullPath);
        results.push(...sub);
      } else {
        results.push({ filename: entry.name, fullPath, size: (await fs.stat(fullPath)).size });
      }
    }
    return results;
  }
}

module.exports = ZipProcessor;
