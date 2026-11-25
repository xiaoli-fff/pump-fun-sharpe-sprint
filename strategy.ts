// strategy.ts — paper-trading strategy for the pump.fun Sharpe sprint.
//
// The idea in one paragraph: only chase a new coin once its bonding curve
// has genuinely started to move. A coin becomes interesting when its real
// SOL reserve first reaches a level (2 SOL for the strict tier, 0.4 SOL for
// the loose tier). We then wait one slot, and inside a three-slot window we
// buy only when fresh non-creator buyers keep arriving, net flow since the
// crossing is positive, and the reserve has multiplied since the crossing.
// Exits are mechanical: take-profit, stop-loss, a trailing rule that almost
// never fires, an eight-slot holding cap, and an exit when the creator sells
// after we entered. Everything is a pure function of the batches seen so
// far: no clock, no randomness, no I/O, and a fixed traversal order, so two
// runs over the same replay produce the same orders.
//
// Money is counted in lamports (bigint) wherever a comparison decides an
// order, so no floating point ever leaks into a decision.

import type {
  Batch,
  BotState,
  ChainEvent,
  Fill,
  OrderInput,
  Pubkey,
} from "./vendor/makefun-bot.ts";

/** One trade seen on a coin, kept for the buyer / flow windows. */
interface Tick {
  slot: number;
  buy: boolean;
  solLamports: bigint;
  trader: Pubkey;
}

/** Everything remembered about one coin. */
interface CoinMemory {
  mint: Pubkey;
  creator: Pubkey;
  createdSlot: number;
  ticks: Tick[];
  /** Slot / reserve where the real SOL reserve first reached 2 SOL. */
  strictCrossSlot: number | null;
  strictCrossReserve: bigint;
  /** Slot / reserve where the real SOL reserve first reached 0.4 SOL. */
  looseCrossSlot: number | null;
  looseCrossReserve: bigint;
  creatorSold: boolean;
  entered: boolean;
  /** Marked once the coin is done with: window expired, sold, completed. */
  settled: boolean;
  /** A CompleteEvent arrived for this coin. */
  finished: boolean;
  /** Real SOL reserve from the latest trade seen on this coin. */
  latestRealSol: bigint;
}

/** Exit rules carried by one open position. */
export interface ExitParams {
  takeProfitBps: number;
  stopLossBps: number;
  maxHoldSlots: number;
  exitOnCreatorSell: boolean;
}

/** One buying tier: how big, how strict, and how it exits. */
export interface BuyTier extends ExitParams {
  sizeLamports: bigint;
  minSizeLamports: bigint;
  /** Real SOL reserve that arms this tier. */
  thresholdLamports: bigint;
  minDistinctBuyers: number;
  /** Reserve must reach this multiple of the crossing reserve (bps: 200 = 2.00x). */
  reserveMultipleBps: number;
}

/** All tunable numbers of the strategy, in one table. */
export interface StrategyParams {
  strictTier: BuyTier;
  looseTier: BuyTier;
  /** Trailing rule arms once the peak reaches this multiple of cost (bps: 110000 = 11x). */
  peakTriggerBps: number;
  /** ...and fires once value has fallen to this share of the peak (bps: 9000 = 90%). */
  pullbackKeepBps: number;
  /** Curve fee charged on a sell, in basis points. */
  curveFeeBps: number;
}

/** The default parameter table: the strict 0.2 SOL tier and the loose 0.02 SOL tier. */
export const DEFAULT_PARAMS: StrategyParams = {
  strictTier: {
    sizeLamports: 200_000_000n,
    minSizeLamports: 20_000_000n,
    thresholdLamports: 2_000_000_000n,
    minDistinctBuyers: 5,
    reserveMultipleBps: 200,
    takeProfitBps: 1500,
    stopLossBps: 1000,
    maxHoldSlots: 8,
    exitOnCreatorSell: true,
  },
  looseTier: {
    sizeLamports: 20_000_000n,
    minSizeLamports: 12_000_000n,
    thresholdLamports: 400_000_000n,
    minDistinctBuyers: 3,
    reserveMultipleBps: 240,
    takeProfitBps: 1000,
    stopLossBps: 1000,
    maxHoldSlots: 8,
    exitOnCreatorSell: true,
  },
  peakTriggerBps: 110000,
  pullbackKeepBps: 9000,
  curveFeeBps: 125,
};

/** The exit half of a tier, on its own. */
export function exitOf(tier: BuyTier): ExitParams {
  return {
    takeProfitBps: tier.takeProfitBps,
    stopLossBps: tier.stopLossBps,
    maxHoldSlots: tier.maxHoldSlots,
    exitOnCreatorSell: tier.exitOnCreatorSell,
  };
}

/** One open position as the strategy remembers it. */
interface PositionMemory {
  openedSlot: number;
  feesPaidLamports: bigint;
  peakValueLamports: bigint;
  exit: ExitParams;
  creatorSoldAtEntry: boolean;
}

const MAX_SLIPPAGE_BPS = 10_000;

function minBigint(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function freshCoin(mint: Pubkey, creator: Pubkey, createdSlot: number): CoinMemory {
  return {
    mint,
    creator,
    createdSlot,
    ticks: [],
    strictCrossSlot: null,
    strictCrossReserve: 0n,
    looseCrossSlot: null,
    looseCrossReserve: 0n,
    creatorSold: false,
    entered: false,
    settled: false,
    finished: false,
    latestRealSol: 0n,
  };
}

/**
 * The strategy itself. One instance lives for one run; its memory is the
 * coins seen, the positions it believes it holds, the sells in flight, and
 * which exit rules each pending buy belongs to.
 */
export class PumpFunStrategy {
  readonly params: StrategyParams;
  private readonly coins = new Map<Pubkey, CoinMemory>();
  private readonly ledger = new Map<Pubkey, PositionMemory>();
  private readonly selling = new Set<Pubkey>();
  private readonly pendingTier = new Map<Pubkey, ExitParams>();

  constructor(params: StrategyParams = DEFAULT_PARAMS) {
    this.params = params;
  }

  /** Decide one batch: merge events, settle fills, prune, sell, then buy. */
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    this.absorbEvents(batch.events);
    this.absorbFills(batch.fills);
    this.prune(state);
    const orders: OrderInput[] = [];
    orders.push(...this.planSells(state, batch));
    orders.push(...this.planBuys(state, orders.length));
    return orders;
  }

  // ------------------------------------------------------------ event intake

  private absorbEvents(events: ChainEvent[]): void {
    for (const event of events) {
      if (event.event === "CreateEvent") {
        if (!this.coins.has(event.mint)) {
          this.coins.set(event.mint, freshCoin(event.mint, event.creator, event.slot));
        }
        continue;
      }
      if (event.event === "TradeEvent") {
        let coin = this.coins.get(event.mint);
        if (coin === undefined) {
          coin = freshCoin(event.mint, event.creator, event.slot);
          this.coins.set(event.mint, coin);
        }
        const realSol = BigInt(event.real_sol_reserves);
        coin.latestRealSol = realSol;
        coin.ticks.push({
          slot: event.slot,
          buy: event.is_buy,
          solLamports: BigInt(event.sol_amount),
          trader: event.user,
        });
        if (coin.strictCrossSlot === null && realSol >= this.params.strictTier.thresholdLamports) {
          coin.strictCrossSlot = event.slot;
          coin.strictCrossReserve = realSol;
        }
        if (coin.looseCrossSlot === null && realSol >= this.params.looseTier.thresholdLamports) {
          coin.looseCrossSlot = event.slot;
          coin.looseCrossReserve = realSol;
        }
        if (!event.is_buy && event.user === coin.creator) {
          coin.creatorSold = true;
        }
        continue;
      }
      // Any other event type ends the coin's tradable life.
      let coin = this.coins.get(event.mint);
      if (coin === undefined) {
        coin = freshCoin(event.mint, event.user, event.slot);
        this.coins.set(event.mint, coin);
      }
      coin.finished = true;
      coin.settled = true;
    }
  }

  // ------------------------------------------------------------ fill intake

  private absorbFills(fills: Fill[]): void {
    for (const fill of fills) {
      // The harness's own closes only clean up: no position, no sell in flight.
      if (fill.client_id.startsWith("_")) {
        this.ledger.delete(fill.mint);
        this.selling.delete(fill.mint);
        continue;
      }
      if (fill.status === "rejected") continue;
      const record = this.ledger.get(fill.mint);
      if (record !== undefined) {
        record.feesPaidLamports += BigInt(fill.tx_fee_lamports);
      }
      if (fill.side === "buy" && fill.status === "filled" && record === undefined) {
        const coin = this.coins.get(fill.mint);
        this.ledger.set(fill.mint, {
          openedSlot: fill.slot,
          feesPaidLamports: BigInt(fill.tx_fee_lamports),
          peakValueLamports: 0n,
          exit: this.pendingTier.get(fill.mint) ?? exitOf(this.params.strictTier),
          creatorSoldAtEntry: coin?.creatorSold ?? false,
        });
        this.pendingTier.delete(fill.mint);
      }
    }
  }

  // ------------------------------------------------------------ pruning

  private hasPendingBuy(state: BotState, mint: Pubkey): boolean {
    for (const pending of state.pending.values()) {
      if (pending.order.side === "buy" && pending.order.mint === mint) return true;
    }
    return false;
  }

  private hasPendingSell(state: BotState, mint: Pubkey): boolean {
    for (const pending of state.pending.values()) {
      if (pending.order.side === "sell" && pending.order.mint === mint) return true;
    }
    return false;
  }

  private prune(state: BotState): void {
    for (const mint of [...this.selling]) {
      if (!this.hasPendingSell(state, mint)) this.selling.delete(mint);
    }
    for (const mint of [...this.ledger.keys()]) {
      if (state.positions.has(mint)) continue;
      if (this.selling.has(mint)) continue;
      if (this.hasPendingBuy(state, mint)) continue;
      this.ledger.delete(mint);
    }
  }

  // ------------------------------------------------------------ windows

  /** Net bought SOL in (startSlot, ...]: buys add, sells subtract, newest first. */
  private netFlowSince(coin: CoinMemory, startSlot: number): bigint {
    let total = 0n;
    for (let i = coin.ticks.length - 1; i >= 0; i--) {
      const tick = coin.ticks[i];
      if (tick.slot <= startSlot) break;
      total += tick.buy ? tick.solLamports : -tick.solLamports;
    }
    return total;
  }

  /** Distinct non-creator buyers in (startSlot, ...], newest first. */
  private distinctBuyersSince(coin: CoinMemory, startSlot: number): number {
    const buyers = new Set<Pubkey>();
    for (let i = coin.ticks.length - 1; i >= 0; i--) {
      const tick = coin.ticks[i];
      if (tick.slot <= startSlot) break;
      if (tick.buy && tick.trader !== coin.creator) buyers.add(tick.trader);
    }
    return buyers.size;
  }

  /** Strict tier: reserve, flow, buyer count and reserve multiple all hold. */
  private strictReady(coin: CoinMemory): boolean {
    if (coin.strictCrossSlot === null) return false;
    const tier = this.params.strictTier;
    if (coin.latestRealSol < tier.thresholdLamports) return false;
    if (this.netFlowSince(coin, coin.strictCrossSlot) <= 0n) return false;
    if (this.distinctBuyersSince(coin, coin.strictCrossSlot) < tier.minDistinctBuyers) return false;
    return coin.latestRealSol * 100n >= coin.strictCrossReserve * BigInt(tier.reserveMultipleBps);
  }

  /** Loose tier: same shape, smaller numbers. */
  private looseReady(coin: CoinMemory): boolean {
    if (coin.looseCrossSlot === null) return false;
    const tier = this.params.looseTier;
    if (coin.latestRealSol < tier.thresholdLamports) return false;
    if (this.netFlowSince(coin, coin.looseCrossSlot) <= 0n) return false;
    if (this.distinctBuyersSince(coin, coin.looseCrossSlot) < tier.minDistinctBuyers) return false;
    return coin.latestRealSol * 100n >= coin.looseCrossReserve * BigInt(tier.reserveMultipleBps);
  }

  // ------------------------------------------------------------ sells

  private planSells(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];
    const txFee = state.txFeeLamports();
    const cap = state.hello.caps.max_orders_per_batch;
    const marks = new Map(batch.marks.map((mark) => [mark.mint, mark]));
    for (const [mint, position] of state.positions) {
      if (orders.length >= cap) break;
      if (this.selling.has(mint)) continue;
      let record = this.ledger.get(mint);
      if (record === undefined) {
        const coin = this.coins.get(mint);
        record = {
          openedSlot: state.slot,
          feesPaidLamports: txFee,
          peakValueLamports: 0n,
          exit: exitOf(this.params.strictTier),
          creatorSoldAtEntry: coin?.creatorSold ?? false,
        };
        this.ledger.set(mint, record);
      }
      // Value this batch's mark first; fall back to the SDK's curve table.
      const mark = marks.get(mint);
      const curve = state.curves.get(mint);
      const virtualTokens =
        mark !== undefined ? BigInt(mark.virtual_token_reserves) : curve?.virtual_token_reserves;
      const virtualQuote =
        mark !== undefined ? BigInt(mark.virtual_quote_reserves) : curve?.virtual_quote_reserves;
      if (virtualTokens === undefined || virtualQuote === undefined) continue;
      const tokens = position.token_amount;
      const gross = (tokens * virtualQuote) / (virtualTokens + tokens);
      const curveFee = (gross * BigInt(this.params.curveFeeBps) + 9999n) / 10_000n;
      const value = gross - curveFee - txFee;
      const cost = position.cost_lamports + record.feesPaidLamports;
      if (value > record.peakValueLamports) record.peakValueLamports = value;
      const exit = record.exit;
      const takeProfit = value * 10_000n >= cost * BigInt(10_000 + exit.takeProfitBps);
      const stopLoss = value * 10_000n <= cost * BigInt(10_000 - exit.stopLossBps);
      const trailing =
        record.peakValueLamports * 10_000n >= cost * BigInt(this.params.peakTriggerBps) &&
        value * 10_000n <= record.peakValueLamports * BigInt(this.params.pullbackKeepBps);
      const heldTooLong = state.slot - record.openedSlot >= exit.maxHoldSlots;
      const coin = this.coins.get(mint);
      const creatorExit =
        exit.exitOnCreatorSell && (coin?.creatorSold ?? false) && !record.creatorSoldAtEntry;
      if (takeProfit || stopLoss || trailing || heldTooLong || creatorExit) {
        orders.push({
          side: "sell",
          mint,
          token_amount: tokens,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
        this.selling.add(mint);
        if (coin !== undefined) coin.settled = true;
      }
    }
    return orders;
  }

  // ------------------------------------------------------------ buys

  private planBuys(state: BotState, alreadyPlaced: number): OrderInput[] {
    const orders: OrderInput[] = [];
    const txFee = state.txFeeLamports();
    const maxOrders = state.hello.caps.max_orders_per_batch;
    const maxOpen = state.hello.caps.max_open_positions;
    let cash = state.freeCashLamports();
    let open = state.committedPositionCount();
    for (const coin of this.coins.values()) {
      if (open >= maxOpen) break;
      if (orders.length + alreadyPlaced >= maxOrders) break;
      if (coin.settled || coin.finished || coin.entered) continue;
      // One-slot confirmation, then a three-slot window, per tier.
      let strictWindow = false;
      if (coin.strictCrossSlot !== null) {
        if (state.slot < coin.strictCrossSlot + 1) continue;
        if (state.slot > coin.strictCrossSlot + 3) {
          coin.settled = true;
          continue;
        }
        strictWindow = true;
      } else if (coin.looseCrossSlot !== null) {
        if (state.slot < coin.looseCrossSlot + 1) continue;
        if (state.slot > coin.looseCrossSlot + 3) {
          coin.settled = true;
          continue;
        }
      } else {
        continue;
      }
      const curve = state.curves.get(coin.mint);
      if (curve === undefined || curve.complete) continue;
      if (this.hasPendingBuy(state, coin.mint)) continue;
      // Strict tier first; if it cannot buy, fall through to the loose tier.
      if (strictWindow && this.strictReady(coin)) {
        const size = minBigint(this.params.strictTier.sizeLamports, state.maxBuyLamports(coin.mint));
        if (size >= this.params.strictTier.minSizeLamports && cash >= size + txFee) {
          orders.push({
            side: "buy",
            mint: coin.mint,
            quote_lamports: size,
            max_slippage_bps: MAX_SLIPPAGE_BPS,
          });
          this.pendingTier.set(coin.mint, exitOf(this.params.strictTier));
          cash -= size + txFee;
          coin.entered = true;
          open += 1;
          continue;
        }
      }
      if (this.looseReady(coin)) {
        const size = minBigint(this.params.looseTier.sizeLamports, state.maxBuyLamports(coin.mint));
        if (size >= this.params.looseTier.minSizeLamports && cash >= size + txFee) {
          orders.push({
            side: "buy",
            mint: coin.mint,
            quote_lamports: size,
            max_slippage_bps: MAX_SLIPPAGE_BPS,
          });
          this.pendingTier.set(coin.mint, exitOf(this.params.looseTier));
          cash -= size + txFee;
          coin.entered = true;
          open += 1;
        }
      }
    }
    return orders;
  }
}

/**
 * Build a strategy from a parameter table. Called with no arguments it
 * builds the default-parameter strategy main.ts runs.
 */
export function createPumpFunStrategy(params: StrategyParams = DEFAULT_PARAMS): PumpFunStrategy {
  return new PumpFunStrategy(params);
}

/** Short alias for the factory. */
export function createStrategy(params: StrategyParams = DEFAULT_PARAMS): PumpFunStrategy {
  return new PumpFunStrategy(params);
}
