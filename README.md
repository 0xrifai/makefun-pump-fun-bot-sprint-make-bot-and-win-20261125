# Loose-Trail Breakout Sniper

[![make.fun](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/0xrifai/makefun-pump-fun-bot-sprint-make-bot-and-win-20261125/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/0xrifai/makefun-pump-fun-bot-sprint-make-bot-and-win-20261125/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A pump.fun replay bot for the [make.fun "Pump.fun Bot Sprint: Make Bot And Win" bounty](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed). It trades paper money on a replay of pump.fun chain data (harness `agent-fun/replay/v2`, template `pumpfun-replay`), starting from 10 SOL, at most 5 open positions, latency 2 slots.

## Strategy

**Entry — decided once per coin, within 4 slots of its CreateEvent.** A coin is bought only when the earliest crowd already looks real:

- Real SOL reserve between 0.3 and 10 SOL.
- The creator has not sold, and the creator's own early buys total at most 0.5 SOL.
- At least 5 distinct non-creator buyers, who together bought at least 0.8 SOL.
- Non-creator sells at most 20% of non-creator buys.
- Price run-up from the creation price between +1% and +40% — momentum, not a parabola.

One fixed stake of 0.05 SOL per coin (capped by the harness's 1%-of-real-reserve order limit, never below a 0.005 SOL minimum buy). Never adds to a position, never averages down, never re-enters a coin.

**Exits — checked every batch for every held position.** A position's value is the net SOL its tokens would fetch against the current (virtual quote, virtual token) reserves, less 125 bps of curve fees (95 bps protocol + 30 bps creator fallback) and less the 105,000-lamport transaction fee (5,000 base + 100,000 priority):

- **Take-profit 1:** once the position is worth +5% over its cost, sell half the tokens.
- **Trailing stop:** once up +10% over cost the trail arms; exit the rest if value falls 30% from its best print.
- **Hard stop:** sell all at −25% of cost, tightened to −5% once half the position is banked.
- **Max hold:** 100 slots from the buy decision.
- **Stale:** no trade on the curve for 40 slots.
- **Creator sells** while we hold: exit at once.

A completed curve is closed by the harness itself.

## Determinism

The bot is a pure function of the hello message and the batch stream: no clock, no randomness, no I/O, no environment reads. Map iteration is in insertion order. The bot writes no files at all — its only output is its orders.

## Dev-window validation

Graded locally with the kit on the published frozen 24-hour dev window (dataset sha256 `b661ceee26070f1f07eced009b43dda699e1e96d40a6724c7e72273b1e3715a9`):

- Dev net PnL: **+0.0187 SOL**
- Fills: **80** across **32 coins**
- Max drawdown: **0.4%**
- Sharpe: **+0.092**

The positive region is a broad plateau: trail 3000–5000 bps combined with stop 2000–3000 bps all score positive on the dev window, so the result does not hinge on a single tuned parameter.

## Files

- `main.ts` — the bot. Runs as `node /bot/main.ts` (Node 22 strips the types; no build, no install).
- `vendor/makefun-bot.ts` — the kit's SDK shim, copied byte-for-byte, unedited.

## Reproduce the grade

From the kit directory:

```sh
node cli/makefun.mjs grade-local --kit . --bot <path-to-this-repo> --driver process --json
```
