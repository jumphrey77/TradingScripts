#!/usr/bin/env python3
"""
Bar-by-Bar SuperTrend Backtester
=================================
Replicates the Pine Script SuperTrend strategy logic on raw OHLCV data.
Supports v1 (baseline) and v2 (improved) strategy variants.

Timeframe: 5m
Assets: DOGE-USD, BTC-USD, ETH-USD, SOL-USD
"""

import sys, math
from pathlib import Path
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

# ─── PATHS ──────────────────────────────────────────────────────────────────
SCRIPT_DIR  = Path(__file__).resolve().parent
DATA_DIR    = SCRIPT_DIR / "testdata"
RESULTS_DIR = SCRIPT_DIR / "results"
RESULTS_DIR.mkdir(exist_ok=True)


# ─── INDICATOR FUNCTIONS ────────────────────────────────────────────────────
def calc_atr(high: np.ndarray, low: np.ndarray, close: np.ndarray, period: int) -> np.ndarray:
    """True Range → RMA (Wilder's smoothing), matching Pine's ta.atr()."""
    n = len(high)
    tr = np.empty(n)
    tr[0] = high[0] - low[0]
    for i in range(1, n):
        tr[i] = max(high[i] - low[i],
                     abs(high[i] - close[i - 1]),
                     abs(low[i] - close[i - 1]))
    # RMA (Wilder's) = EMA with alpha = 1/period
    atr = np.empty(n)
    atr[:period] = np.nan
    atr[period - 1] = np.mean(tr[:period])
    alpha = 1.0 / period
    for i in range(period, n):
        atr[i] = alpha * tr[i] + (1 - alpha) * atr[i - 1]
    return atr


def calc_supertrend(high: np.ndarray, low: np.ndarray, close: np.ndarray,
                    atr: np.ndarray, factor: float) -> tuple[np.ndarray, np.ndarray]:
    """Compute SuperTrend and direction arrays, matching Pine's ta.supertrend()."""
    n = len(close)
    supertrend = np.full(n, np.nan)
    direction  = np.ones(n)  # 1 = downtrend, -1 = uptrend

    upper_band = np.empty(n)
    lower_band = np.empty(n)

    for i in range(n):
        if np.isnan(atr[i]):
            upper_band[i] = np.nan
            lower_band[i] = np.nan
            continue

        hl2 = (high[i] + low[i]) / 2
        upper_band[i] = hl2 + factor * atr[i]
        lower_band[i] = hl2 - factor * atr[i]

        if i == 0:
            supertrend[i] = upper_band[i]
            direction[i] = 1
            continue

        # Carry forward bands
        if not np.isnan(lower_band[i - 1]):
            if lower_band[i] < lower_band[i - 1] and close[i - 1] > lower_band[i - 1]:
                lower_band[i] = lower_band[i - 1]
        if not np.isnan(upper_band[i - 1]):
            if upper_band[i] > upper_band[i - 1] and close[i - 1] < upper_band[i - 1]:
                upper_band[i] = upper_band[i - 1]

        # Direction logic
        prev_st = supertrend[i - 1] if not np.isnan(supertrend[i - 1]) else upper_band[i]
        if prev_st == upper_band[i - 1] if not np.isnan(upper_band[i - 1]) else True:
            # Was in downtrend
            if close[i] > upper_band[i]:
                direction[i] = -1
                supertrend[i] = lower_band[i]
            else:
                direction[i] = 1
                supertrend[i] = upper_band[i]
        else:
            # Was in uptrend
            if close[i] < lower_band[i]:
                direction[i] = 1
                supertrend[i] = upper_band[i]
            else:
                direction[i] = -1
                supertrend[i] = lower_band[i]

    return supertrend, direction


def calc_rsi(close: np.ndarray, period: int) -> np.ndarray:
    """RSI using RMA (Wilder's), matching Pine's ta.rsi()."""
    n = len(close)
    rsi = np.full(n, np.nan)
    delta = np.diff(close, prepend=close[0])

    gain = np.where(delta > 0, delta, 0.0)
    loss = np.where(delta < 0, -delta, 0.0)

    avg_gain = np.empty(n)
    avg_loss = np.empty(n)
    avg_gain[:period] = np.nan
    avg_loss[:period] = np.nan

    avg_gain[period] = np.mean(gain[1:period + 1])
    avg_loss[period] = np.mean(loss[1:period + 1])

    alpha = 1.0 / period
    for i in range(period + 1, n):
        avg_gain[i] = alpha * gain[i] + (1 - alpha) * avg_gain[i - 1]
        avg_loss[i] = alpha * loss[i] + (1 - alpha) * avg_loss[i - 1]

    for i in range(period, n):
        if avg_loss[i] == 0:
            rsi[i] = 100.0
        else:
            rs = avg_gain[i] / avg_loss[i]
            rsi[i] = 100.0 - 100.0 / (1.0 + rs)

    return rsi


def calc_adx(high: np.ndarray, low: np.ndarray, close: np.ndarray, period: int) -> np.ndarray:
    """ADX matching Pine's ta.dmi() / adx calculation."""
    n = len(close)
    adx = np.full(n, np.nan)

    up   = np.diff(high, prepend=high[0])
    down = -np.diff(low, prepend=low[0])

    plus_dm  = np.where((up > down) & (up > 0), up, 0.0)
    minus_dm = np.where((down > up) & (down > 0), down, 0.0)

    tr = np.empty(n)
    tr[0] = high[0] - low[0]
    for i in range(1, n):
        tr[i] = max(high[i] - low[i],
                     abs(high[i] - close[i - 1]),
                     abs(low[i] - close[i - 1]))

    # RMA smoothing
    alpha = 1.0 / period
    sm_tr = np.empty(n); sm_tr[:] = np.nan
    sm_pdm = np.empty(n); sm_pdm[:] = np.nan
    sm_mdm = np.empty(n); sm_mdm[:] = np.nan

    sm_tr[period - 1]  = np.sum(tr[:period])
    sm_pdm[period - 1] = np.sum(plus_dm[:period])
    sm_mdm[period - 1] = np.sum(minus_dm[:period])

    for i in range(period, n):
        sm_tr[i]  = sm_tr[i - 1]  - sm_tr[i - 1] / period + tr[i]
        sm_pdm[i] = sm_pdm[i - 1] - sm_pdm[i - 1] / period + plus_dm[i]
        sm_mdm[i] = sm_mdm[i - 1] - sm_mdm[i - 1] / period + minus_dm[i]

    plus_di  = np.where(sm_tr > 0, 100 * sm_pdm / sm_tr, 0)
    minus_di = np.where(sm_tr > 0, 100 * sm_mdm / sm_tr, 0)
    dx_sum = plus_di + minus_di
    dx = np.where(dx_sum > 0, 100 * np.abs(plus_di - minus_di) / dx_sum, 0)

    # Smooth DX with RMA to get ADX
    start = 2 * period - 1
    if start < n:
        adx[start] = np.mean(dx[period - 1:start + 1])
        for i in range(start + 1, n):
            adx[i] = alpha * dx[i] + (1 - alpha) * adx[i - 1]

    return adx


def calc_ema(data: np.ndarray, period: int) -> np.ndarray:
    """EMA matching Pine's ta.ema()."""
    n = len(data)
    ema = np.full(n, np.nan)
    ema[period - 1] = np.mean(data[:period])
    alpha = 2.0 / (period + 1)
    for i in range(period, n):
        ema[i] = alpha * data[i] + (1 - alpha) * ema[i - 1]
    return ema


def calc_sma(data: np.ndarray, period: int) -> np.ndarray:
    """Simple moving average."""
    sma = np.full(len(data), np.nan)
    for i in range(period - 1, len(data)):
        sma[i] = np.mean(data[i - period + 1:i + 1])
    return sma


# ─── STRATEGY CONFIGS ───────────────────────────────────────────────────────
@dataclass
class StrategyConfig:
    name: str
    timeframe: str = "5m"
    # SuperTrend
    atr_period: int = 10
    factor: float = 3.0
    # RSI exit
    use_rsi_exit: bool = True
    rsi_length: int = 14
    rsi_overbought: int = 80
    # Stop loss
    use_stop: bool = True
    sl_atr_mult: float = 1.5
    use_hard_stop: bool = False
    hard_stop_pct: float = 8.0
    trailing_stop: bool = False
    # ADX filter
    use_adx: bool = False
    adx_length: int = 14
    adx_threshold: int = 20
    # EMA filter
    use_ema: bool = False
    ema_length: int = 50
    # Volume filter
    use_vol_filter: bool = False
    vol_ma_length: int = 20
    vol_multiplier: float = 0.8
    # Cooldown
    use_cooldown: bool = False
    cooldown_bars: int = 6
    # Min hold
    min_hold_bars: int = 0
    # Capital
    initial_capital: float = 1000.0
    equity_pct: float = 100.0
    commission_pct: float = 0.1
    slippage_pct: float = 0.02  # approximate slippage as %


STRATEGIES = {
    "supertrend_v1": StrategyConfig(
        name="supertrend_v1",
        atr_period=10, factor=3.0,
        use_rsi_exit=True, rsi_overbought=80,
        use_stop=True, sl_atr_mult=1.5, trailing_stop=False,
        use_adx=False, use_ema=False, use_vol_filter=False, use_cooldown=False,
    ),
    "supertrend_v2": StrategyConfig(
        name="supertrend_v2",
        atr_period=10, factor=3.0,
        use_rsi_exit=True, rsi_overbought=75,
        use_stop=True, sl_atr_mult=2.0, trailing_stop=True,
        use_hard_stop=True, hard_stop_pct=5.0,
        use_adx=True, adx_length=14, adx_threshold=20,
        use_ema=True, ema_length=50,
        use_vol_filter=True, vol_ma_length=20, vol_multiplier=0.8,
        use_cooldown=True, cooldown_bars=6,
    ),
    # V3: Much higher SuperTrend factor to reduce whipsaws, strict ADX, long EMA
    "supertrend_v3_strict": StrategyConfig(
        name="supertrend_v3_strict",
        atr_period=14, factor=5.0,
        use_rsi_exit=True, rsi_overbought=70,
        use_stop=True, sl_atr_mult=3.0, trailing_stop=True,
        use_hard_stop=True, hard_stop_pct=8.0,
        use_adx=True, adx_length=14, adx_threshold=30,
        use_ema=True, ema_length=100,
        use_vol_filter=True, vol_ma_length=20, vol_multiplier=1.0,
        use_cooldown=True, cooldown_bars=12,
        min_hold_bars=6,
    ),
    # V4: Wide SuperTrend, EMA 200 trend filter, no stop (ride the trend)
    "supertrend_v4_trend": StrategyConfig(
        name="supertrend_v4_trend",
        atr_period=14, factor=4.0,
        use_rsi_exit=False,
        use_stop=False,
        use_adx=True, adx_length=14, adx_threshold=25,
        use_ema=True, ema_length=200,
        use_vol_filter=False,
        use_cooldown=False,
        min_hold_bars=12,
    ),
    # V5: Conservative — small position, tight trailing, high ADX, EMA 100
    "supertrend_v5_conservative": StrategyConfig(
        name="supertrend_v5_conservative",
        atr_period=10, factor=4.0,
        use_rsi_exit=True, rsi_overbought=75,
        use_stop=True, sl_atr_mult=2.5, trailing_stop=True,
        use_hard_stop=True, hard_stop_pct=6.0,
        use_adx=True, adx_length=14, adx_threshold=25,
        use_ema=True, ema_length=100,
        use_vol_filter=True, vol_ma_length=20, vol_multiplier=1.0,
        use_cooldown=True, cooldown_bars=12,
        min_hold_bars=6,
        equity_pct=50.0,
    ),
}


# ─── BACKTESTER ─────────────────────────────────────────────────────────────
@dataclass
class Trade:
    entry_bar: int
    entry_price: float
    entry_time: object
    exit_bar: int = 0
    exit_price: float = 0.0
    exit_time: object = None
    exit_signal: str = ""
    qty: float = 0.0
    pnl: float = 0.0
    pnl_pct: float = 0.0
    max_fav: float = 0.0
    max_adv: float = 0.0


def run_backtest(df: pd.DataFrame, cfg: StrategyConfig) -> tuple[list[Trade], pd.Series]:
    """Run the SuperTrend strategy bar-by-bar on OHLCV data."""
    o = df["open"].values
    h = df["high"].values
    l = df["low"].values
    c = df["close"].values
    v = df["volume"].values
    dt = df["datetime"].values
    n = len(c)

    # Pre-compute indicators
    atr = calc_atr(h, l, c, cfg.atr_period)
    supertrend, direction = calc_supertrend(h, l, c, atr, cfg.factor)
    rsi = calc_rsi(c, cfg.rsi_length)

    adx = calc_adx(h, l, c, cfg.adx_length) if cfg.use_adx else np.zeros(n)
    ema = calc_ema(c, cfg.ema_length) if cfg.use_ema else np.zeros(n)
    vol_ma = calc_sma(v, cfg.vol_ma_length) if cfg.use_vol_filter else np.zeros(n)

    # State
    trades: list[Trade] = []
    equity = cfg.initial_capital
    equity_curve = np.full(n, cfg.initial_capital)
    position_size = 0.0  # qty
    entry_price = 0.0
    stop_level = np.nan
    rsi_triggered = False
    bars_since_stop = 999
    in_position = False
    current_trade: Trade | None = None
    entry_bar_idx = 0

    warmup = max(cfg.atr_period, cfg.rsi_length, cfg.ema_length,
                 cfg.adx_length, cfg.vol_ma_length) + 10

    for i in range(1, n):
        equity_curve[i] = equity

        if i < warmup:
            continue

        # ── Direction flip detection ──
        go_long = direction[i - 1] > 0 and direction[i] < 0  # flip to uptrend
        go_flat = direction[i - 1] < 0 and direction[i] > 0  # flip to downtrend

        bars_since_stop += 1

        # ── Exit logic ──
        if in_position:
            exit_price = 0.0
            exit_signal = ""
            bars_held = i - entry_bar_idx

            # Check stop loss (using low of bar) — always active regardless of min_hold
            if cfg.use_stop and not np.isnan(stop_level) and l[i] <= stop_level:
                exit_price = stop_level  # filled at stop level
                exit_signal = "ATR Stop" if not cfg.trailing_stop else "Trail Stop"
                bars_since_stop = 0

            # Check RSI exit
            elif cfg.use_rsi_exit and not rsi_triggered and not np.isnan(rsi[i]):
                if rsi[i] >= cfg.rsi_overbought:
                    rsi_triggered = True

            if cfg.use_rsi_exit and rsi_triggered and in_position and not exit_signal:
                if bars_held >= cfg.min_hold_bars:
                    exit_price = c[i]
                    exit_signal = "RSI Exit"

            # Check SuperTrend flip exit (respect min hold)
            if go_flat and not exit_signal and bars_held >= cfg.min_hold_bars:
                exit_price = c[i]
                exit_signal = "ST Flip"

            # Execute exit
            if exit_signal and exit_price > 0:
                commission = position_size * exit_price * cfg.commission_pct / 100
                slippage = position_size * exit_price * cfg.slippage_pct / 100
                gross_pnl = position_size * (exit_price - entry_price)
                net_pnl = gross_pnl - commission - slippage

                equity += net_pnl

                if current_trade:
                    current_trade.exit_bar = i
                    current_trade.exit_price = exit_price
                    current_trade.exit_time = dt[i]
                    current_trade.exit_signal = exit_signal
                    current_trade.pnl = net_pnl
                    current_trade.pnl_pct = (net_pnl / (position_size * entry_price)) * 100
                    trades.append(current_trade)

                in_position = False
                position_size = 0.0
                stop_level = np.nan
                rsi_triggered = False
                current_trade = None

            # Trail stop up
            elif cfg.trailing_stop and in_position and cfg.use_stop:
                new_trail = c[i] - atr[i] * cfg.sl_atr_mult
                if not np.isnan(stop_level) and new_trail > stop_level:
                    stop_level = new_trail

            # Track excursions
            if in_position and current_trade:
                unrealized_pct = (c[i] - entry_price) / entry_price * 100
                current_trade.max_fav = max(current_trade.max_fav, unrealized_pct)
                current_trade.max_adv = min(current_trade.max_adv, unrealized_pct)

        # ── Entry logic ──
        if go_long and not in_position:
            # Apply filters
            if cfg.use_adx and (np.isnan(adx[i]) or adx[i] < cfg.adx_threshold):
                equity_curve[i] = equity
                continue
            if cfg.use_ema and (np.isnan(ema[i]) or c[i] <= ema[i]):
                equity_curve[i] = equity
                continue
            if cfg.use_vol_filter and (np.isnan(vol_ma[i]) or v[i] <= vol_ma[i] * cfg.vol_multiplier):
                equity_curve[i] = equity
                continue
            if cfg.use_cooldown and bars_since_stop <= cfg.cooldown_bars:
                equity_curve[i] = equity
                continue

            # Enter
            entry_price = c[i]
            alloc = equity * cfg.equity_pct / 100
            commission = alloc * cfg.commission_pct / 100
            position_size = (alloc - commission) / entry_price

            # Set stop
            if cfg.use_stop and not np.isnan(atr[i]):
                atr_stop = entry_price - atr[i] * cfg.sl_atr_mult
                if cfg.use_hard_stop:
                    hard_stop = entry_price * (1 - cfg.hard_stop_pct / 100)
                    stop_level = max(atr_stop, hard_stop)
                else:
                    stop_level = atr_stop
            else:
                stop_level = np.nan

            in_position = True
            rsi_triggered = False
            entry_bar_idx = i
            current_trade = Trade(
                entry_bar=i, entry_price=entry_price, entry_time=dt[i],
                qty=position_size,
            )

        equity_curve[i] = equity + (position_size * (c[i] - entry_price) if in_position else 0)

    # Close any open position at end
    if in_position and current_trade:
        exit_price = c[-1]
        commission = position_size * exit_price * cfg.commission_pct / 100
        gross_pnl = position_size * (exit_price - entry_price)
        net_pnl = gross_pnl - commission
        equity += net_pnl
        current_trade.exit_bar = n - 1
        current_trade.exit_price = exit_price
        current_trade.exit_time = dt[-1]
        current_trade.exit_signal = "End"
        current_trade.pnl = net_pnl
        current_trade.pnl_pct = (net_pnl / (position_size * entry_price)) * 100
        trades.append(current_trade)

    return trades, pd.Series(equity_curve, index=df.index)


# ─── METRICS ────────────────────────────────────────────────────────────────
def compute_metrics(trades: list[Trade], equity_curve: pd.Series,
                    cfg: StrategyConfig, data_days: float) -> dict:
    if not trades:
        return {"strategy": cfg.name, "total_trades": 0}

    pnls = np.array([t.pnl for t in trades])
    pnl_pcts = np.array([t.pnl_pct for t in trades])
    winners = pnls[pnls > 0]
    losers = pnls[pnls <= 0]

    total_pnl = pnls.sum()
    gross_profit = winners.sum() if len(winners) > 0 else 0
    gross_loss = abs(losers.sum()) if len(losers) > 0 else 0.001
    win_rate = len(winners) / len(pnls)

    # Equity curve drawdown
    peak = equity_curve.cummax()
    dd = equity_curve - peak
    max_dd = dd.min()
    max_dd_pct = (dd / peak).min() * 100

    # Ratios
    profit_factor = gross_profit / gross_loss if gross_loss > 0 else float('inf')
    avg_win = winners.mean() if len(winners) > 0 else 0
    avg_loss = losers.mean() if len(losers) > 0 else 0
    payoff = abs(avg_win / avg_loss) if avg_loss != 0 else 0
    expectancy = (win_rate * avg_win) + ((1 - win_rate) * avg_loss)

    # Annualized metrics
    annual_return = (total_pnl / cfg.initial_capital) * (365 / max(data_days, 1)) * 100
    calmar = annual_return / abs(max_dd_pct) if max_dd_pct != 0 else 0

    # Sharpe (trade-level)
    trades_per_year = len(trades) / max(data_days, 1) * 365
    avg_ret = pnl_pcts.mean() / 100
    std_ret = pnl_pcts.std(ddof=1) / 100 if len(pnl_pcts) > 1 else 0.001
    sharpe = (avg_ret / std_ret) * math.sqrt(trades_per_year) if std_ret > 0 else 0

    # Consecutive
    is_w = pnls > 0
    max_cw = max_cl = cw = cl = 0
    for w in is_w:
        if w:
            cw += 1; cl = 0; max_cw = max(max_cw, cw)
        else:
            cl += 1; cw = 0; max_cl = max(max_cl, cl)

    # Durations
    durations = []
    for t in trades:
        if t.entry_time is not None and t.exit_time is not None:
            dur = (pd.Timestamp(t.exit_time) - pd.Timestamp(t.entry_time)).total_seconds() / 60
            durations.append(dur)

    return {
        "strategy":          cfg.name,
        "timeframe":         cfg.timeframe,
        "total_trades":      len(trades),
        "winners":           len(winners),
        "losers":            len(losers),
        "win_rate_pct":      round(win_rate * 100, 2),
        "net_profit_usd":    round(total_pnl, 2),
        "net_profit_pct":    round(total_pnl / cfg.initial_capital * 100, 2),
        "gross_profit":      round(gross_profit, 2),
        "gross_loss":        round(-abs(gross_loss), 2),
        "profit_factor":     round(profit_factor, 4),
        "max_drawdown_usd":  round(max_dd, 2),
        "max_drawdown_pct":  round(max_dd_pct, 2),
        "avg_trade_pnl":     round(pnls.mean(), 4),
        "avg_win_usd":       round(avg_win, 4),
        "avg_loss_usd":      round(avg_loss, 4),
        "payoff_ratio":      round(payoff, 4),
        "expectancy_usd":    round(expectancy, 4),
        "max_consec_wins":   max_cw,
        "max_consec_losses": max_cl,
        "sharpe_ratio":      round(sharpe, 4),
        "calmar_ratio":      round(calmar, 4),
        "avg_duration_min":  round(np.mean(durations), 1) if durations else 0,
        "initial_capital":   cfg.initial_capital,
        "final_equity":      round(equity_curve.iloc[-1], 2),
        "data_days":         round(data_days, 1),
        "trades_per_day":    round(len(trades) / max(data_days, 1), 2),
        "annual_return_pct": round(annual_return, 2),
    }


# ─── SCORING (same 3-pillar system) ────────────────────────────────────────
def compute_score(m: dict) -> dict:
    ar = m.get("annual_return_pct", 0)
    calmar = m.get("calmar_ratio", 0)
    dd = m.get("max_drawdown_pct", -50)

    r1 = max(0, min(100, ar))                                  # Reward
    r2 = max(0, min(100, calmar / 3.0 * 100))                  # Risk-adjusted
    r3 = max(0, min(100, (50 - abs(dd)) / 48 * 100)) if abs(dd) < 50 else 0  # Risk control

    return {
        "reward_score":    round(r1, 2),
        "risk_adj_score":  round(r2, 2),
        "risk_ctrl_score": round(r3, 2),
        "composite_score": round((r1 + r2 + r3) / 3, 2),
    }


# ─── IN-SAMPLE / OUT-OF-SAMPLE SPLIT ───────────────────────────────────────
def split_data(df: pd.DataFrame, train_pct: float = 0.7) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Split data into in-sample (training) and out-of-sample (test)."""
    split_idx = int(len(df) * train_pct)
    return df.iloc[:split_idx].copy(), df.iloc[split_idx:].copy()


# ─── MAIN ───────────────────────────────────────────────────────────────────
def main():
    ohlcv_files = sorted(DATA_DIR.glob("*_5m_ohlcv.csv"))
    if not ohlcv_files:
        print("ERROR: No OHLCV files found in", DATA_DIR)
        sys.exit(1)

    print(f"Found {len(ohlcv_files)} OHLCV files")
    print(f"Strategies: {list(STRATEGIES.keys())}")

    all_results = []

    for strat_name, cfg in STRATEGIES.items():
        print(f"\n{'='*70}")
        print(f"  STRATEGY: {strat_name}")
        print(f"{'='*70}")

        for ohlcv_path in ohlcv_files:
            asset = ohlcv_path.stem.replace("_5m_ohlcv", "")
            print(f"\n  ── {asset} ──")

            df = pd.read_csv(ohlcv_path)
            df["datetime"] = pd.to_datetime(df["datetime"], errors="coerce", utc=True)
            df = df.dropna(subset=["datetime"]).reset_index(drop=True)
            data_days = (df["datetime"].iloc[-1] - df["datetime"].iloc[0]).total_seconds() / 86400

            # Full dataset backtest
            trades, eq = run_backtest(df, cfg)
            m = compute_metrics(trades, eq, cfg, data_days)
            m["asset"] = asset
            scores = compute_score(m)
            m.update(scores)
            m["sample"] = "full"

            print(f"    FULL: {m['total_trades']} trades, "
                  f"Win Rate: {m['win_rate_pct']}%, "
                  f"Net P&L: ${m['net_profit_usd']} ({m['net_profit_pct']}%), "
                  f"Max DD: {m['max_drawdown_pct']}%, "
                  f"PF: {m['profit_factor']}, "
                  f"Score: {m['composite_score']}")

            all_results.append(m)

            # In-sample / out-of-sample
            train_df, test_df = split_data(df, train_pct=0.7)
            for label, subset in [("in_sample", train_df), ("out_of_sample", test_df)]:
                sub_days = (subset["datetime"].iloc[-1] - subset["datetime"].iloc[0]).total_seconds() / 86400
                t, eq_sub = run_backtest(subset.reset_index(drop=True), cfg)
                sm = compute_metrics(t, eq_sub, cfg, sub_days)
                sm["asset"] = asset
                sm["sample"] = label
                sc = compute_score(sm)
                sm.update(sc)
                all_results.append(sm)

                print(f"    {label.upper():15s}: {sm['total_trades']} trades, "
                      f"Net P&L: {sm['net_profit_pct']}%, "
                      f"Max DD: {sm['max_drawdown_pct']}%, "
                      f"Score: {sm['composite_score']}")

    # ── Build output ──
    df_results = pd.DataFrame(all_results)

    # Aggregate by strategy (full sample only)
    full = df_results[df_results["sample"] == "full"]
    ranking = full.groupby("strategy").agg(
        total_trades=("total_trades", "sum"),
        avg_net_profit_pct=("net_profit_pct", "mean"),
        avg_max_drawdown_pct=("max_drawdown_pct", "mean"),
        avg_win_rate=("win_rate_pct", "mean"),
        avg_profit_factor=("profit_factor", "mean"),
        avg_sharpe=("sharpe_ratio", "mean"),
        avg_calmar=("calmar_ratio", "mean"),
        avg_reward_score=("reward_score", "mean"),
        avg_risk_adj_score=("risk_adj_score", "mean"),
        avg_risk_ctrl_score=("risk_ctrl_score", "mean"),
        avg_composite_score=("composite_score", "mean"),
        num_assets=("asset", "count"),
    ).reset_index().sort_values("avg_composite_score", ascending=False)
    ranking.index = range(1, len(ranking) + 1)
    ranking.index.name = "rank"

    # OOS aggregate
    oos = df_results[df_results["sample"] == "out_of_sample"]
    oos_ranking = oos.groupby("strategy").agg(
        oos_avg_net_pct=("net_profit_pct", "mean"),
        oos_avg_dd_pct=("max_drawdown_pct", "mean"),
        oos_avg_score=("composite_score", "mean"),
    ).reset_index().sort_values("oos_avg_score", ascending=False)

    print(f"\n\n{'#'*70}")
    print(f"  FINAL RANKING (Full Dataset, Averaged Across {len(ohlcv_files)} Assets)")
    print(f"{'#'*70}")
    for _, row in ranking.iterrows():
        print(f"\n  #{row.name}: {row['strategy']}")
        print(f"    Avg Net P&L:    {row['avg_net_profit_pct']:.2f}%")
        print(f"    Avg Max DD:     {row['avg_max_drawdown_pct']:.2f}%")
        print(f"    Avg Win Rate:   {row['avg_win_rate']:.2f}%")
        print(f"    Avg PF:         {row['avg_profit_factor']:.4f}")
        print(f"    COMPOSITE:      {row['avg_composite_score']:.2f}")

    print(f"\n  OUT-OF-SAMPLE VALIDATION:")
    for _, row in oos_ranking.iterrows():
        print(f"    {row['strategy']:30s}  OOS P&L: {row['oos_avg_net_pct']:.2f}%  "
              f"OOS DD: {row['oos_avg_dd_pct']:.2f}%  OOS Score: {row['oos_avg_score']:.2f}")

    # ── Save XLSX ──
    xlsx_path = SCRIPT_DIR / "strategy_rankings.xlsx"
    with pd.ExcelWriter(xlsx_path, engine="openpyxl") as writer:
        ranking.to_excel(writer, sheet_name="Rankings", index=True)
        df_results.to_excel(writer, sheet_name="All Results", index=False)
        oos_ranking.to_excel(writer, sheet_name="OOS Validation", index=False)

        methodology = pd.DataFrame({
            "Pillar": ["Reward (33.3%)", "Risk-Adjusted Return (33.3%)", "Risk Control (33.3%)"],
            "Metric": ["Annualized Net Profit %", "Calmar Ratio", "Max Drawdown % (inverted)"],
            "Scale": ["0% → 0, 100%+ → 100", "Calmar ≤ 0 → 0, ≥ 3 → 100", "DD ≥ 50% → 0, DD ≤ 2% → 100"],
        })
        methodology.to_excel(writer, sheet_name="Scoring Methodology", index=False)

    print(f"\n  XLSX saved: {xlsx_path}")


if __name__ == "__main__":
    main()
