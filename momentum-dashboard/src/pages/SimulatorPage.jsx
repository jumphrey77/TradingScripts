import React, { useMemo, useState } from "react";

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
    const toNum = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : v;
    };

    ["Premarket","Gap %","RelVol","ATR %","Score","EntryLow","EntryHigh","Stop","Target1","Target2","RR_T1","RR_T2"]
      .forEach(k => { if (row[k] !== undefined) row[k] = toNum(row[k]); });

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

function fmtPct(x) {
  if (x == null || !Number.isFinite(x)) return "";
  return `${(x * 100).toFixed(1)}%`;
}
function fmtTime(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

export default function SimulatorPage() {
  const [date, setDate] = useState("");
  const [signalTime, setSignalTime] = useState("09:30:00");
  const [barInterval, setBarInterval] = useState("1m");

  const [entryMode, setEntryMode] = useState("limit");     // default #2
  const [entryFill, setEntryFill] = useState("mid");       // low|mid|high
  const [profitPct, setProfitPct] = useState(0.15);        // configurable 15%

  const [useStop, setUseStop] = useState(true);
  const [conflictPolicy, setConflictPolicy] = useState("worst_case");

  const [tsv, setTsv] = useState("");
  const recs = useMemo(() => parseTSV(tsv), [tsv]);

  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState(null);
  const [results, setResults] = useState([]);

  const [minScore, setMinScore] = useState("");
  const filteredResults = useMemo(() => {
    const ms = Number(minScore);
    if (!Number.isFinite(ms)) return results;
    return results.filter(r => (Number(r.score) || 0) >= ms);
  }, [results, minScore]);

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
          recs
        })
      });
      const data = await res.json();
      setSummary(data.summary || null);
      setResults(data.results || []);
    } catch (e) {
      setSummary({ error: String(e) });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ padding: 16 }}>
      <h2 style={{ marginBottom: 8 }}>Simulator</h2>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(160px, 1fr))", gap: 10, marginBottom: 12 }}>
        <div>
          <div>Date (YYYY-MM-DD)</div>
          <input value={date} onChange={e => setDate(e.target.value)} placeholder="2026-01-27" style={{ width: "100%", padding: 8 }} />
        </div>
        <div>
          <div>Signal Time</div>
          <input value={signalTime} onChange={e => setSignalTime(e.target.value)} style={{ width: "100%", padding: 8 }} />
        </div>
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

        <div style={{ display: "flex", alignItems: "end", gap: 8 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input type="checkbox" checked={useStop} onChange={e => setUseStop(e.target.checked)} />
            Use Stop
          </label>
        </div>

        <div>
          <div>Min Score Filter</div>
          <input value={minScore} onChange={e => setMinScore(e.target.value)} placeholder="e.g. 5000" style={{ width: "100%", padding: 8 }} />
        </div>

        <div style={{ display: "flex", alignItems: "end" }}>
          <button onClick={runBatch} disabled={loading || !date || recs.length === 0} style={{ padding: "10px 14px", width: "100%" }}>
            {loading ? "Running..." : `Run Batch (${recs.length})`}
          </button>
        </div>
      </div>

      <div style={{ marginBottom: 10 }}>
        <div style={{ marginBottom: 6 }}>Paste Recommendations (TSV from your table)</div>
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
                    <td style={{ padding: 8, borderBottom: "1px solid #f0f0f0" }}>{r.symbol || ""}</td>
                    <td style={{ padding: 8, borderBottom: "1px solid #f0f0f0" }}>{r.score ?? ""}</td>
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
                  <td style={{ padding: 8, borderBottom: "1px solid #f0f0f0" }}>{r.symbol}</td>
                  <td style={{ padding: 8, borderBottom: "1px solid #f0f0f0" }}>{(r.score ?? "").toString()}</td>
                  <td style={{ padding: 8, borderBottom: "1px solid #f0f0f0" }}>{filled ? "✅" : "—"}</td>
                  <td style={{ padding: 8, borderBottom: "1px solid #f0f0f0" }}>{t1 ? "✅" : "—"}</td>
                  <td style={{ padding: 8, borderBottom: "1px solid #f0f0f0" }}>{t2 ? "✅" : "—"}</td>
                  <td style={{ padding: 8, borderBottom: "1px solid #f0f0f0" }}>{pct ? "✅" : "—"}</td>
                  <td style={{ padding: 8, borderBottom: "1px solid #f0f0f0" }}>{st ? "🛑" : "—"}</td>
                  <td style={{ padding: 8, borderBottom: "1px solid #f0f0f0", whiteSpace: "nowrap" }}>
                    {entry.price?.toFixed?.(2)} @ {fmtTime(entry.time)}
                  </td>
                  <td style={{ padding: 8, borderBottom: "1px solid #f0f0f0" }}>{fmtPct(stats.mfe_pct)}</td>
                  <td style={{ padding: 8, borderBottom: "1px solid #f0f0f0" }}>{fmtPct(stats.mae_pct)}</td>
                  <td style={{ padding: 8, borderBottom: "1px solid #f0f0f0" }}>{outcome.result || ""}</td>
                  <td style={{ padding: 8, borderBottom: "1px solid #f0f0f0", whiteSpace: "nowrap" }}>{times}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 10, opacity: 0.7, fontSize: 12 }}>
        Note: Yahoo intraday history is limited. Older dates may show NO_DATA even if the stock traded.
      </div>
    </div>
  );
}
