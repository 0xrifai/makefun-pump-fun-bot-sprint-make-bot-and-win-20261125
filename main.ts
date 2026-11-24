// Loose-Trail Breakout Sniper — a pump.fun replay bot for the make.fun
// "Pump.fun Bot Sprint: Make Bot And Win" bounty.
//
// The idea in one paragraph: only buy a coin in its first few slots of life,
// and only when the earliest crowd already looks real — several distinct
// buyers putting in real SOL, the creator staying off the sell side and not
// loading up themselves, and the price already running up a little but not
// parabolic. One fixed stake per coin, never averaged down. After that the
// bot is a risk manager, not a predictor: bank half at +5%, arm a trailing
// stop at +10% that gives back 30% from the best print, cut the whole thing
// at -25% (tightened to -5% once half is banked), and get out after 100
// slots, after 40 slots without a trade, or the moment the creator sells
// while we hold.
//
// Everything below is a pure function of the hello message and the batch
// stream: no clock, no randomness, no I/O, no environment reads. Map
// iteration is in insertion order, so two runs agree byte for byte.
//
// The bot writes no files at all. Its only output is its orders.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type ChainEvent,
  type OrderInput,
} from './vendor/makefun-bot.ts';

// ------------------------------------------------------------------ tuning

/** Fixed stake per coin: 0.05 SOL. */
const STAKE_LAMPORTS = LAMPORTS_PER_SOL / 20n;
/** Smallest buy worth sending: 0.005 SOL. */
const MIN_BUY_LAMPORTS = LAMPORTS_PER_SOL / 200n;
/** Entry is decided once per coin, within this many slots of its CreateEvent. */
const ENTRY_WINDOW_SLOTS = 4;
/** Real SOL reserve at entry must sit between 0.3 and 10 SOL. */
const RESERVE_MIN_LAMPORTS = (LAMPORTS_PER_SOL * 3n) / 10n;
const RESERVE_MAX_LAMPORTS = LAMPORTS_PER_SOL * 10n;
/** The creator's own early buys must total no more than 0.5 SOL. */
const CREATOR_MAX_OPEN_BUY_LAMPORTS = LAMPORTS_PER_SOL / 2n;
/** At least this many distinct non-creator buyers before entry. */
const MIN_DISTINCT_BUYERS = 5;
/** Non-creator buys must total at least 0.8 SOL before entry. */
const MIN_OTHERS_BUY_LAMPORTS = (LAMPORTS_PER_SOL * 8n) / 10n;
/** Non-creator sells must stay at or under 20% of non-creator buys. */
const MAX_OTHERS_SELL_BPS = 2000n;
/** Price run-up from the creation price must sit between +1% and +40%. */
const RUN_UP_MIN_BPS = 100n;
const RUN_UP_MAX_BPS = 4000n;
/** Take-profit 1: at +5% of cost, sell half the tokens. */
const TP1_BPS = 500n;
const TP1_PART_BPS = 5000n;
/** Trailing stop: arms at +10% of cost, exits on a 30% fall from the best print. */
const TRAIL_ARM_BPS = 1000n;
const TRAIL_BPS = 3000n;
/** Hard stop: -25% of cost, tightened to -5% once half the position is banked. */
const STOP_BPS = 2500n;
const STOP_AFTER_TP1_BPS = 500n;
/** Longest hold, in slots from the buy decision. */
const MAX_HOLD_SLOTS = 100;
/** Exit when no trade has touched the curve for this many slots. */
const STALE_SLOTS = 40;
/** Curve fees on a sell: protocol 95 bps + creator 30 bps fallback. */
const CURVE_FEE_BPS = 125n;
/** Slippage left wide open so a fill is never refused for the price moving
 *  across the 2-slot latency; exits are about getting out, not the exact print. */
const MAX_SLIPPAGE_BPS = 10_000;

// ------------------------------------------------------------------ per-coin flow

/** Everything the entry filters need about one coin, folded from its events. */
interface CoinFlow {
  creator: string;
  /** Creation price, as the virtual reserves of the CreateEvent. */
  createVq: bigint;
  createVt: bigint;
  /** SOL the creator has bought themselves since creation. */
  creatorBuySol: bigint;
  /** True once any sell by the creator is seen. */
  creatorSold: boolean;
  /** Distinct non-creator buyers. */
  buyers: Set<string>;
  /** SOL bought by everyone except the creator. */
  othersBuySol: bigint;
  /** SOL sold by everyone except the creator. */
  othersSellSol: bigint;
}

/** Live state of one held position, kept beside the harness's own account. */
interface HeldCoin {
  /** Slot the buy was decided on (fills land 2 slots later). */
  entrySlot: number;
  /** Best value/cost ratio seen, in bps (value * 10000 / cost). */
  bestRatioBps: bigint;
  /** True once the position has printed +10% over cost. */
  armed: boolean;
  /** Take-profit 1: not sent, in flight, or confirmed filled. */
  tp1: 'none' | 'pending' | 'done';
}

// ------------------------------------------------------------------ run state

/** Flow stats by mint, in first-seen order. */
const flows = new Map<string, CoinFlow>();
/** Coins created and not yet decided, in creation order: the entry window
 *  is only 4 slots, so this set stays tiny and the entry scan stays cheap. */
const candidates = new Set<string>();
/** Coins whose entry decision is made: bought, or passed for good. */
const decided = new Set<string>();
/** Held positions, keyed by mint. */
const held = new Map<string, HeldCoin>();
/** Slot a buy was decided on, by mint, until its position shows up. */
const pendingBuySlot = new Map<string, number>();
/** Sells in flight, by client id: their mint and whether they are the
 *  take-profit-1 half-sell or a full exit. */
const pendingSells = new Map<string, { mint: string; kind: 'tp1' | 'exit' }>();

// ------------------------------------------------------------------ pricing

/**
 * Net SOL received for selling `tokens` against the curve's current
 * (virtual quote, virtual token) reserves: constant-product output, less
 * 125 bps of curve fees, less the transaction fee. Clamped at zero: a
 * sale that would not even cover its own transaction fee is never sent.
 */
function sellValue(state: BotState, mint: string, tokens: bigint): bigint {
  const curve = state.curves.get(mint);
  if (curve === undefined || tokens <= 0n) return 0n;
  const vq = curve.virtual_quote_reserves;
  const vt = curve.virtual_token_reserves;
  if (vq <= 0n || vt <= 0n) return 0n;
  const out = (vq * tokens) / (vt + tokens);
  const afterFees = (out * (10_000n - CURVE_FEE_BPS)) / 10_000n;
  const net = afterFees - state.txFeeLamports();
  return net > 0n ? net : 0n;
}

/** Value/cost of a whole position, in bps, from its net sell value. */
function positionRatioBps(state: BotState, mint: string, tokens: bigint, cost: bigint): bigint {
  if (cost <= 0n) return 0n;
  return (sellValue(state, mint, tokens) * 10_000n) / cost;
}

// ------------------------------------------------------------------ event folding

function freshFlow(creator: string): CoinFlow {
  return {
    creator,
    createVq: 0n,
    createVt: 0n,
    creatorBuySol: 0n,
    creatorSold: false,
    buyers: new Set<string>(),
    othersBuySol: 0n,
    othersSellSol: 0n,
  };
}

/** Fold one chain event into the per-coin flow stats. */
function noteEvent(event: ChainEvent): void {
  if (event.event === 'CreateEvent') {
    const flow = flows.get(event.mint) ?? freshFlow(event.creator);
    flow.creator = event.creator;
    flow.createVq = BigInt(event.virtual_quote_reserves);
    flow.createVt = BigInt(event.virtual_token_reserves);
    flows.set(event.mint, flow);
    candidates.add(event.mint);
    return;
  }
  if (event.event !== 'TradeEvent') return;
  let flow = flows.get(event.mint);
  if (flow === undefined) {
    // A coin first seen through a trade (created before the window):
    // no creation price, so it can never pass the entry filters.
    flow = freshFlow(event.creator);
    flows.set(event.mint, flow);
  }
  const sol = BigInt(event.sol_amount);
  if (event.user === flow.creator) {
    if (event.is_buy) flow.creatorBuySol += sol;
    else flow.creatorSold = true;
  } else if (event.is_buy) {
    flow.buyers.add(event.user);
    flow.othersBuySol += sol;
  } else {
    flow.othersSellSol += sol;
  }
}

// ------------------------------------------------------------------ entry filter

/** Every entry condition, checked against the curve and its flow stats. */
function entryOk(state: BotState, mint: string, flow: CoinFlow): boolean {
  const curve = state.curves.get(mint);
  if (curve === undefined || curve.complete) return false;
  const real = curve.real_quote_reserves;
  if (real < RESERVE_MIN_LAMPORTS || real > RESERVE_MAX_LAMPORTS) return false;
  if (flow.creatorSold) return false;
  if (flow.creatorBuySol > CREATOR_MAX_OPEN_BUY_LAMPORTS) return false;
  if (flow.buyers.size < MIN_DISTINCT_BUYERS) return false;
  if (flow.othersBuySol < MIN_OTHERS_BUY_LAMPORTS) return false;
  if (flow.othersSellSol * 10_000n > flow.othersBuySol * MAX_OTHERS_SELL_BPS) return false;
  // Run-up from the creation price, in exact integer math. With
  //   lhs = vq * createVt and rhs = vt * createVq, the price ratio is
  //   price / creation price = lhs / rhs, so
  //   >= +1%  <=>  lhs * 10000 >= rhs * (10000 + 100)
  //   <= +40% <=>  lhs * 10000 <= rhs * (10000 + 4000)
  if (flow.createVq <= 0n || flow.createVt <= 0n) return false;
  const vq = curve.virtual_quote_reserves;
  const vt = curve.virtual_token_reserves;
  if (vq <= 0n || vt <= 0n) return false;
  const lhs = vq * flow.createVt;
  const rhs = vt * flow.createVq;
  if (lhs * 10_000n < rhs * (10_000n + RUN_UP_MIN_BPS)) return false;
  if (lhs * 10_000n > rhs * (10_000n + RUN_UP_MAX_BPS)) return false;
  return true;
}

// ------------------------------------------------------------------ the bot

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];
    const tx = state.txFeeLamports();
    const maxOrders = state.hello.caps.max_orders_per_batch;

    // 1. Reconcile the fills that resolved since the last batch: a sell in
    //    flight is done with, and a take-profit-1 fill (or its refusal)
    //    settles whether half the position is banked yet.
    for (const fill of batch.fills) {
      const pending = pendingSells.get(fill.client_id);
      if (pending === undefined) continue;
      pendingSells.delete(fill.client_id);
      if (pending.kind === 'tp1') {
        const h = held.get(pending.mint);
        if (h !== undefined) h.tp1 = fill.status === 'filled' ? 'done' : 'none';
      }
    }

    // 2. Fold this batch's events into the per-coin flow stats.
    for (const event of batch.events) noteEvent(event);

    // 3. Sync the held-position table with the harness's account: open a
    //    record when a position first shows up (its entry slot is the slot
    //    the buy was decided on), drop records for positions that are gone.
    for (const [mint, holding] of state.positions) {
      if (!held.has(mint)) {
        const entrySlot = pendingBuySlot.get(mint) ?? state.slot;
        held.set(mint, {
          entrySlot,
          bestRatioBps: positionRatioBps(state, mint, holding.token_amount, holding.cost_lamports),
          armed: false,
          tp1: 'none',
        });
      }
      pendingBuySlot.delete(mint);
    }
    for (const mint of [...held.keys()]) {
      if (!state.positions.has(mint)) held.delete(mint);
    }
    // A buy whose position never showed up (rejected, or failed) stops
    // counting as pending once its fill is long past.
    for (const [mint, slot] of [...pendingBuySlot.entries()]) {
      if (state.slot - slot > 10) pendingBuySlot.delete(mint);
    }

    // 4. Exits, one decision per held position, checked every batch.
    //    Order matters: a full exit beats a partial take-profit, and the
    //    creator selling beats everything.
    for (const [mint, holding] of state.positions) {
      if (orders.length >= maxOrders) break;
      const h = held.get(mint);
      const curve = state.curves.get(mint);
      if (h === undefined || curve === undefined || curve.complete) continue;
      const tokens = holding.token_amount;
      const cost = holding.cost_lamports;
      if (tokens <= 0n || cost <= 0n) continue;
      // A sell already in flight for this mint settles first; never stack
      // a second sell on the same tokens.
      let sellInFlight = false;
      for (const p of pendingSells.values()) {
        if (p.mint === mint) {
          sellInFlight = true;
          break;
        }
      }
      if (sellInFlight) continue;

      const ratio = positionRatioBps(state, mint, tokens, cost);
      if (ratio > h.bestRatioBps) h.bestRatioBps = ratio;
      if (ratio >= 10_000n + TRAIL_ARM_BPS) h.armed = true;

      const flow = flows.get(mint);
      const stopBps = h.tp1 === 'done' ? 10_000n - STOP_AFTER_TP1_BPS : 10_000n - STOP_BPS;
      let sellAll = false;
      let sellHalf = false;
      if (flow !== undefined && flow.creatorSold) sellAll = true;
      else if (ratio <= stopBps) sellAll = true;
      else if (h.armed && ratio * 10_000n <= h.bestRatioBps * (10_000n - TRAIL_BPS)) sellAll = true;
      else if (h.tp1 === 'none' && ratio >= 10_000n + TP1_BPS) sellHalf = true;
      else if (state.slot - h.entrySlot >= MAX_HOLD_SLOTS) sellAll = true;
      else if (state.slot - curve.reserves_slot >= STALE_SLOTS) sellAll = true;

      if (sellAll) {
        if (sellValue(state, mint, tokens) <= 0n) continue;
        const id = state.clientId();
        orders.push({
          side: 'sell',
          client_id: id,
          mint,
          token_amount: tokens,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
        pendingSells.set(id, { mint, kind: 'exit' });
      } else if (sellHalf) {
        const half = (tokens * TP1_PART_BPS) / 10_000n;
        if (half <= 0n) continue;
        if (sellValue(state, mint, half) <= 0n) continue;
        const id = state.clientId();
        orders.push({
          side: 'sell',
          client_id: id,
          mint,
          token_amount: half,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
        pendingSells.set(id, { mint, kind: 'tp1' });
        h.tp1 = 'pending';
      }
    }

    // 5. Entries: each coin is decided once, inside its first 4 slots.
    //    A coin that fails a filter stays a candidate while the window is
    //    open — buyers and the run-up are still arriving — and is dropped
    //    when the window closes. A buy is never added to a position, and a
    //    coin that is bought is never entered again. The scan walks only
    //    the candidate set, in creation order, so it stays cheap no matter
    //    how many curves the replay has shown.
    let free = state.freeCashLamports();
    let slots = state.hello.caps.max_open_positions - state.committedPositionCount();
    for (const mint of [...candidates]) {
      if (orders.length >= maxOrders) break;
      if (slots <= 0) break;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) {
        candidates.delete(mint);
        continue;
      }
      if (curve.created_slot === null) {
        candidates.delete(mint);
        continue;
      }
      const age = state.slot - curve.created_slot;
      if (age < 0 || age > ENTRY_WINDOW_SLOTS) {
        candidates.delete(mint);
        continue;
      }
      if (decided.has(mint)) {
        candidates.delete(mint);
        continue;
      }
      if (state.positions.has(mint) || pendingBuySlot.has(mint)) continue;
      const flow = flows.get(mint);
      if (flow === undefined || !entryOk(state, mint, flow)) continue;
      const cap = state.maxBuyLamports(mint);
      if (cap < MIN_BUY_LAMPORTS) continue;
      const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
      if (free < amount + tx) continue;
      const id = state.clientId();
      orders.push({
        side: 'buy',
        client_id: id,
        mint,
        quote_lamports: amount,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      decided.add(mint);
      candidates.delete(mint);
      pendingBuySlot.set(mint, state.slot);
      free -= amount + tx;
      slots -= 1;
    }

    return orders;
  },
});
