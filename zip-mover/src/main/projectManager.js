// src/main/projectManager.js
// Manages ZipMover projects: creation, map building, run logging

const path = require('path');
const fs = require('fs-extra');

const PROJECT_SUBDIRS = [
  'FileBackups',
  'ZipArchive',
  'NewFilesDetected',
  'Excluded'
];

class ProjectManager {
  constructor(configManager) {
    this.config = configManager;
    this.projects = {};
    this.maps = {};
  }

  async init() {
    const appRoot = this.config.getAppRoot();
    console.log('[ProjectManager] init — appRoot:', appRoot);
    await fs.ensureDir(appRoot);
    const entries = await fs.readdir(appRoot, { withFileTypes: true });
    console.log('[ProjectManager] entries in appRoot:', entries.map(e => e.name));
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const projectDir = path.join(appRoot, entry.name);
      const mapPath = path.join(projectDir, 'project_map.json');
      if (await fs.pathExists(mapPath)) {
        await this._loadProject(entry.name);
        console.log('[ProjectManager] loaded project:', entry.name);
      }
    }
    console.log('[ProjectManager] total projects loaded:', Object.keys(this.projects).length);
  }

  async _loadProject(name) {
    const projectDir = this._projectDir(name);
    const mapPath = path.join(projectDir, 'project_map.json');
    try {
      const map = await fs.readJson(mapPath);
      this.maps[name] = map;
      this.projects[name] = {
        name,
        projectDir,
        destinationRoot: map.destinationRoot,
        nextRunNumber: map.nextRunNumber || 1,
        fileCount: Object.keys(map.files || {}).length,
        excludedFolders: map.excludedFolders || [],
        excludedFiles: map.excludedFiles || [],
        allowDropToUI: map.allowDropToUI !== false,
        lastRun: await this._getLastRun(name)
      };
    } catch (err) {
      console.error(`Failed to load project ${name}:`, err);
    }
  }

  _projectDir(name) {
    return path.join(this.config.getAppRoot(), name);
  }

  getAllProjects() {
    return Object.values(this.projects);
  }

  async getProjectDetails(name) {
    const project = this.projects[name];
    if (!project) throw new Error(`Project "${name}" not found`);
    const runLog = await this._readRunLog(name);
    return {
      ...project,
      map: this.maps[name],
      runLog: runLog.slice(-50).reverse()
    };
  }

  getProjectMap(name) {
    return this.maps[name] || null;
  }

  // ── Scan root-level folders of a destination directory ───────────────────
  async scanRootFolders(destinationRoot) {
    const results = [];
    let entries;
    try {
      entries = await fs.readdir(destinationRoot, { withFileTypes: true });
    } catch (e) {
      throw new Error(`Cannot read destination folder: ${e.message}`);
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        results.push(entry.name);
      }
    }
    return results.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  }

  // ── Parse .gitignore and return root-level folder names it excludes ───────
  async parseGitignoreFolders(destinationRoot) {
    const gitignorePath = path.join(destinationRoot, '.gitignore');
    if (!(await fs.pathExists(gitignorePath))) return [];

    const raw = await fs.readFile(gitignorePath, 'utf8');
    const lines = raw.split(/\r?\n/);
    const excluded = new Set();

    for (let line of lines) {
      line = line.trim();
      // Skip blank lines, comments, negations, and file patterns
      if (!line || line.startsWith('#') || line.startsWith('!')) continue;
      // Skip lines with wildcards (file patterns like *.log)
      if (line.includes('*') || line.includes('?')) continue;
      // Skip deep paths (we only want root-level folder names)
      // A root-level folder entry looks like: node_modules  OR  node_modules/
      const stripped = line.replace(/\/$/, '');   // remove trailing slash
      if (stripped.includes('/')) continue;        // skip deep paths
      if (stripped.startsWith('.') && !stripped.includes('/')) {
        excluded.add(stripped);                    // allow .git, .cache etc.
        continue;
      }
      excluded.add(stripped);
    }

    return [...excluded];
  }

  // ── Create project (folders created; map built with exclusions) ───────────
  async createProject(name, destinationRoot, excludedFolders = []) {
    if (this.projects[name]) throw new Error(`Project "${name}" already exists`);
    if (!name.match(/^[a-zA-Z0-9_\- ]+$/)) throw new Error('Invalid project name');

    const projectDir = this._projectDir(name);
    await fs.ensureDir(projectDir);
    for (const sub of PROJECT_SUBDIRS) {
      await fs.ensureDir(path.join(projectDir, sub));
    }

    const map = await this._buildMap(name, destinationRoot, excludedFolders);

    this.maps[name] = map;
    this.projects[name] = {
      name,
      projectDir,
      destinationRoot,
      nextRunNumber: 1,
      fileCount: Object.keys(map.files).length,
      excludedFolders: map.excludedFolders,
      excludedFiles: [],
      allowDropToUI: true,
      lastRun: null
    };

    return this.projects[name];
  }

  async deleteProject(name) {
    if (!this.projects[name]) throw new Error(`Project "${name}" not found`);
    delete this.projects[name];
    delete this.maps[name];
  }

  // ── Rebuild using saved excludedFolders (or override with new list) ───────
  async rebuildMap(name, newExcludedFolders) {
    const project = this.projects[name];
    if (!project) throw new Error(`Project "${name}" not found`);

    // Use provided list if given, otherwise keep existing
    const excluded = newExcludedFolders !== undefined
      ? newExcludedFolders
      : (this.maps[name] && this.maps[name].excludedFolders) || [];

    const map = await this._buildMap(name, project.destinationRoot, excluded);
    this.maps[name] = map;
    this.projects[name].fileCount = Object.keys(map.files).length;
    this.projects[name].excludedFolders = map.excludedFolders;
    return map;
  }

  // ── Update per-project settings (allowDropToUI etc.) ─────────────────────
  async updateProjectSettings(name, settings) {
    const map = this.maps[name];
    const project = this.projects[name];
    if (!map) throw new Error(`Project "${name}" not found`);
    // Merge allowed settings keys
    const allowed = ['allowDropToUI', 'excludedFiles'];
    for (const key of allowed) {
      if (settings[key] !== undefined) {
        map[key] = settings[key];
        project[key] = settings[key];
      }
    }
    await this.saveMap(name);
  }

  // ── Update exclusions and rebuild ─────────────────────────────────────────
  async updateExclusionsAndRebuild(name, excludedFolders) {
    return this.rebuildMap(name, excludedFolders);
  }

  async _buildMap(name, destinationRoot, excludedFolders = []) {
    const files = {};
    const collisions = [];
    const seenFilenames = {};

    // Normalise excluded set for fast lookup (lowercase for case-insensitive match)
    const excludedSet = new Set(excludedFolders.map(f => f.toLowerCase()));

    const scan = async (dir, isRoot = false) => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (e) {
        return;
      }

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          // Only apply exclusion filter at root level
          if (isRoot && excludedSet.has(entry.name.toLowerCase())) continue;
          await scan(fullPath, false);
        } else if (entry.isFile()) {
          const filename = entry.name;
          const relativePath = path.relative(destinationRoot, fullPath);
          const tokenizedPath = '{root}' + path.sep + relativePath;

          if (seenFilenames[filename] && !collisions.includes(filename)) {
            collisions.push(filename);
          }

          files[filename] = tokenizedPath;
          seenFilenames[filename] = tokenizedPath;
        }
      }
    };

    await scan(destinationRoot, true);

    const map = {
      destinationRoot,
      excludedFolders,                                          // ← persisted
      excludedFiles: (this.maps[name] && this.maps[name].excludedFiles) || [],
      wildcards: (this.maps[name] && this.maps[name].wildcards) || [],
      allowDropToUI: this.maps[name] ? (this.maps[name].allowDropToUI !== false) : true,
      nextRunNumber: (this.maps[name] && this.maps[name].nextRunNumber) || 1,
      builtAt: new Date().toISOString(),
      fileCount: Object.keys(files).length,
      collisions,
      files
    };

    const projectDir = this._projectDir(name);
    await fs.writeJson(path.join(projectDir, 'project_map.json'), map, { spaces: 2 });
    return map;
  }

  async updateMapEntry(projectName, filename, destination) {
    const map = this.maps[projectName];
    if (!map) throw new Error(`Project "${projectName}" not found`);
    map.files[filename] = destination;
    map.fileCount = Object.keys(map.files).length;
    const projectDir = this._projectDir(projectName);
    await fs.writeJson(path.join(projectDir, 'project_map.json'), map, { spaces: 2 });
  }

  async resetRunNumber(projectName) {
    const map = this.maps[projectName];
    const project = this.projects[projectName];
    if (!map) return;
    map.nextRunNumber = 1;
    if (project) project.nextRunNumber = 1;
    if (project) project.lastRun = null;
    await this.saveMap(projectName);
  }


  // ── Wildcard pattern matching ─────────────────────────────────────────────
  // Converts a user pattern (with * and [*]) to a RegExp
  _patternToRegex(pattern) {
    // Must handle [*] BEFORE escaping to avoid mangling the brackets
    // Step 1: protect [*] with a placeholder
    let p = pattern.replace(/\[\*\]/g, '\x00SC\x00');
    // Step 2: escape all regex special chars (including [ ] { } . + ^ $ etc.)
    p = p.replace(/[.+^${}()|\[\]\\]/g, '\\$&');
    // Step 3: restore single-char wildcard placeholder → regex dot
    p = p.replace(/\x00SC\x00/g, '.');
    // Step 4: * → .* (any chars)
    p = p.replace(/\*/g, '.*');
    return new RegExp('^' + p + '$', 'i');
  }

  // Find first matching wildcard for a filename
  matchWildcard(projectName, filename) {
    const map = this.maps[projectName];
    if (!map || !map.wildcards || !map.wildcards.length) return null;
    for (const wc of map.wildcards) {
      const re = this._patternToRegex(wc.pattern);
      if (re.test(filename)) return wc;
    }
    return null;
  }

  // Resolve wildcard destination — replaces {root} and {filename}
  resolveWildcardDestination(projectName, wc, filename) {
    const map = this.maps[projectName];
    if (!map) return null;
    return wc.destination
      .replace('{root}', map.destinationRoot)
      .replace('{filename}', filename);
  }

  // Add a wildcard pattern to the map
  async addWildcard(projectName, pattern, destination, description) {
    const map = this.maps[projectName];
    if (!map) throw new Error(`Project "${projectName}" not found`);
    if (!map.wildcards) map.wildcards = [];
    // Check for duplicate pattern
    if (map.wildcards.find(w => w.pattern.toLowerCase() === pattern.toLowerCase())) {
      throw new Error(`Pattern "${pattern}" already exists`);
    }
    map.wildcards.push({ pattern, destination, description: description || '' });
    await this.saveMap(projectName);
  }

  // Remove a wildcard pattern
  async removeWildcard(projectName, pattern) {
    const map = this.maps[projectName];
    if (!map) throw new Error(`Project "${projectName}" not found`);
    map.wildcards = (map.wildcards || []).filter(w => w.pattern !== pattern);
    await this.saveMap(projectName);
  }

  // Update a wildcard entry
  async updateWildcard(projectName, oldPattern, newEntry) {
    const map = this.maps[projectName];
    if (!map) throw new Error(`Project "${projectName}" not found`);
    const idx = (map.wildcards || []).findIndex(w => w.pattern === oldPattern);
    if (idx === -1) throw new Error(`Pattern "${oldPattern}" not found`);
    map.wildcards[idx] = { ...map.wildcards[idx], ...newEntry };
    await this.saveMap(projectName);
  }

  // Add a new file to the permanent map (called after wildcard deploy)
  async addFileToMap(projectName, filename, tokenizedPath) {
    const map = this.maps[projectName];
    if (!map) return;
    map.files[filename] = tokenizedPath;
    map.fileCount = Object.keys(map.files).length;
    await this.saveMap(projectName);
  }

  resolveDestination(projectName, tokenizedPath) {
    const map = this.maps[projectName];
    if (!map) return null;
    return tokenizedPath.replace('{root}', map.destinationRoot);
  }

  incrementRunNumber(projectName) {
    const map = this.maps[projectName];
    const project = this.projects[projectName];
    const run = map.nextRunNumber || 1;
    map.nextRunNumber = run + 1;
    project.nextRunNumber = map.nextRunNumber;
    return run;
  }

  async saveMap(projectName) {
    const map = this.maps[projectName];
    if (!map) return;
    const projectDir = this._projectDir(projectName);
    await fs.writeJson(path.join(projectDir, 'project_map.json'), map, { spaces: 2 });
  }

  async logRun(projectName, runEntry) {
    const runLogPath = path.join(this._projectDir(projectName), 'run_log.json');
    let log = [];
    if (await fs.pathExists(runLogPath)) {
      log = await fs.readJson(runLogPath);
    }
    log.push(runEntry);
    await fs.writeJson(runLogPath, log, { spaces: 2 });
    this.projects[projectName].lastRun = runEntry;
  }

  async _readRunLog(projectName) {
    const runLogPath = path.join(this._projectDir(projectName), 'run_log.json');
    if (!(await fs.pathExists(runLogPath))) return [];
    return fs.readJson(runLogPath);
  }

  async _getLastRun(projectName) {
    const log = await this._readRunLog(projectName);
    return log.length > 0 ? log[log.length - 1] : null;
  }

  async pruneBackups(projectName, retentionRuns) {
    const backupDir = path.join(this._projectDir(projectName), 'FileBackups');
    if (!(await fs.pathExists(backupDir))) return;
    const runLog = await this._readRunLog(projectName);
    if (runLog.length <= retentionRuns) return;
    const runsToDelete = runLog.slice(0, runLog.length - retentionRuns);
    for (const run of runsToDelete) {
      const runBackupDir = path.join(backupDir, `Run${String(run.runNumber).padStart(3,'0')}`);
      if (await fs.pathExists(runBackupDir)) {
        await fs.remove(runBackupDir);
      }
    }
  }
}

module.exports = ProjectManager;
