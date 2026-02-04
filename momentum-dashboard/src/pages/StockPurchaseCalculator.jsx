import React, { useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";

// ---------- helpers ----------
function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function fmtMoney(n) {
  return n.toLocaleString(undefined, { style: "currency", currency: "USD" });
}
function fmtPct(n) {
  return `${n.toFixed(2)} %`;
}
function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}
function parseQuery(search) {
  const p = new URLSearchParams(search);
  const get = (k) => (p.get(k) ?? "").trim();
  return {
    ticker: get("ticker"),
    date: get("date"),
    entry1: get("entry1"),
    entry2: get("entry2"),
    t1: get("t1"),
    t2: get("t2"),
  };
}

export default function StockPurchaseCalculator() {
  const { search } = useLocation();

  // Core inputs
  const [ticker, setTicker] = useState("");
  const [recDate, setRecDate] = useState(""); // free text like "01/30/2026 9:40"
  const [entry1, setEntry1] = useState(2.2);
  const [entry2, setEntry2] = useState(2.3);
  const [t1, setT1] = useState(3.3);
  const [t2, setT2] = useState(4.4);

  // Trading inputs
  const [bidPrice, setBidPrice] = useState(2.1);
  const [shares, setShares] = useState(200);

  // Ladder inputs (10 additional price points)
  const [startPct, setStartPct] = useState(5.0);      // 5.0%
  const [incrementPct, setIncrementPct] = useState(2.5); // 2.5%
  const [numPrices, setNumPrices] = useState(10);

  // Load from query params on first render / when URL changes
  //setBidPrice
  useEffect(() => {
    const q = parseQuery(search);
    if (q.ticker) setTicker(q.ticker.toUpperCase());
    if (q.date) setRecDate(q.date);
    if (q.entry1) setEntry1(toNum(q.entry1, 0));
    if (q.entry1) setBidPrice(toNum(q.entry1, 0));
    if (q.entry2) setEntry2(toNum(q.entry2, 0));
    if (q.t1) setT1(toNum(q.t1, 0));
    if (q.t2) setT2(toNum(q.t2, 0));
  }, [search]);

  const shareUrl = useMemo(() => {
    const params = new URLSearchParams();
    if (ticker) params.set("ticker", ticker);
    if (recDate) params.set("date", recDate);
    params.set("entry1", String(entry1));
    params.set("entry2", String(entry2));
    params.set("t1", String(t1));
    params.set("t2", String(t2));
    return `?${params.toString()}`;
    }, [ticker, recDate, entry1, entry2, t1, t2]);

  const derived = useMemo(() => {
    const e1 = toNum(entry1, 0);
    const e2 = toNum(entry2, 0);
    const T1 = toNum(t1, 0);
    const T2 = toNum(t2, 0);
    const bp = toNum(bidPrice, 0);
    const sh = Math.max(0, Math.floor(toNum(shares, 0)));

    const cost = bp * sh;

    const entryRange = e2 - e1;  // E2 - E1
    const targetRange = T2 - T1; // T2 - T1

    const t1pps = T1 - e1;
    const t2pps = T2 - e1;

    const t1Profit = t1pps * sh;
    const t2Profit = t2pps * sh;

    const t1TotalSale = T1 * sh;
    const t2TotalSale = T2 * sh;

    const t1ProfitPct = e1 > 0 ? (t1pps / e1) * 100 : 0;
    const t2ProfitPct = e1 > 0 ? (t2pps / e1) * 100 : 0;

    const ladderCount = clamp(Math.floor(toNum(numPrices, 10)), 1, 50);
    const sPct = toNum(startPct, 0);
    const incPct = toNum(incrementPct, 0);

    // Ladder based on Bid Price (NOT bid price)
    const ladder = Array.from({ length: ladderCount }, (_, i) => {
        const pct = sPct + i * incPct;                 // 5%, 7.5%, 10%, ...
        const price = bp * (1 + pct / 100);            // Bid * (1 + pct)
        const pps = price - bp;                        // per-share gain from Entry1
        const profit = pps * sh;                       // total profit vs Entry1
        return {
            pct,
            price: round2(price),
            pps: round2(pps),
            profit: round2(profit),
        };
    });

    return {
      e1, e2, T1, T2, bp, sh,
      cost,
      entryRange,targetRange,
      t1pps, t2pps,
      t1Profit, t2Profit,
      t1TotalSale, t2TotalSale,
      t1ProfitPct, t2ProfitPct,
      ladder,
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry1, entry2, t1, t2, bidPrice, shares, startPct, incrementPct, numPrices]);

  // Simple styling (match your app later / convert to CSS module if you want)
  const card = {
    background: "rgba(255,255,255,0.06)",
    border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: 14,
    padding: 16,
  };
  const responsiveRow = {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
    gap: 12,
    alignItems: "start",
    };
  const grid = { display: "grid", gap: 14 };
  /*const row = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 };*/
  const label = { fontSize: 12, opacity: 0.75, marginBottom: 6 };
  const input = {
    width: "100%",
    minWidth: 0,
    padding: "10px 12px",
    borderRadius: 10,
    border: "1px solid rgba(255,255,255,0.18)",
    background: "rgba(0,0,0,0.25)",
    color: "inherit",
    outline: "none",
    boxSizing: "border-box",
  };
  const table = {
    width: "100%",
    borderCollapse: "collapse",
    fontSize: 13,
    overflow: "hidden",
    borderRadius: 12,
  };
  const th = {
    textAlign: "left",
    padding: "10px 10px",
    borderBottom: "1px solid rgba(255,255,255,0.12)",
    opacity: 0.8,
    fontWeight: 600,
    whiteSpace: "nowrap",
  };
  const td = {
    padding: "9px 10px",
    borderBottom: "1px solid rgba(255,255,255,0.08)",
    whiteSpace: "nowrap",
  };
  const right = { textAlign: "right" };

  return (
    <div style={{ padding: 18, maxWidth: 1100, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0 }}>Stock Purchase Calculator</h2>
        <div style={{ opacity: 0.7, fontSize: 13 }}>
          Shareable URL: <span style={{ fontFamily: "monospace" }}>{shareUrl}</span>
        </div>
      </div>
      <div
          style={{
              marginTop: 14,
              display: "grid",
              gap: 14,
              gridTemplateColumns: "1.1fr 0.9fr",
              alignItems: "start",
          }}
      >
        {/* LEFT: Recomendation */}
        <div style={{ ...card, ...grid }}>
          <div style={{ fontWeight: 800, marginBottom: 0 }}>Recommendation</div>
          <div style={responsiveRow}>
            <div>
              <div style={label}>Ticker</div>
              {/*<input style={input} value={ticker} readOnly  />*/}
              <div style={{ fontSize: 16, fontWeight: 700, paddingLeft: 10 }}>{ticker}</div>
            </div>
            <div>
              <div style={label}>Recommendation Date/Time</div>
              {/*<input style={input} value={recDate} readOnly />*/}
              <div style={{ fontSize: 16, fontWeight: 700, paddingLeft: 10 }}>{recDate}</div>
            </div>
          </div>
          <div style={responsiveRow}>
            <div>
              <div style={label}>Entry 1</div>
              {/*<input style={input} type="number" readOnly value={entry1}  />*/}
              <div style={{ fontSize: 16, fontWeight: 700, paddingLeft: 10 }}>{fmtMoney(entry1)}</div>
            </div>
            <div>
              <div style={label}>Entry 2</div>
              {/*<input style={input} type="number" step="0.01" readOnly value={entry2}  />*/}
              <div style={{ fontSize: 16, fontWeight: 700, paddingLeft: 10 }}>{fmtMoney(entry2)}</div>
            </div>
          </div>
          <div style={responsiveRow}>
            <div>
              <div style={label}>Target 1 (T1)</div>
              {/*<input style={input} type="number" step="0.01" readOnly value={t1}  />*/}
              <div style={{ fontSize: 16, fontWeight: 700, paddingLeft: 10 }}>{fmtMoney(t1)}</div>
            </div>
            <div>
              <div style={label}>Target 2 (T2)</div>
              {/*<input style={input} type="number" step="0.01" readOnly value={t2}  />*/}
              <div style={{ fontSize: 16, fontWeight: 700, paddingLeft: 10 }}>{fmtMoney(t2)}</div>
            </div>
          </div>
          <div style={responsiveRow}>
            <div>
              <div style={label}>Entry Range (E2 - E1)</div>
              <div style={{ fontSize: 16, fontWeight: 700, paddingLeft: 10  }}>{fmtMoney(derived.entryRange)}</div>
            </div>
            <div>
              <div style={label}>Target Range (T2 - T1)</div>
              <div style={{ fontSize: 16, fontWeight: 700, paddingLeft: 10  }}>{fmtMoney(derived.targetRange)}</div>
            </div>
          </div>
          {/*<div style={responsiveRow}>
            <div style={{ ...card, padding: 12 }}>
              <div style={label}>Entry Range (E2 - E1)</div>
              <div style={{ fontSize: 16, fontWeight: 700 }}>{fmtMoney(derived.entryRange)}</div>
            </div>
            <div style={{ ...card, padding: 12 }}>
              <div style={label}>Target Range (T2 - T1)</div>
              <div style={{ fontSize: 16, fontWeight: 700 }}>{fmtMoney(derived.targetRange)}</div>
            </div>
          </div>*/}
        </div>
        
        {/* RIGHT: bid  target profit summary */}
        <div style={{ ...grid }}>
          {/* BLOCK - BID */}
          <div style={{ ...card, ...grid }}>
            {/* Bidding */}
            <div style={responsiveRow}>
              <div>
                <div style={label}>Bid Price (your buy price)</div>
                <input style={input} type="number" step="0.01" value={bidPrice} onChange={(e) => setBidPrice(toNum(e.target.value, 0))} />
              </div>
              <div>
                <div style={label}># of Shares</div>
                <input style={input} type="number" step="1" value={shares} onChange={(e) => setShares(toNum(e.target.value, 0))} />
              </div>
            </div>
            {/*Start Increment # of PRices*/}
            <div style={responsiveRow}>
              <div>
                <div style={label}>Start %</div>
                <input style={input} type="number" step="0.1" value={startPct} onChange={(e) => setStartPct(toNum(e.target.value, 0))} />
              </div>
              <div>
                <div style={label}>Increment %</div>
                <input style={input} type="number" step="0.1" value={incrementPct} onChange={(e) => setIncrementPct(toNum(e.target.value, 0))} />
              </div>
              <div>
                <div style={label}># of Prices</div>
                <input style={input} type="number" step="1" value={numPrices} onChange={(e) => setNumPrices(toNum(e.target.value, 10))} />
              </div>
            </div>
            {/* Cost */}  
            <div style={{ display: "flex", justifyContent: "space-between", opacity: 0.85 }}>
              <div>Cost</div>
              <div style={{ fontWeight: 700 }}>{fmtMoney(derived.cost)}</div>
            </div>
          </div>
          {/* BLOCK Target Price */} 
          <div style={{ ...card }}>
            <div style={{ fontWeight: 800, marginBottom: 10 }}>Target Profits</div>
            <div style={responsiveRow}>
              <div style={{ ...card, padding: 12 }}>
                <div style={{ fontWeight: 700, marginBottom: 8 }}>Target 1</div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ opacity: 0.75 }}>Sell Price</span>
                  <span style={{ fontWeight: 700 }}>{fmtMoney(derived.T1)}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ opacity: 0.75 }}>Profit %</span>
                  <span style={{ fontWeight: 700 }}>{fmtPct(derived.t1ProfitPct)}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ opacity: 0.75 }}>Total Sale</span>
                  <span style={{ fontWeight: 700 }}>{fmtMoney(derived.t1TotalSale)}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ opacity: 0.75 }}>Profit</span>
                  <span style={{ fontWeight: 800 }}>{fmtMoney(derived.t1Profit)}</span>
                </div>
              </div>

              <div style={{ ...card, padding: 12 }}>
                <div style={{ fontWeight: 700, marginBottom: 8 }}>Target 2</div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ opacity: 0.75 }}>Sell Price</span>
                  <span style={{ fontWeight: 700 }}>{fmtMoney(derived.T2)}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ opacity: 0.75 }}>Profit %</span>
                  <span style={{ fontWeight: 700 }}>{fmtPct(derived.t2ProfitPct)}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ opacity: 0.75 }}>Total Sale</span>
                  <span style={{ fontWeight: 700 }}>{fmtMoney(derived.t2TotalSale)}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ opacity: 0.75 }}>Profit</span>
                  <span style={{ fontWeight: 800 }}>{fmtMoney(derived.t2Profit)}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Ladder table */}
      <div style={{ ...card, marginTop: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <div style={{ fontWeight: 800 }}>Additional Price Points</div>
          <div style={{ opacity: 0.7, fontSize: 12 }}>
            Priceᵢ = Entry1 × (1 + (Start% + i×Increment%) )
          </div>
        </div>

        <div style={{ marginTop: 10, overflowX: "auto" }}>
          <table style={table}>
            <thead>
              <tr>
                <th style={th}>Move %</th>
                <th style={{ ...th, ...right }}>Price</th>
                <th style={{ ...th, ...right }}>PPS</th>
                <th style={{ ...th, ...right }}>Profit</th>
              </tr>
            </thead>
            <tbody>
              {derived.ladder.map((r, idx) => (
                <tr key={idx}>
                <td style={td}>{fmtPct(r.pct)}</td>
                <td style={{ ...td, ...right }}>{fmtMoney(r.price)}</td>
                <td style={{ ...td, ...right }}>{fmtMoney(r.pps)}</td>
                <td style={{ ...td, ...right }}>{fmtMoney(r.profit)}</td>
            </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div style={{ marginTop: 10, opacity: 0.7, fontSize: 12 }}>
          Notes: PPS = (Row Price - Entry1).

        </div>
      </div>
    </div>
  );
}
