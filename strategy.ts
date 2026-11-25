// Sharpe-sprint bot: two-tier RQ-cross momentum for agent-fun/replay/v2.
//
// WHY TWO TIERS (read before tuning): the final window is 6 hours, but the
// guardrail needs a >= 0.01 SOL round trip on >= 20 distinct mints inside
// that window. The proven single-tier filter (buy 1 slot after real SOL first
// crosses 2 SOL, >= 5 distinct buyers, >= 2x growth, TP/SL 10%, hold <= 8
// slots) nets about +0.19 SOL over the 24h dev window but only ~41 trips --
// about 10 per 6h, far short of the 20-mint bar. Loosening that one filter to
// >= 3 buyers reaches ~30 trips per 6h but dilutes the edge to ~breakeven or
// negative, and the 6h slices go negative in half the day. So:
//
//   Tier 1 (the edge): the proven strict filter at full size. It carries
//     the PnL. ~10 trips per 6h.
//   Tier 2 (the filler): a looser filter (>= 3 buyers, >= 2x growth from a
//     0.5 SOL cross) at small size, decided at the same slot as tier 1 when
//     the coin reached 2 SOL, or on its own cross when it never did. It
//     supplies the distinct-mint count; its per-trade size is small, so its
//     drag on PnL is bounded while its trades still count (>= 0.01 SOL buys).
//
// Sharpe note: the rank key is mean/std of the 6 hourly equity returns of the
// final window (not annualized). Small, frequent, similarly-sized trades in
// every hour beat one lucky moonshot: tier 2 also steadies the hourly PnL by
// trading in hours where tier 1 finds nothing. Exits are fast on both tiers
// (<= 8 slots) so almost no position is open at an hour boundary and the
// hourly equity is essentially realized PnL.
//
// Pure function of the batches: no clock, no randomness, no I/O,
// deterministic iteration order.

import { BPS, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Real SOL reserve a coin must hold at entry. */
  minRqSol: number;
  /** Slots to wait after the reserve first crossed minRqSol before deciding. */
  confirmDelay: number;
  /** Net buy SOL over (cross, decision] required at entry. */
  minFlowSol: number;
  /** Distinct non-creator buyers in (cross, decision] required at entry. */
  minDistinctBuyers: number;
  /** Real SOL at decision must be at least this many bps of the real SOL at the cross. */
  minRqGrowthBps: number;
  /** SOL to put into one position (capped at 1% of real SOL). */
  stakeSol: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Slippage allowed on buys (bps); sells always 10000. */
  buySlipBps: number;
  /** Exit when the position is worth this much over its cost (bps). */
  tpBps: number;
  /** Exit when it is worth this much under its cost (bps). */
  slBps: number;
  /** Trailing stop: once up at least trailArmBps, exit on a fall of trailBps from the best value. */
  trailArmBps: number;
  trailBps: number;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** Exit when the creator sells while held (and had not sold before entry). */
  exitOnDevSell: boolean;
  // ---- Tier 2 (small-size filler for the 20-mint guardrail) ----
  /** Enable the tier-2 fallback. */
  tier2Enabled: boolean;
  /** Tier-2 cross: real SOL reserve a coin must first reach. */
  minRqSol2: number;
  /** Slots to wait after the tier-2 cross when the coin never reaches tier 1. */
  confirmDelay2: number;
  /** Net buy SOL over (tier-2 cross, decision] required at entry. */
  minFlowSol2: number;
  /** Distinct non-creator buyers in (tier-2 cross, decision] required. */
  minDistinctBuyers2: number;
  /** Real SOL at decision must be at least this many bps of the tier-2 cross value. */
  minRqGrowthBps2: number;
  /** SOL to put into one tier-2 position (capped at 1% of real SOL). */
  stakeSol2: number;
  /** Smallest tier-2 buy worth sending (must stay >= 0.01 SOL guardrail floor). */
  minBuySol2: number;
  /** Tier-2 take profit (bps). */
  tpBps2: number;
  /** Tier-2 stop loss (bps). */
  slBps2: number;
  /** Tier-2 max hold (slots). */
  maxHold2: number;
}

export const DEFAULT_PARAMS: Params = {
  minRqSol: 2,
  confirmDelay: 1,
  minFlowSol: 0,
  minDistinctBuyers: 5,
  minRqGrowthBps: 20000,
  stakeSol: 0.2,
  minBuySol: 0.02,
  buySlipBps: 10000,
  tpBps: 1500,
  slBps: 1000,
  trailArmBps: 100000,
  trailBps: 1000,
  maxHold: 8,
  exitOnDevSell: true,
  tier2Enabled: true,
  minRqSol2: 0.4,
  confirmDelay2: 1,
  minFlowSol2: 0,
  minDistinctBuyers2: 3,
  minRqGrowthBps2: 24000,
  stakeSol2: 0.02,
  minBuySol2: 0.012,
  tpBps2: 500,
  slBps2: 1000,
  maxHold2: 8,
};

const FEE_BPS = 125n;

interface Tick {
  slot: number;
  isBuy: boolean;
  sol: bigint;
  user: Pubkey;
}

interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  /** Slot the real SOL reserve first reached minRqSol (-1 = never). */
  crossSlot: number;
  /** Real SOL reserve (lamports) at the cross. */
  crossRq: bigint;
  /** Slot the real SOL reserve first reached minRqSol2 (-1 = never). */
  cross2Slot: number;
  /** Real SOL reserve (lamports) at the tier-2 cross. */
  cross2Rq: bigint;
  devSold: boolean;
  recent: Tick[];
  entered: boolean;
  done: boolean;
  complete: boolean;
}

interface Held {
  openedSlot: number;
  txPaid: bigint;
  best: bigint;
  devSoldAtOpen: boolean;
  /** Exit parameters of the tier that opened this position. */
  tpBps: number;
  slBps: number;
  maxHold: number;
}

/** What selling `tokens` against (vq, vt) would pay after curve fees (95 + 30 bps). */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

export function createStrategy(params: Params = DEFAULT_PARAMS) {
  const P = params;
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  const selling = new Set<Pubkey>();
  /** Exit parameters of the tier that placed a pending buy, by mint. */
  const pendingTier = new Map<Pubkey, { tpBps: number; slBps: number; maxHold: number }>();
  const minRq = BigInt(Math.floor(P.minRqSol * 1e9));
  const minRq2 = BigInt(Math.floor(P.minRqSol2 * 1e9));
  const stake = BigInt(Math.floor(P.stakeSol * 1e9));
  const stake2 = BigInt(Math.floor(P.stakeSol2 * 1e9));
  const minBuy = BigInt(Math.floor(P.minBuySol * 1e9));
  const minBuy2 = BigInt(Math.floor(P.minBuySol2 * 1e9));
  const minFlow = BigInt(Math.floor(P.minFlowSol * 1e9));
  const minFlow2 = BigInt(Math.floor(P.minFlowSol2 * 1e9));

  function readEvents(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        coins.set(e.mint, {
          mint: e.mint,
          createSlot: e.slot,
          creator: e.creator,
          crossSlot: -1,
          crossRq: 0n,
          cross2Slot: -1,
          cross2Rq: 0n,
          devSold: false,
          recent: [],
          entered: false,
          done: false,
          complete: false,
        });
      } else if (e.event === 'TradeEvent') {
        const c = coins.get(e.mint);
        if (c === undefined) continue;
        const sol = BigInt(e.sol_amount);
        c.recent.push({ slot: e.slot, isBuy: e.is_buy, sol, user: e.user });
        if (c.crossSlot < 0 && BigInt(e.real_quote_reserves) >= minRq) {
          c.crossSlot = e.slot;
          c.crossRq = BigInt(e.real_quote_reserves);
        }
        if (P.tier2Enabled && c.cross2Slot < 0 && BigInt(e.real_quote_reserves) >= minRq2) {
          c.cross2Slot = e.slot;
          c.cross2Rq = BigInt(e.real_quote_reserves);
        }
        if (!e.is_buy && e.user === c.creator) c.devSold = true;
      } else {
        const c = coins.get(e.mint);
        if (c !== undefined) {
          c.complete = true;
          c.done = true;
        }
      }
    }
  }

  /** Distinct non-creator buyers over (fromSlot, slot]. */
  function distinctBuyers(c: Coin, fromSlot: number, slot: number): number {
    const buyers = new Set<Pubkey>();
    for (let i = c.recent.length - 1; i >= 0; i--) {
      const t = c.recent[i]!;
      if (t.slot <= fromSlot) break;
      if (t.slot > slot) continue;
      if (t.isBuy && t.user !== c.creator) buyers.add(t.user);
    }
    return buyers.size;
  }
  function flowSince(c: Coin, fromSlot: number, slot: number): bigint {
    let net = 0n;
    for (let i = c.recent.length - 1; i >= 0; i--) {
      const t = c.recent[i]!;
      if (t.slot <= fromSlot) break;
      if (t.slot > slot) continue;
      net += t.isBuy ? t.sol : -t.sol;
    }
    return net;
  }

  function hasPendingBuy(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) if (p.order.mint === mint && p.order.side === 'buy') return true;
    return false;
  }

  function hasPendingSell(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) if (p.order.mint === mint && p.order.side === 'sell') return true;
    return false;
  }

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      readEvents(batch);
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });

      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          held.delete(f.mint);
          selling.delete(f.mint);
          continue;
        }
        const h = held.get(f.mint);
        if (f.status !== 'rejected' && h !== undefined) h.txPaid += BigInt(f.tx_fee_lamports);
        if (f.side === 'buy' && f.status === 'filled' && h === undefined) {
          const t = pendingTier.get(f.mint) ?? { tpBps: P.tpBps, slBps: P.slBps, maxHold: P.maxHold };
          pendingTier.delete(f.mint);
          held.set(f.mint, { openedSlot: f.slot, txPaid: BigInt(f.tx_fee_lamports), best: 0n, devSoldAtOpen: coins.get(f.mint)?.devSold ?? false, tpBps: t.tpBps, slBps: t.slBps, maxHold: t.maxHold });
        }
      }
      for (const mint of [...selling]) if (!hasPendingSell(state, mint)) selling.delete(mint);
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint) && !hasPendingBuy(state, mint)) held.delete(mint);
      }

      // Exits first.
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint)) continue;
        const c = coins.get(mint);
        let h = held.get(mint);
        if (h === undefined) {
          h = { openedSlot: state.slot, txPaid: tx, best: 0n, devSoldAtOpen: c?.devSold ?? false, tpBps: P.tpBps, slBps: P.slBps, maxHold: P.maxHold };
          held.set(mint, h);
        }
        let mk = marks.get(mint);
        if (mk === undefined) {
          const cv = state.curves.get(mint);
          if (cv === undefined) continue;
          mk = { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
        }
        const value = sellValue(pos.token_amount, mk.vq, mk.vt) - tx;
        const basis = pos.cost_lamports + h.txPaid;
        if (value > h.best) h.best = value;
        let exit = false;
        if (basis > 0n) {
          if (value * BPS >= basis * (BPS + BigInt(h.tpBps))) exit = true;
          if (value * BPS <= basis * (BPS - BigInt(h.slBps))) exit = true;
          if (h.best * BPS >= basis * (BPS + BigInt(P.trailArmBps)) && value * BPS <= h.best * (BPS - BigInt(P.trailBps))) exit = true;
        }
        if (state.slot - h.openedSlot >= h.maxHold) exit = true;
        if (c !== undefined && P.exitOnDevSell && c.devSold && !h.devSoldAtOpen) exit = true;
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10000 });
        selling.add(mint);
        if (c !== undefined) c.done = true;
      }

      // Entries. One decision per coin:
      //   - if it reached the tier-1 threshold, decide at crossSlot + confirmDelay:
      //     tier 1 first (full size), tier 2 as a same-slot fallback (small size);
      //   - if it never reached tier 1, decide on the tier-2 cross + confirmDelay2.
      // A failed test does NOT finish the coin: like the single-tier bot, it is
      // re-tested on the next slots (the confirmation window keeps growing)
      // until the slot passes the small decision window, and only then is the
      // coin done. Collapsing this to one chance loses most entries.
      let free = state.freeCashLamports();
      let open = state.committedPositionCount();
      for (const c of coins.values()) {
        if (orders.length >= cap) break;
        if (c.done || c.complete || c.entered) continue;
        if (open >= state.hello.caps.max_open_positions) break;

        let tier1Slot = false;
        if (c.crossSlot >= 0) {
          if (state.slot < c.crossSlot + P.confirmDelay) continue;
          if (state.slot > c.crossSlot + P.confirmDelay + 2) {
            c.done = true;
            continue;
          }
          tier1Slot = true;
        } else if (P.tier2Enabled && c.cross2Slot >= 0) {
          if (state.slot < c.cross2Slot + P.confirmDelay2) continue;
          if (state.slot > c.cross2Slot + P.confirmDelay2 + 2) {
            c.done = true;
            continue;
          }
        } else {
          continue;
        }

        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) continue;
        if (hasPendingBuy(state, c.mint)) continue;

        const rq = curve.real_quote_reserves;
        // Tier 1: the proven strict filter.
        if (
          tier1Slot &&
          rq >= minRq &&
          flowSince(c, c.crossSlot, state.slot) > minFlow &&
          distinctBuyers(c, c.crossSlot, state.slot) >= P.minDistinctBuyers &&
          rq * BPS >= c.crossRq * BigInt(P.minRqGrowthBps)
        ) {
          const maxBuy = state.maxBuyLamports(c.mint);
          const amount = stake < maxBuy ? stake : maxBuy;
          if (amount >= minBuy && free >= amount + tx) {
            orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: P.buySlipBps });
            pendingTier.set(c.mint, { tpBps: P.tpBps, slBps: P.slBps, maxHold: P.maxHold });
            free -= amount + tx;
            c.entered = true;
            open += 1;
            continue;
          }
        }
        // Tier 2: looser filter, small size. Confirmation is measured from the
        // tier-2 cross (an earlier, lower threshold), so at a tier-1 decision
        // slot its window is longer and it passes strictly more often.
        if (
          P.tier2Enabled &&
          c.cross2Slot >= 0 &&
          rq >= minRq2 &&
          flowSince(c, c.cross2Slot, state.slot) > minFlow2 &&
          distinctBuyers(c, c.cross2Slot, state.slot) >= P.minDistinctBuyers2 &&
          rq * BPS >= c.cross2Rq * BigInt(P.minRqGrowthBps2)
        ) {
          const maxBuy = state.maxBuyLamports(c.mint);
          const amount = stake2 < maxBuy ? stake2 : maxBuy;
          if (amount >= minBuy2 && free >= amount + tx) {
            orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: P.buySlipBps });
            pendingTier.set(c.mint, { tpBps: P.tpBps2, slBps: P.slBps2, maxHold: P.maxHold2 });
            free -= amount + tx;
            c.entered = true;
            open += 1;
            continue;
          }
        }
        // Failed this slot: leave undecided for a re-test on the next slot;
        // the stale bound above finishes the coin.
      }
      return orders;
    },
  };
}
