# 1️⃣ Directory Structure (Recommended)

```javascript
momentum_trader/
├─ fetchers/
│   ├─ finviz.py
│   └─ yahoo.py
├─ features/          DONE
│   └─ intraday.py    DONE 
├─ patterns/
│   └─ breakout.py
├─ trade_plan.py      DONE
├─ scoring.py
├─ output.py
├─ signals.py         DONE # main orchestrator
└─ data               DONE      
    ├─ scans          DONE
    └─ signals        DONE
```


📊 Rough intuition (sanity check)
Gap %	RelVol	ATR %	Score (approx)
10	2	8	\~45
25	4	15	\~120
50	6	20	\~230
100	10	30	\~380
200	20	40	\~500 (cap)