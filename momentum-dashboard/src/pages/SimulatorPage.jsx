import React, { useEffect, useMemo, useRef, useState } from "react";
import styles from "../styles/simulatorpage.module.css";
import {fmtPct, fmtTime, toNumMaybe} from '../utils/formaters'

function parseTSV(tsvText) {
  const lines = tsvText.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split("\t").map(h => h.trim());
  const recs = [];

  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split("\t");
    if (parts.length < headers.length) continue;
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = parts[idx];
    });

    // Convert known numeric columns to numbers (backend is defensive, but this helps)

    ["Premarket","Gap %","RelVol","ATR %","Score","EntryLow","EntryHigh","Stop","Target1","Target2","RR_T1","RR_T2"]
      .forEach(k => { if (row[k] !== undefined) row[k] = toNumMaybe(row[k]); });

    // Normalize keys to match backend expectations exactly:
    recs.push({
      Ticker: row["Ticker"],
      Score: row["Score"],
      EntryLow: row["EntryLow"],
      EntryHigh: row["EntryHigh"],
      Stop: row["Stop"],
      Target1: row["Target1"],
      Target2: row["Target2"],
      Pattern: row["Pattern"],
      Chart: row["Chart"],
      NEW: row["NEW"]
    });
  }
  return recs;
}

function inferDateTimeFromScanTimestamp(ts) {
  if (!ts) return { date: null, time: null };
  let s = String(ts).trim();

  // remove trailing "ET" / "EST" / "EDT" etc
  s = s.replace(/\s+(ET|EST|EDT|UTC|GMT)\s*$/i, "");

  const m = s.match(/(20\d{2})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})/);
  if (!m) return { date: null, time: null };

  const hh = String(m[4]).padStart(2, "0");
  return { date: `${m[1]}-${m[2]}-${m[3]}`, time: `${hh}:${m[5]}` };
}

  //TODO Remove This
function inferDateTimeFromScanTimestamp_BAK(ts) {
  if (!ts) return { date: null, time: null };
  const s = String(ts).trim();

  // Common forms:
  // 2026-02-03 08:44:00
  // 2026-02-03T08:44:00
  // 02/03/2026 08:44
  // 2026-02-03 08:44

  // ISO-ish
  const iso = s.replace(" ", "T");
  const d = new Date(iso);
  if (!Number.isNaN(d.getTime())) {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const min = String(d.getMinutes()).padStart(2, "0");
    return { date: `${yyyy}-${mm}-${dd}`, time: `${hh}:${min}` };
  }

  // Fallback regex: YYYY-MM-DD HH:MM
  const m = s.match(/(20\d{2})-(\d{2})-(\d{2}).*?(\d{1,2}):(\d{2})/);
  if (m) {
    const hh = String(m[4]).padStart(2, "0");
    return { date: `${m[1]}-${m[2]}-${m[3]}`, time: `${hh}:${m[5]}` };
  }

  return { date: null, time: null };
}

function parseCSV(text) {
  // Simple CSV parser that handles quoted fields.
  const rows = [];
  let cur = "";
  let inQuotes = false;
  let row = [];

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === '"' && inQuotes && next === '"') { // escaped quote
      cur += '"';
      i++;
    } else if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      row.push(cur);
      cur = "";
    } else if ((ch === "\n" || ch === "\r") && !inQuotes) {
      if (ch === "\r" && next === "\n") i++;
      row.push(cur);
      rows.push(row);
      cur = "";
      row = [];
    } else {
      cur += ch;
    }
  }
  // last cell
  if (cur.length > 0 || row.length > 0) {
    row.push(cur);
    rows.push(row);
  }
  return rows;
}

export default function SimulatorPage() {
  const [date, setDate] = useState("");
  const [signalTime, setSignalTime] = useState("08:00");
  const [barInterval, setBarInterval] = useState("1m");
  const [entryMode, setEntryMode] = useState("limit");     // default #2
  const [entryFill, setEntryFill] = useState("mid");       // low|mid|high
  const [profitPct, setProfitPct] = useState(0.15);        // configurable 15%
  const [useStop, setUseStop] = useState(true);
  const [conflictPolicy, setConflictPolicy] = useState("worst_case");
  const [tsv, setTsv] = useState("");
  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState(null);
  const [results, setResults] = useState([]);
  const [minScore, setMinScore] = useState("");
  const [cfgLoading, setCfgLoading] = useState(false);
  const [cfgError, setCfgError] = useState(null);
  const [simDefaults, setSimDefaults] = useState(null);
  const [overrideDefaults, setOverrideDefaults] = useState(false);
  const [csvColumnCount, setCsvColumnCount] = useState(null);

  const recs = useMemo(() => parseTSV(tsv), [tsv]);
  const filteredResults = useMemo(() => {
    const ms = Number(minScore);
    if (!Number.isFinite(ms)) return results;
    return results.filter(r => (Number(r.score) || 0) >= ms);
  }, [results, minScore]);

  const didInitFromConfigRef = useRef(false);   // IMPORTANT: don’t clobber user edits after initial load
  const fileInputRef = useRef(null);

  const maxRecs = simDefaults?.max_recs_per_run ?? 50;
  const recsCapped = recs.slice(0, maxRecs);
  const shownColumns = useMemo(() => {
    const firstLine = (tsv || "").split(/\r?\n/)[0] || "";
    return firstLine ? firstLine.split("\t").length : 0;
  }, [tsv]);

  useEffect(() => {
    let cancelled = false;

    async function loadConfig() {
      setCfgLoading(true);
      setCfgError(null);
      try {
        const res = await fetch("/api/config");
        const text = await res.text();
        const conf = JSON.parse(text);

        const sim = conf?.simulator || null;

        if (!cancelled) {
          setSimDefaults(sim);

          // Apply defaults ONCE
          if (sim && !didInitFromConfigRef.current) {
            didInitFromConfigRef.current = true;

            // Defaults from config (fallback to existing UI defaults)
            setBarInterval(sim.bar_interval_default ?? "1m");
            setEntryMode(sim.default_entry_mode ?? "limit");
            setEntryFill(sim.entry_fill_default ?? "mid");
            setProfitPct(
              typeof sim.profit_pct_default === "number" ? sim.profit_pct_default : 0.15
            );
            setConflictPolicy(sim.conflict_policy ?? "worst_case");
            setUseStop(
              typeof sim.use_stop_default === "boolean" ? sim.use_stop_default : true
            );

            // Min score filter
            setMinScore(
              sim.min_score_default != null ? String(sim.min_score_default) : ""
            );

            // Optional: use session_start as the default signal time
            if (sim.session_start) {
              setSignalTime(sim.session_start);
            }
          }
        }
      } catch (e) {
        if (!cancelled) setCfgError(String(e?.message || e));
      } finally {
        if (!cancelled) setCfgLoading(false);
      }
    }

    loadConfig();
    return () => { cancelled = true; };
  }, []);

  function csvRowsToRecsAndMeta(rows) {
    if (!rows || rows.length < 2) return { recs: [], scanTimestamp: null, scanTimestampMismatch: false };

    const headers = rows[0].map(h => String(h || "").trim());
    const idx = (name) => headers.findIndex(h => h.toLowerCase() === name.toLowerCase());
    const get = (r, name) => {
      const i = idx(name);
      return i >= 0 ? r[i] : "";
    };

    let scanTimestamp = null;
    let scanTimestampMismatch = false;

    const recs = [];

    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r || r.length === 0) continue;

      const ticker = get(r, "Ticker");
      if (!String(ticker || "").trim()) continue;

      const ts = String(get(r, "ScanTimestamp") || "").trim();
      if (!scanTimestamp && ts) scanTimestamp = ts;
      if (scanTimestamp && ts && ts !== scanTimestamp) scanTimestampMismatch = true;

      recs.push({
        Ticker: ticker,
        Premarket: toNumMaybe(get(r, "Premarket")),   /*OMIT?*/
        "Gap %": toNumMaybe(get(r, "Gap %")),         /*OMIT?*/
        "Gap Dir": get(r, "Gap Dir"),                 /*OMIT?*/
        RelVol: toNumMaybe(get(r, "RelVol")),         /*OMIT?*/
        "ATR %": toNumMaybe(get(r, "ATR %")),         /*OMIT?*/
        Score: toNumMaybe(get(r, "Score")),
        Chart: get(r, "Chart"),                       /*OMIT?*/
        NEW: get(r, "NEW"),                           /*OMIT?*/
        Pattern: get(r, "Pattern"),                   /*OMIT?*/
        EntryLow: toNumMaybe(get(r, "EntryLow")),
        EntryHigh: toNumMaybe(get(r, "EntryHigh")),
        Stop: toNumMaybe(get(r, "Stop")),
        Target1: toNumMaybe(get(r, "Target1")),
        Target2: toNumMaybe(get(r, "Target2")),
        RR_T1: toNumMaybe(get(r, "RR_T1")),           /*OMIT?*/
        RR_T2: toNumMaybe(get(r, "RR_T2")),           /*OMIT?*/
        MomentumScore: toNumMaybe(get(r, "MomentumScore")), /*OMIT?*/
        SignalId: get(r, "SignalId"), 
        ScanTimestamp: ts,
        SignalStartTimestamp: String(get(r, "SignalStartTimestamp") || "")
      });
    }
    return { recs, scanTimestamp, scanTimestampMismatch };
}

  function inferDateTimeFromFilename(name) {
    const s = String(name || "");

    // 1) YYYY-MM-DD and HHMM or HH:MM or HH-MM
    const m1 = s.match(/(20\d{2})[-_](\d{2})[-_](\d{2}).*?(\d{1,2})[:\-]?(\d{2})/);
    if (m1) {
      const yyyy = m1[1], mm = m1[2], dd = m1[3];
      const hh = String(m1[4]).padStart(2, "0");
      const min = m1[5];
      return { date: `${yyyy}-${mm}-${dd}`, time: `${hh}:${min}` };
    }

    // 2) YYYYMMDD and HHMM
    const m2 = s.match(/(20\d{2})(\d{2})(\d{2}).*?(\d{2})(\d{2})/);
    if (m2) {
      const yyyy = m2[1], mm = m2[2], dd = m2[3];
      const hh = m2[4], min = m2[5];
      return { date: `${yyyy}-${mm}-${dd}`, time: `${hh}:${min}` };
    }

    // 3) Date only
    const m3 = s.match(/(20\d{2})[-_](\d{2})[-_](\d{2})/);
    if (m3) {
      return { date: `${m3[1]}-${m3[2]}-${m3[3]}`, time: null };
    }

    return { date: null, time: null };
  }

  async function handleLoadCsv(e) {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const rows = parseCSV(text);

      setCsvColumnCount(rows?.[0]?.length || null);

      const { recs: recsFromCsv, scanTimestamp, scanTimestampMismatch  } = csvRowsToRecsAndMeta(rows);

      if (scanTimestampMismatch) {
        setSummary({ error: "This CSV contains multiple ScanTimestamp values. The Simulator expects ONE scan (one minute). Export a single-minute scan file." });
        return;
      }

      // Convert to TSV (so you keep your existing parseTSV pipeline unchanged)
      // Include exactly the headers your parseTSV expects.
      //const headers = [
      //  "Ticker","Premarket","Gap %","Gap Dir","RelVol","ATR %","Score","Chart","NEW","Pattern",
      //  "EntryLow","EntryHigh","Stop","Target1","Target2","RR_T1","RR_T2","MomentumScore","SignalId","ScanTimestamp"
      //];
      const headers = [
        "Ticker","Premarket","Gap %","Gap Dir","RelVol","ATR %","Score",
        "EntryLow","EntryHigh","Stop","Target1","Target2","RR_T1","RR_T2", "ScanTimestamp"
      ];

      const tsvOut = [
        headers.join("\t"),
        ...recsFromCsv.map(r => headers.map(h => (r[h] ?? "")).join("\t"))
      ].join("\n");

      setTsv(tsvOut);

      // Prefer ScanTimestamp for auto date/time
      const inferred = inferDateTimeFromScanTimestamp(scanTimestamp);
      if (inferred.date) setDate(inferred.date);
      if (inferred.time) setSignalTime(inferred.time);

      // Fallback to filename if ScanTimestamp wasn't usable
      if (!inferred.date || !inferred.time) {
        const guess = inferDateTimeFromFilename(file.name);
        if (!inferred.date && guess.date) setDate(guess.date);
        if (!inferred.time && guess.time) setSignalTime(guess.time);
      }

    } catch (err) {
      setSummary({ error: `CSV load failed: ${String(err?.message || err)}` });
    } finally {
      e.target.value = "";
    }
  }

  async function runBatch() {
    setLoading(true);
    setSummary(null);
    setResults([]);

    try {
        const res = await fetch("/api/sim/run_day_batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            date,
            signal_time: signalTime,
            bar_interval: barInterval,
            cfg: {
              entry_mode: entryMode,
              entry_fill: entryFill,
              profit_pct: profitPct,
              use_stop: useStop,
              conflict_policy: conflictPolicy
              },
            recs: recsCapped 
        })
        });

        // Read as text first (works even if server returns HTML by mistake)
        const text = await res.text();

        let payload;
        try {
            payload = JSON.parse(text);
        } catch (e) {
            throw new Error(`Non-JSON response (${res.status}): ${text.slice(0, 120)}`);
        }

        if (!res.ok) {
            // If backend returns error JSON, show it
            throw new Error(payload?.error || payload?.message || `HTTP ${res.status}`);
        }

        setSummary(payload.summary || null);
        setResults(payload.results || []);
    } catch (e) {
        setSummary({ error: String(e.message || e) });
    } finally {
        setLoading(false);
    }
  }

  return (
    <div style={{ padding: 16 }}>
      <h2 style={{ marginBottom: 8 }}>Simulator</h2>
      {cfgLoading && <div style={{ opacity: 0.7, marginBottom: 8 }}>Loading config…</div>}
      {cfgError && <div style={{ color: "crimson", marginBottom: 8 }}>Config load error: {cfgError}</div>}
      {simDefaults && !cfgLoading && !cfgError && (
        <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 8 }}>
          Defaults loaded from config.simulator
        </div>
      )}
      {!overrideDefaults && simDefaults && (
        <div style={{ gridColumn: "1 / -1", fontSize: 12, opacity: 0.75 }}>
          Using config: interval <b>{barInterval}</b>, profit <b>{Math.round(profitPct*100)}%</b>, policy <b>{conflictPolicy}</b>, min score <b>{minScore || "0"}</b>
        </div>
      )}
      <div style={{ display: "flex", alignItems: "end", gap: 8 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            checked={overrideDefaults}
            onChange={e => setOverrideDefaults(e.target.checked)}
          />
          Override config defaults
        </label>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(160px, 1fr))", gap: 10, marginBottom: 12 }}>
        <div>
          <div>Date (YYYY-MM-DD)</div>
          <input 
            type="date"
            value={date} 
            onChange={e => setDate(e.target.value)} 
            placeholder="2026-01-27" 
            style={{ width: "100%", padding: 8 }} 
          />
          <div style={{ fontSize: 12, opacity: 0.7 }}>ET (New York)</div>
        </div>
        <div>
          <div>Signal Time</div>
          <input 
            type="time"
            step="60"
            value={signalTime} 
            onChange={e => setSignalTime(e.target.value)} 
            style={{ width: "100%", padding: 8 }} 
        />
        </div>
        {overrideDefaults && (
          <>
            <div>
              <div>Bar Interval</div>
              <select value={barInterval} onChange={e => setBarInterval(e.target.value)} style={{ width: "100%", padding: 8 }}>
                <option value="1m">1m</option>
                <option value="2m">2m</option>
                <option value="5m">5m</option>
                <option value="15m">15m</option>
              </select>
            </div>
             <div>
              <div>Profit Target %</div>
              <input
                type="number"
                step="0.01"
                value={profitPct}
                onChange={e => setProfitPct(Number(e.target.value))}
                style={{ width: "100%", padding: 8 }}
              />
              <div style={{ fontSize: 12, opacity: 0.8 }}>0.15 = 15%</div>
            </div>
            <div>
              <div>Conflict Policy</div>
              <select value={conflictPolicy} onChange={e => setConflictPolicy(e.target.value)} style={{ width: "100%", padding: 8 }}>
                <option value="worst_case">Worst-case (stop wins)</option>
                <option value="best_case">Best-case (target wins)</option>
              </select>
            </div>
             <div>
              <div>Min Score Filter</div>
              <input value={minScore} onChange={e => setMinScore(e.target.value)} placeholder="e.g. 5000" style={{ width: "100%", padding: 8 }} />
            </div>
          </>
        )}
        
        <div>
          <div>Entry Mode</div>
          <select value={entryMode} onChange={e => setEntryMode(e.target.value)} style={{ width: "100%", padding: 8 }}>
            <option value="limit">#2 Limit (pullback) — default</option>
            <option value="stop">#1 Stop (breakout)</option>
            <option value="market">#3 Market (auto sim)</option>
          </select>
        </div>

        <div>
          <div>Entry Fill</div>
          <select value={entryFill} onChange={e => setEntryFill(e.target.value)} style={{ width: "100%", padding: 8 }}>
            <option value="mid">Mid (recommended)</option>
            <option value="low">EntryLow</option>
            <option value="high">EntryHigh</option>
          </select>
        </div>

        <div style={{ display: "flex", alignItems: "end", gap: 8 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input type="checkbox" checked={useStop} onChange={e => setUseStop(e.target.checked)} />
            Use Stop
          </label>
        </div>

        <div style={{ display: "flex", alignItems: "end" }}>
          <button 
            onClick={runBatch} 
            disabled={loading || !date || recs.length === 0} 
            style={{ padding: "10px 14px", width: "100%" }}>
            {loading ? "Running..." : `Run Batch (${Math.min(recs.length, maxRecs)} of ${recs.length})`}
          </button>
        </div>
        {recs.length > maxRecs && (
          <div style={{ color: "crimson", fontSize: 12 }}>
            Pasted {recs.length} rows. Config max is {maxRecs}. Only the first {maxRecs} will run.
          </div>
        )}

      </div>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 6 }}>
        <div>Paste Recommendations (TSV) or load CSV</div>
        {csvColumnCount && (
              <div style={{
                fontSize: 12,
                opacity: 0.7,
                background: "rgba(120,120,120,0.15)",
                padding: "4px 8px",
                borderRadius: 6
              }}>
                Showing simulator columns only ({shownColumns} of {csvColumnCount} fields)
              </div>
            )}
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          style={{ padding: "6px 10px" }}
        >
          Load CSV…
        </button>

        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,text/csv"
          style={{ display: "none" }}
          onChange={handleLoadCsv}
        />
      </div>

      <div style={{ marginBottom: 10 }}>
        <textarea
          value={tsv}
          onChange={e => setTsv(e.target.value)}
          placeholder="Paste your tab-separated table here (header row included)..."
          style={{ width: "100%", height: 180, padding: 10, fontFamily: "monospace" }}
        />
        <div style={{ marginTop: 6, opacity: 0.8, fontSize: 12 }}>
          Parsed rows: <b>{recs.length}</b>
        </div>
      </div>

      {summary && (
        <div style={{ padding: 10, border: "1px solid #ccc", borderRadius: 8, marginBottom: 12 }}>
          <b>Summary</b>
          <div style={{ marginTop: 6 }}>
            {summary.error ? (
              <div style={{ color: "crimson" }}>{summary.error}</div>
            ) : (
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                <div>Total: <b>{summary.count}</b></div>
                <div>OK: <b>{summary.ok}</b></div>
                <div>T1 hit: <b>{summary.t1_hit}</b></div>
                <div>T2 hit: <b>{summary.t2_hit}</b></div>
                <div>+{Math.round(profitPct * 100)}% hit: <b>{summary.pct_hit}</b></div>
                <div>Stop hit: <b>{summary.stop_hit}</b></div>
              </div>
            )}
          </div>
        </div>
      )}

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              {["Ticker","Score","Filled","T1","T2",`+${Math.round(profitPct*100)}%`,"Stop","Entry","MFE","MAE","Outcome","Times"].map(h => (
                <th key={h} style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: 8, whiteSpace: "nowrap" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filteredResults.map((r, idx) => {
              if (r.status !== "OK") {
                return (
                  <tr key={idx}>
                    <td className={`${styles.summaryRow}`}>{r.symbol || ""}</td>
                    <td className={`${styles.summaryRow}`}>{r.score ?? ""}</td>
                    <td colSpan={9} style={{ padding: 8, borderBottom: "1px solid #f0f0f0", color: "crimson" }}>
                      {r.status}: {r.reason || ""}
                    </td>
                  </tr>
                );
              }

              const levels = r.levels || {};
              const entry = r.entry || {};
              const stats = r.stats || {};
              const outcome = r.outcome || {};

              const filled = entry.price != null;
              const t1 = !!levels.t1?.hit;
              const t2 = !!levels.t2?.hit;
              const pct = !!levels.pct?.hit;
              const st = !!levels.stop?.hit;

              const times = [
                `E:${fmtTime(entry.time)}`,
                levels.t1?.hit ? `T1:${fmtTime(levels.t1.time)}` : "",
                levels.t2?.hit ? `T2:${fmtTime(levels.t2.time)}` : "",
                levels.pct?.hit ? `P:${fmtTime(levels.pct.time)}` : "",
                levels.stop?.hit ? `S:${fmtTime(levels.stop.time)}` : "",
              ].filter(Boolean).join("  ");

              return (
                <tr key={idx}>
                  <td className={styles.summaryRow}>{r.symbol}</td>
                  <td className={styles.summaryRow}>{(r.score ?? "").toString()}</td>
                  <td className={styles.summaryRow}>{filled ? "✅" : "—"}</td>
                  <td className={styles.summaryRow}>{t1 ? "✅" : "—"}</td>
                  <td className={styles.summaryRow}>{t2 ? "✅" : "—"}</td>
                  <td className={styles.summaryRow}>{pct ? "✅" : "—"}</td>
                  <td className={styles.summaryRow}>{st ? "🛑" : "—"}</td>
                  <td className={styles.summaryRowLast}>
                    {entry.price?.toFixed?.(2)} @ {fmtTime(entry.time)}
                  </td>
                  <td className={styles.summaryRow}>{fmtPct(stats.mfe_pct)}</td>
                  <td className={styles.summaryRow}>{fmtPct(stats.mae_pct)}</td>
                  <td className={styles.summaryRow}>{outcome.result || ""}</td>
                  <td className={styles.summaryRowLast}>{times}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 10, opacity: 0.7, fontSize: 12 }}>
        <b>NOTE:</b> Yahoo intraday history is limited. Older dates may show NO_DATA even if the stock traded.
        <br/><b>MFE:</b> (Maximum Favorable Excursion). A metric that measures the highest amount of 
        unrealized profit a trade reached while it was open, before closing.
        <br/><b>MAE:</b> (Maximum Adverse Excursion). A metric which measures the maximum loss a trade faced before closing. 
      </div>
    </div>
  );
}
