1️⃣ Core Finviz Filters (use these by default)

These are the **non-negotiables** for your strategy.

🟢 Price

```javascript
Price: $0.75 – $20
```

**Why**

* Below $0.75 → liquidity + dilution risk
* Above $20 → slower % moves, harder stops
* This matches your ATR% + RR logic perfectly


---

🟢 Average Volume

```javascript
Average Volume: Over 500K
```

(or Over 1M if you want cleaner names)

**Why**

* Ensures **fills + spreads**
* RelVol only matters if baseline volume exists
* Prevents “fake gappers” on thin volume


---

🟢 Relative Volume

```javascript
Relative Volume: Over 2
```

(Over 3 is even better on slow days)

**Why**

* Confirms **participation**
* This is the single most important momentum confirmation
* You already weight this heavily in scoring (correctly)


---

🟢 Gap

```javascript
Gap: Up Over 5%
```

(You can raise to 10% on busy days)

**Why**

* Ensures a **catalyst exists**
* Below 5% → usually noise, not urgency


---

🟢 News

```javascript
News: Today / Since Yesterday
```

**Why**

* This is the *why* behind the move
* Without news, most gappers fade or chop
* This aligns perfectly with your outcome tracking


---

2️⃣ Optional Tightening Filters (use only if list is too big)

These are **situational**, not always-on.

🟡 Float

```javascript
Float: Under 50M
```

(or Under 100M if too restrictive)

**Why**

* Lower float = faster momentum
* Too low (<5M) increases halt risk → don’t go extreme


---

🟡 ATR %

```javascript
ATR %: Over 8%
```

(You already calculate this)

**Why**

* Confirms *tradability*
* Prevents tight-range gappers that don’t follow through


---

🟡 Sector (optional)

```javascript
Exclude: Financials, Utilities
```

**Why**

* These move slower, even on news
* Not required, but helps on noisy days


---

3️⃣ What NOT to filter (very important)

❌ **Market Cap** \n → misleading for momentum

❌ **P/E, EPS, Fundamentals** \n → irrelevant for short-term news trades

❌ **RSI / Technical Indicators** \n → your ATR + gap + volume already capture this better

❌ **Too-tight float filters (<10M)** \n → halt city, bad fills

Let your **score + outcomes engine** decide what’s best — not Finviz.


---

4️⃣ The “Final” Finviz Preset (copy this mentally)

**Baseline preset**

```javascript
Price: 0.75 – 20
Avg Volume: Over 500K
Relative Volume: Over 2
Gap: Up Over 5%
News: Today / Since Yesterday
```

**Tight preset (busy days)**

```javascript
Price: 1 – 15
Avg Volume: Over 1M
Relative Volume: Over 3
Gap: Up Over 10%
Float: Under 50M
News: Today
```


---

## 5️⃣ Why this works WITH your system (key insight)

Finviz’s job is now **only** to:

> “Bring you candidates that *might* matter”

Your system’s job is to:

* score urgency
* generate entries/stops/targets
* track outcomes
* alert you **when action actually happens**

That’s the edge. \n You’re no longer asking Finviz *what to trade* — you’re asking it *what to watch*.