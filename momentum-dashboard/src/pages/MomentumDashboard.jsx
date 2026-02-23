import React, { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import styles from "../styles/momentumdashboard.module.css";

const cx = (...classes) => classes.filter(Boolean).join(" ");

const options = {
  hour: '2-digit',
  minute: '2-digit'
};

const currentTime = new Date().toLocaleTimeString('en-US', options);

export default function MomentumDashboard() {
  const [data, setData] = useState([]);
  const [timestamp, setTimestamp] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [outcomes, setOutcomes] = useState([]);
  const outcomesMapRef = useRef(new Map());

  const prevNewCount = useRef(0);
  const beepSound = useRef(
    new Audio("https://actions.google.com/sounds/v1/alarms/beep_short.ogg")
  );
  
  // ------------------------
  // THEME
  // ------------------------
 
  const lastEventId = useRef(0);

  // ------------------------
  // DATA FETHCERS
  // ------------------------

  // fetchData
  const fetchData = async () => {
    try {
      setError(null);

      const res = await fetch("http://localhost:5000/api/scan");

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const json = await res.json();

      console.log("📡 API payload:", json);

      const rows = Array.isArray(json.rows) ? json.rows : [];

      console.log("📊 Rows received:", rows.length);

      const newCount = rows.filter(r => r.NEW).length;
      if (newCount > prevNewCount.current) {
        beepSound.current.play().catch(() => {});
      }
      prevNewCount.current = newCount;

      setData(rows);
      setTimestamp(json.timestamp || null);
      setLoading(false);

    } catch (err) {
        console.error("❌ Fetch error:", err);
        setError(err.message);
        setLoading(false);
    }
  };

  // fetchOutcomes
  const fetchOutcomes = async () => {
      try {
        const res = await fetch("http://localhost:5000/api/outcomes");
        if (!res.ok) throw new Error(`Outcomes HTTP ${res.status}`);

        const json = await res.json();
        const rows = Array.isArray(json.rows) ? json.rows : [];

        setOutcomes(rows); // optional—helps debugging

        const m = new Map();

        rows.forEach(r => {
          m.set(String(r.SignalId), r);
        });
        outcomesMapRef.current = m;

        console.log("✅ outcomes rows:", rows.length);

      } catch (e) {
        console.error("❌ Outcomes fetch error:", e);
      }
    };

  // pollEvents
  const pollEvents = async () => {
    try {
      const res = await fetch(`http://localhost:5000/api/events?after_id=${lastEventId.current}`);
      const json = await res.json();

      if (Array.isArray(json.events) && json.events.length) {
        json.events.forEach(e => {
          console.log("EVENT:", e.type, e.Ticker, e.details);
          // beep per event type
          beepSound.current.play().catch(() => {});
        });
      }

      lastEventId.current = json.latest_id || lastEventId.current;
    } catch (e) {
      console.error("Event poll error:", e);
    }
  };

  // ------------------------
  // EFFECTS
  // ------------------------

  useEffect(() => {
      fetchData();
      fetchOutcomes();
      pollEvents();

      const eventsInterval  = setInterval(pollEvents, 5000);
      const scanInterval = setInterval(fetchData, 60000);
      const outInterval = setInterval(fetchOutcomes, 15000);

      return () => {
        clearInterval(eventsInterval );
        clearInterval(scanInterval);
        clearInterval(outInterval);
      };
    }, []);

  // ------------------------
  // RENDER
  // ------------------------

  if (loading) {
    return <div className={styles.loading}>Loading data…</div>;
  }

  if (error) {
    return (
      <div className={styles.error}>
        Error: {error}
      </div>
    );
  }

  if (!data.length) {
    return (
      <div className={styles.noSignals}>
        No signals available.
      </div>
    );
  }

  const top10 = [...data]
    .sort((a, b) => (b.Score || 0) - (a.Score || 0))
    .slice(0, 10);

  return (

    /*
    <div style={{ padding: 20, fontFamily: "Arial, sans-serif" }}>
    style={{ fontSize: 12, color: "#666", marginBottom: 10 }}
           <div className={styles.timestamp}>{timestamp} {currentTime}</div>
   
    */

    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Momentum Scanner Dashboard</h1>
            <Link to="/config" 
              className={`${styles.calcLink} ${styles.tooltip}`}
              data-tooltip="Config"
            >
              ⚙ Config
            </Link><br/> 
            <Link to="/simulator" 
              className={`${styles.calcLink} ${styles.tooltip}`}
              target="_blank"
            >
              Simulator
            </Link> 
        </div>
        
      </div>

      <h2 className={styles.leaderboardTitle}>🔥 Top 10 Leaderboard - {currentTime}</h2>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        {top10.map(stock => (
          <Card
            key={`${stock.SignalId}`}
            stock={stock}
            outcomesMapRef={outcomesMapRef}
          />
        ))}
      </div>

      <h2 style={{ marginTop: 30 }}>📋 All Signals</h2>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        {data.map(stock => (
          <Card
            key={`${stock.SignalId}`}
            stock={stock}
            outcomesMapRef={outcomesMapRef}
          />
        ))}
      </div>

      {/* Optional debug: show outcomes count */}
      <div style={{ marginTop: 18, fontSize: 12, color: "#777" }}>
        Outcomes loaded: {outcomes.length}
      </div>
    </div>
  
  );
}

function buildCalcUrl(signal) {
  const params = new URLSearchParams({
    ticker: signal.Ticker,
    date: currentTime,
    entry1: signal.EntryLow,
    entry2: signal.EntryHigh,
    t1: signal.Target1,
    t2: signal.Target2,
  });

  return `/calc?${params.toString()}`;
}

function buildTradingViewSymbol(ticker, exchange) {
  // TradingView uses formats like NASDAQ-AAPL or NYSE-TSLA.
  // If you don’t have exchange, you can default or store it from your scanner.
  const ex = exchange || "NASDAQ";
  return `${ex}-${ticker}`;
}

function Card({ stock, outcomesMapRef  }) {

  const out = outcomesMapRef.current.get(stock.SignalId);
  const isNew = !!stock.NEW;

  const tvSymbol = buildTradingViewSymbol(stock.Ticker, stock.Exchange);
  const tradingViewNewsUrl = `https://www.tradingview.com/symbols/${tvSymbol}/news/`;
  const finvizUrl = `https://finviz.com/quote.ashx?t=${stock.Ticker}`;
  const yahooNewsUrl = `https://finance.yahoo.com/quote/${stock.Ticker}/news/`;
  const stocktwitsUrl = `https://stocktwits.com/symbol/${stock.Ticker}`;
  
  const defaultNewsUrl = finvizUrl;
  {/*
    onClick={() => window.open(defaultNewsUrl, "_blank")}
    style={{ cursor: "pointer" }}
    */}
  return (
    <div className={cx(styles.card, isNew && styles.cardNew)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && window.open(defaultNewsUrl, "_blank")}
    >
      <h3 style={{ marginTop: 0 }}>{stock.Ticker}</h3>
      {/*<div style={{ fontSize: 10, color: "#999" }}>
        <span className={styles.label}>id:</span>
        <span className={styles.value}>{stock.SignalId} | hasOut: {out ? "yes" : "no"}</span>
      </div>*/}
      <div className={styles.line}>
        <span className={styles.label}>Time: </span> 
        <span className={`${styles.value} ${styles.valuePrimary}`}>{currentTime}</span>
      </div> 
      <div className={styles.line}>
        <span className={styles.label}>Score: </span> 
        <span className={`${styles.value} ${styles.valuePrimary}`}>{stock.Score.toFixed(0)}</span>
      </div> 
      <div className={styles.line}>
        <span className={styles.label}>Momentum: </span>
        <span className={styles.value}>{stock.MomentumScore.toFixed(0)}</span>
      </div>
      <div className={styles.line}>
        <span className={styles.label}>Premarket: </span> 
        <span className={styles.value}>${stock.Premarket.toFixed(2)}</span>
        </div>
      <div className={styles.line}>
        <span className={styles.label}>Gap %: </span>  
        <span className={styles.value}>{stock["Gap %"]} ({stock["Gap Dir"]})</span> 
      </div>
      <div className={styles.line}>
        <span className={styles.label}>RelVol: </span>  
        <span className={styles.value}>{stock.RelVol}</span> 
      </div>
      <div className={styles.line}>
        <span className={styles.label}>ATR %: </span>  
        <span className={styles.value}>{stock["ATR %"]}</span> 
      </div>
      <div className={styles.line}>
        <span className={styles.label}>Entry: </span>  
        <span className={styles.value}><b>${stock.EntryLow.toFixed(2)} - ${stock.EntryHigh.toFixed(2)}</b></span> 
      </div>
      <div className={styles.line}>
        <span className={styles.label}>Stop: </span> 
        <span className={styles.value}><b>${stock.Stop.toFixed(2)}</b></span> 
      </div>
      <div className={styles.line}>
        <span className={styles.label}>Targets: </span> 
        <span className={styles.value}><b>${stock.Target1.toFixed(2)} / ${stock.Target2.toFixed(2)}</b></span> 
      </div>
      <div className={styles.line}>
        <span className={styles.label}>RR: </span>
        <span className={styles.value}>{stock.RR_T1} / {stock.RR_T2}</span>
      </div>
      <div className={styles.line}>
        <span className={styles.value}>{stock.Pattern}</span>
      </div>
      <div style={{ marginTop: 10 }}>
        <Link
          to={'https://robinhood.com/stocks/'+ stock.Ticker }
          className={`${styles.calcLink} ${styles.tooltip}`}
          target="_blank"
          rel="noopener noreferrer"
          data-tooltip="Chart: Robinhood"
        >
          📈 RH
        </Link>
        <Link
          to={stock.Chart}
          className={`${styles.calcLink} ${styles.tooltip}`}
          target="_blank"
          rel="noopener noreferrer"
          data-tooltip="Chart: Trading View"
        >
          📈 TV
        </Link>
      </div>
      <div style={{ marginTop: 15 }}>
        <Link
          to={tradingViewNewsUrl}
          className={`${styles.calcLink} ${styles.tooltip}`}
          target="_blank"
          rel="noopener noreferrer"
          data-tooltip="News: Trading View"
        >
          📰 TV
        </Link>

        <Link
          to={finvizUrl}
          className={`${styles.calcLink} ${styles.tooltip}`}
          target="_blank"
          rel="noopener noreferrer"
          data-tooltip="News: Finviz"
        >
          📰 FZ
        </Link>
        <Link
          to={yahooNewsUrl}
          className={`${styles.calcLink} ${styles.tooltip}`}
          target="_blank"
          rel="noopener noreferrer"
          data-tooltip="News: Yahoo"
        >
          📰 YH
        </Link>
        <Link
          to={stocktwitsUrl}
          className={`${styles.calcLink} ${styles.tooltip}`}
          target="_blank"
          rel="noopener noreferrer"
          data-tooltip="News: Stoack Witz"
        >
          📰 SW
        </Link>
      </div>
      
      <div style={{ marginTop: 15 }}> 
        <Link
          to={buildCalcUrl(stock)}
          className={styles.calcLink}
          rel="noopener noreferrer"
          data-tooltip="News: Stoack Witz"
        >
          📊 Calc
        </Link>
      </div>
    </div>
  );
}