# ZipMover

Automated zip file deployment tool for development projects. Drop a Claude-generated zip into a project folder — ZipMover extracts it, backs up originals, and deploys every file to its correct destination automatically.

---

## Setup

### Prerequisites

- [Node.js](https://nodejs.org/) v18 or later
- npm

### Install & Run

```bash
# 1. Navigate to this folder
cd zipmover

# 2. Install dependencies
npm install

# 3. Launch the app
npm start
```

### First Launch

On first launch ZipMover creates its config file at:

| OS      | Path |
|---------|------|
| Windows | `%APPDATA%\zipmover\zipmover_config.json` |
| macOS   | `~/Library/Application Support/zipmover/` |
| Linux   | `~/.config/zipmover/` |

Project folders are stored under `{userData}/projects/`.

---

## Usage

### Creating a Project

1. Click **＋** in the sidebar or **Create Project** on the empty state
2. Enter a **Project Name** (alphanumeric, hyphens, spaces)
3. Browse to your **Destination Root Folder** (the root of your source code tree)
4. Click **Create Project**

ZipMover scans the destination folder and builds a `project_map.json` mapping every filename to its path.

### Deploying Files

1. Download your Claude-generated zip file
2. **Drop it directly into the project folder** shown in the sidebar
3. ZipMover automatically:
   - Detects the zip
   - Moves it to a working folder
   - Extracts all files
   - Backs up any destination files about to be overwritten
   - Copies each file to its mapped destination
   - Archives the zip with a run-numbered name
   - Cleans up the working folder
4. The **Run Summary** appears in the main window

### File Map

The map lives at `{projectFolder}/project_map.json`:

```json
{
  "destinationRoot": "C:/MyProject",
  "nextRunNumber": 4,
  "files": {
    "App.jsx":     "{root}/src/components/App.jsx",
    "utils.py":    "{root}/backend/utils.py",
    "index.html":  "{root}/public/index.html"
  }
}
```

- `{root}` is replaced with `destinationRoot` at deploy time
- Click any entry in the **File Map** panel to edit its destination
- Click **↻ Rebuild** to rescan the destination folder after adding new files

### Unmatched Files

If a zip contains a file with **no entry in the map**, ZipMover:
- Copies it to `{projectFolder}/NewFilesDetected/`
- Shows a yellow alert in the UI
- Logs the file in `run_log.json`

To fix: click the file entry in the project detail view → assign a destination → the next run will deploy it correctly.

### Filename Collisions

If two files in your destination have the **same filename** (in different folders), ZipMover:
- Shows a **🚨 red attention banner** — hard to miss
- Logs the collision in the map under `collisions[]`
- Maps only the last scanned occurrence

To fix: manually edit the map entry for the affected filename to point to the correct path.

---

## Folder Structure

```
{userData}/projects/
  ProjectName/
    project_map.json        ← File routing map
    run_log.json            ← History of all runs
    FileBackups/
      Run001/               ← Backed-up originals for run 1
      Run002/
    ZipArchive/
      Run001-20260324-... .zip
    NewFilesDetected/       ← Unmatched files land here
    WorkingRun001-.../      ← Temp folder, deleted after run
```

---

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Keep Last N Runs | 10 | Backup folders older than N runs are auto-deleted |
| Archive Filename Pattern | `Run{NNN}-{YYYY}{MM}{DD}-{HH}{mm}-{originalName}` | How processed zips are renamed |
| Watcher Debounce (ms) | 1500 | Wait time after zip detected before processing |

---

## Building a Distributable

```bash
npm run build
```

Output goes to `dist/`. Produces:
- **Windows**: NSIS installer
- **macOS**: DMG
- **Linux**: AppImage

---

## Notes

- Version control is untouched — ZipMover only copies files, never deletes from your destination
- Backups are per-run, not per-file — the entire run's touched files are grouped in `FileBackups/RunNNN/`
- The watcher only monitors the **root** of the project folder — subfolders are ignored for zip detection
- Zip files dropped while the app is closed will be processed on next launch IF the watcher auto-starts (which it does)
