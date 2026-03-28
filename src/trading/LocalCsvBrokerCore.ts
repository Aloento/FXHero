import type {
  BrokerConfigFlags,
  Execution,
  IBrokerConnectionAdapterHost,
  Order,
  PlacedOrder,
  Position,
  SingleBrokerMetaInfo,
} from '../charting_library';
import type { TvBar } from '../utils/csvParser';
import CustomDatafeed from '../utils/datafeed';
import {
  COMMISSION_PER_LOT,
  CONTRACT_SIZE,
  FINAL_ORDER_STATUSES,
  LEVERAGE,
  ORDER_STATUS_FILLED,
  ORDER_STATUS_WORKING,
  ORDER_TYPE_LIMIT,
  ORDER_TYPE_MARKET,
  ORDER_TYPE_STOP,
  PARENT_TYPE_POSITION,
  SIDE_BUY,
  SIDE_SELL,
  SYMBOL,
} from './constants';
import type { BrokerSnapshot, InternalPosition, TradeRecord } from './types';

export class LocalCsvBrokerCore {
  protected readonly datafeed: CustomDatafeed;
  protected readonly initialBalance: number;

  protected host: IBrokerConnectionAdapterHost | null = null;
  protected currentOrderSeq = 0;
  protected position: InternalPosition | null = null;
  protected orders: Order[] = [];
  protected orderHistory: Order[] = [];
  protected executions: Execution[] = [];
  protected executionSeq = 0;
  protected lastExecutionTime = 0;
  protected trades: TradeRecord[] = [];

  protected balance: number;
  protected equity: number;
  protected floatingPnl = 0;

  protected summaryBalance: any;
  protected summaryEquity: any;
  protected summaryMargin: any;

  protected listeners = new Set<(snapshot: BrokerSnapshot) => void>();
  protected lastBar: TvBar | null = null;
  protected realtimeSymbols = new Set<string>();

  protected readonly onSimulationBar = (bar: TvBar) => {
    this.lastBar = bar;

    // Keep order ticket quotes in sync with the simulated market.
    this.pushRealtimeQuote(bar);

    // Process pending limit/stop orders.
    const pendingOrders = [...this.orders];
    for (const order of pendingOrders) {
      let triggered = false;
      let fillPrice = bar.close;

      if (order.type === ORDER_TYPE_LIMIT) {
        if (order.side === SIDE_BUY && bar.low <= order.limitPrice!) {
          triggered = true;
          fillPrice = order.limitPrice!;
        } else if (order.side === SIDE_SELL && bar.high >= order.limitPrice!) {
          triggered = true;
          fillPrice = order.limitPrice!;
        }
      } else if (order.type === ORDER_TYPE_STOP) {
        if (order.side === SIDE_BUY && bar.high >= order.stopPrice!) {
          triggered = true;
          fillPrice = order.stopPrice!;
        } else if (order.side === SIDE_SELL && bar.low <= order.stopPrice!) {
          triggered = true;
          fillPrice = order.stopPrice!;
        }
      }

      if (triggered) {
        const orderIdx = this.orders.findIndex((o) => o.id === order.id);
        if (orderIdx >= 0) {
          this.orders.splice(orderIdx, 1);
        }

        const filledOrder: PlacedOrder = {
          ...order,
          status: ORDER_STATUS_FILLED as never,
          avgPrice: fillPrice,
          filledQty: order.qty,
          updateTime: bar.time,
        } as PlacedOrder;

        this.recordFinalOrder(filledOrder);
        this.applyFilledOrder(filledOrder, bar.time, Boolean((order as any).isClose));
      }
    }

    if (!this.position) {
      this.floatingPnl = 0;
      this.equity = this.balance;
      this.publishAccountState();
      return;
    }

    const triggeredPrice = this.getTriggeredBracketPrice(this.position, bar);
    if (triggeredPrice !== null) {
      this.executeBracketClose(triggeredPrice, bar.time);
      return;
    }

    this.position.updateTime = bar.time;
    this.floatingPnl = this.calculateFloatingPnl(this.position, bar.close);
    this.equity = this.balance + this.floatingPnl;

    this.publishPositionPnl();
    this.publishAccountState();
  };

  public constructor(datafeed: CustomDatafeed, initialBalance = 1000) {
    this.datafeed = datafeed;
    this.initialBalance = initialBalance;
    this.balance = initialBalance;
    this.equity = initialBalance;
    this.datafeed.subscribeSimulation(this.onSimulationBar);
  }

  public dispose(): void {
    this.datafeed.unsubscribeSimulation(this.onSimulationBar);
    this.realtimeSymbols.clear();
  }

  public reset(): void {
    this.currentOrderSeq = 0;
    this.position = null;
    this.orders = [];
    this.orderHistory = [];
    this.executions = [];
    this.executionSeq = 0;
    this.lastExecutionTime = 0;
    this.trades = [];
    this.realtimeSymbols.clear();
    this.balance = this.initialBalance;
    this.equity = this.initialBalance;
    this.floatingPnl = 0;
    this.lastBar = this.datafeed.getCurrentBar();

    this.host?.ordersFullUpdate();
    this.host?.positionsFullUpdate();
    this.publishAccountState();
  }

  public forceCloseAll(): void {
    if (this.position) {
      const closeSide = this.position.side === SIDE_BUY ? SIDE_SELL : SIDE_BUY;
      const bar = this.datafeed.getCurrentBar();
      if (!bar) return;

      const orderId = this.nextId('ord_fc');
      const filledOrder: PlacedOrder = {
        id: orderId,
        symbol: this.position.symbol,
        type: ORDER_TYPE_MARKET,
        side: closeSide,
        qty: this.position.qty,
        status: ORDER_STATUS_FILLED as never,
        avgPrice: bar.close,
        filledQty: this.position.qty,
        updateTime: bar.time,
      };

      this.recordFinalOrder(filledOrder);

      this.applyFilledOrder(filledOrder, bar.time, true);
      return;
    }

    this.publishAccountState();
  }

  public subscribeSnapshot(listener: (snapshot: BrokerSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  public getSnapshot(): BrokerSnapshot {
    return {
      balance: this.balance,
      equity: this.equity,
      floatingPnl: this.floatingPnl,
      position: this.toExternalPosition(this.position),
      trades: [...this.trades],
    };
  }

  public getWidgetBrokerConfig(): SingleBrokerMetaInfo {
    const configFlags: BrokerConfigFlags = {
      supportPositions: true,
      supportClosePosition: true,
      supportReversePosition: true,
      supportNativeReversePosition: true,
      supportOrdersHistory: true,
      supportMarketOrders: true,
      supportLimitOrders: true,
      supportStopOrders: true,
      supportStopLimitOrders: false,
      supportOrderBrackets: true,
      supportPositionBrackets: true,
      supportEditAmount: true,
      supportModifyOrderPrice: true,
      supportModifyBrackets: true,
      supportPLUpdate: true,
      supportMargin: true,
      supportLeverage: false,
      supportPlaceOrderPreview: false,
      supportSymbolSearch: false,
      supportExecutions: true,
    };

    return {
      configFlags,
    };
  }

  protected nextId(prefix: string): string {
    this.currentOrderSeq += 1;
    return `${prefix}_${this.currentOrderSeq}`;
  }

  protected createBracketOrder(prefix: string, position: InternalPosition, price: number, type: number): Order {
    return {
      id: `${prefix}_${position.id}`,
      symbol: position.symbol,
      type: type as any,
      side: position.side === SIDE_BUY ? SIDE_SELL : SIDE_BUY,
      qty: position.qty,
      status: ORDER_STATUS_WORKING as any,
      limitPrice: type === ORDER_TYPE_LIMIT ? price : undefined,
      stopPrice: type === ORDER_TYPE_STOP ? price : undefined,
      parentId: position.id,
      parentType: PARENT_TYPE_POSITION as any,
    } as any;
  }

  protected executeBracketClose(price: number, time: number): void {
    if (!this.position) return;

    const fillPrice = price;
    const closeQty = this.position.qty;
    const side = this.position.side;

    // Create fill order for record.
    const orderId = this.nextId('ord');
    const filledOrder: PlacedOrder = {
      id: orderId,
      symbol: this.position.symbol,
      type: ORDER_TYPE_MARKET as any,
      side: side === SIDE_BUY ? SIDE_SELL : SIDE_BUY,
      qty: closeQty,
      status: ORDER_STATUS_FILLED as never,
      avgPrice: fillPrice,
      filledQty: closeQty,
      updateTime: time,
    };
    this.recordFinalOrder(filledOrder);

    this.applyFilledOrder(filledOrder, time, true);
  }

  protected toExternalPosition(position: InternalPosition | null): Position | null {
    if (!position || position.qty <= 0) {
      return null;
    }

    return {
      id: position.id,
      symbol: position.symbol,
      qty: position.qty,
      side: position.side,
      avgPrice: position.avgPrice,
      updateTime: position.updateTime,
      pl: this.floatingPnl,
    } as unknown as Position;
  }

  protected applyFilledOrder(order: PlacedOrder, fillTime: number, isCloseOrder: boolean): void {
    if (!this.position) {
      this.recordExecution(order, fillTime, order.qty, order.avgPrice ?? 0);

      const commission = this.calculateCommission(order.qty);
      this.balance -= commission;

      this.position = {
        id: this.nextId('pos'),
        symbol: order.symbol,
        side: order.side,
        qty: order.qty,
        avgPrice: order.avgPrice ?? 0,
        updateTime: fillTime,
        entryTime: fillTime,
        takeProfit: this.normalizeBracketPrice(order.takeProfit),
        stopLoss: this.normalizeBracketPrice(order.stopLoss),
      };
      this.floatingPnl = 0;
      this.equity = this.balance;
      this.host?.positionUpdate(this.toExternalPosition(this.position)!);
      this.publishPositionPnl();
      this.publishAccountState();

      if (this.position.takeProfit !== undefined) {
        this.host?.orderUpdate(this.createBracketOrder('tp', this.position, this.position.takeProfit, ORDER_TYPE_LIMIT) as any);
      }
      if (this.position.stopLoss !== undefined) {
        this.host?.orderUpdate(this.createBracketOrder('sl', this.position, this.position.stopLoss, ORDER_TYPE_STOP) as any);
      }
      return;
    }

    const current = this.position;
    const sameSide = current.side === order.side;

    if (sameSide && !isCloseOrder) {
      this.recordExecution(order, fillTime, order.qty, order.avgPrice ?? current.avgPrice);

      const commission = this.calculateCommission(order.qty);
      this.balance -= commission;

      const nextQty = current.qty + order.qty;
      const fillPrice = order.avgPrice ?? current.avgPrice;
      current.avgPrice = (current.avgPrice * current.qty + fillPrice * order.qty) / nextQty;
      current.qty = nextQty;
      current.updateTime = fillTime;

      const nextTakeProfit = this.normalizeBracketPrice(order.takeProfit);
      const nextStopLoss = this.normalizeBracketPrice(order.stopLoss);
      if (nextTakeProfit !== undefined) current.takeProfit = nextTakeProfit;
      if (nextStopLoss !== undefined) current.stopLoss = nextStopLoss;

      this.floatingPnl = this.calculateFloatingPnl(current, fillPrice);
      this.equity = this.balance + this.floatingPnl;
      this.host?.positionUpdate(this.toExternalPosition(current)!);
      this.publishPositionPnl();
      this.publishAccountState();

      if (current.takeProfit !== undefined) {
        this.host?.orderUpdate(this.createBracketOrder('tp', current, current.takeProfit, ORDER_TYPE_LIMIT) as any);
      }
      if (current.stopLoss !== undefined) {
        this.host?.orderUpdate(this.createBracketOrder('sl', current, current.stopLoss, ORDER_TYPE_STOP) as any);
      }
      return;
    }

    const fillPrice = order.avgPrice ?? current.avgPrice;
    const closeQty = Math.min(order.qty, current.qty);

    this.recordExecution(order, fillTime, closeQty, fillPrice);

    const pnl = this.calculateClosedPnl(current.side, current.avgPrice, fillPrice, closeQty);
    const commission = this.calculateCommission(closeQty);
    const netPnl = pnl - commission;

    this.balance += netPnl;

    const trade: TradeRecord = {
      id: `${current.id}_${fillTime}_${this.trades.length + 1}`,
      type: current.side === SIDE_BUY ? 'LONG' : 'SHORT',
      entryTime: current.entryTime,
      entryPrice: current.avgPrice,
      exitTime: fillTime,
      exitPrice: fillPrice,
      pnl,
      commission,
      netPnl,
    };
    this.trades.push(trade);

    const remaining = current.qty - closeQty;
    if (remaining > 0 && order.qty <= current.qty) {
      current.qty = remaining;
      current.updateTime = fillTime;
      this.host?.positionUpdate(this.toExternalPosition(current)!);

      if (current.takeProfit !== undefined) {
        this.host?.orderUpdate(this.createBracketOrder('tp', current, current.takeProfit, ORDER_TYPE_LIMIT) as any);
      }
      if (current.stopLoss !== undefined) {
        this.host?.orderUpdate(this.createBracketOrder('sl', current, current.stopLoss, ORDER_TYPE_STOP) as any);
      }
    } else if (order.qty > current.qty) {
      const openQty = order.qty - current.qty;

      this.recordExecution(order, fillTime, openQty, fillPrice);

      this.position = {
        id: this.nextId('pos'),
        symbol: order.symbol,
        side: order.side,
        qty: openQty,
        avgPrice: fillPrice,
        updateTime: fillTime,
        entryTime: fillTime,
        takeProfit: this.normalizeBracketPrice(order.takeProfit),
        stopLoss: this.normalizeBracketPrice(order.stopLoss),
      };
      this.host?.positionsFullUpdate();
      this.host?.positionUpdate(this.toExternalPosition(this.position)!);

      if (this.position.takeProfit !== undefined) {
        this.host?.orderUpdate(this.createBracketOrder('tp', this.position, this.position.takeProfit, ORDER_TYPE_LIMIT) as any);
      }
      if (this.position.stopLoss !== undefined) {
        this.host?.orderUpdate(this.createBracketOrder('sl', this.position, this.position.stopLoss, ORDER_TYPE_STOP) as any);
      }
    } else {
      this.position = null;
      this.host?.positionsFullUpdate();
      this.host?.ordersFullUpdate();
    }

    this.floatingPnl = this.position ? this.calculateFloatingPnl(this.position, fillPrice) : 0;
    this.equity = this.balance + this.floatingPnl;
    this.publishPositionPnl();
    this.publishAccountState();
  }

  protected getTriggeredBracketPrice(position: InternalPosition, bar: TvBar): number | null {
    const takeProfit = this.normalizeBracketPrice(position.takeProfit);
    const stopLoss = this.normalizeBracketPrice(position.stopLoss);
    const epsilon = this.getPriceEpsilon();

    if (position.side === SIDE_BUY) {
      const tpHit = takeProfit !== undefined && bar.high + epsilon >= takeProfit;
      const slHit = stopLoss !== undefined && bar.low - epsilon <= stopLoss;

      if (tpHit && slHit) {
        return this.pickBracketPriceForDualHit(position.side, bar.open, takeProfit!, stopLoss!);
      }
      if (tpHit) {
        return takeProfit!;
      }
      if (slHit) {
        return stopLoss!;
      }
      return null;
    }

    const tpHit = takeProfit !== undefined && bar.low - epsilon <= takeProfit;
    const slHit = stopLoss !== undefined && bar.high + epsilon >= stopLoss;

    if (tpHit && slHit) {
      return this.pickBracketPriceForDualHit(position.side, bar.open, takeProfit!, stopLoss!);
    }
    if (tpHit) {
      return takeProfit!;
    }
    if (slHit) {
      return stopLoss!;
    }
    return null;
  }

  protected publishPositionPnl(): void {
    if (!this.position) {
      return;
    }

    this.host?.plUpdate(this.position.id, this.floatingPnl);
    this.host?.positionPartialUpdate(this.position.id, {
      pl: this.floatingPnl,
      updateTime: this.position.updateTime,
    } as Partial<Position>);
  }

  protected getPriceEpsilon(): number {
    // Keep a tiny tolerance to avoid floating-point misses around TP/SL boundaries.
    return 1e-10;
  }

  protected pickBracketPriceForDualHit(side: number, open: number, takeProfit: number, stopLoss: number): number {
    if (side === SIDE_BUY) {
      if (open <= stopLoss) return stopLoss;
      if (open >= takeProfit) return takeProfit;
      return stopLoss;
    }

    if (open >= stopLoss) return stopLoss;
    if (open <= takeProfit) return takeProfit;
    return stopLoss;
  }

  protected resolveTakeProfitFromOrder(order: Order): number | undefined {
    const takeProfit = (order as any).takeProfit;
    const fromLimit = this.normalizeBracketPrice((order as any).limitPrice);
    if (fromLimit !== undefined) {
      return fromLimit;
    }
    return this.normalizeBracketPrice(takeProfit);
  }

  protected resolveStopLossFromOrder(order: Order): number | undefined {
    const stopLoss = (order as any).stopLoss;
    const fromStop = this.normalizeBracketPrice((order as any).stopPrice);
    if (fromStop !== undefined) {
      return fromStop;
    }
    return this.normalizeBracketPrice(stopLoss);
  }

  protected normalizeBracketPrice(price: unknown): number | undefined {
    if (price === null || price === undefined || price === '') {
      return undefined;
    }

    const normalized = this.extractPriceValue(price);
    return Number.isFinite(normalized) ? normalized : undefined;
  }

  protected extractPriceValue(raw: unknown): number {
    if (typeof raw === 'number') {
      return raw;
    }

    if (typeof raw === 'string') {
      const normalized = raw.trim().replace(/,/g, '');
      return Number(normalized);
    }

    if (typeof raw === 'object' && raw !== null) {
      const obj = raw as Record<string, unknown>;
      for (const key of ['price', 'value', 'limitPrice', 'stopPrice', 'triggerPrice']) {
        if (key in obj) {
          const nested = this.extractPriceValue(obj[key]);
          if (Number.isFinite(nested)) {
            return nested;
          }
        }
      }
    }

    return Number.NaN;
  }

  protected calculateCommission(qty: number): number {
    return COMMISSION_PER_LOT * qty;
  }

  protected calculateFloatingPnl(position: InternalPosition, currentPrice: number): number {
    const diff = currentPrice - position.avgPrice;
    const signedDiff = position.side === SIDE_BUY ? diff : -diff;
    return signedDiff * CONTRACT_SIZE * position.qty;
  }

  protected calculateClosedPnl(side: number, entryPrice: number, exitPrice: number, qty: number): number {
    const diff = exitPrice - entryPrice;
    const signedDiff = side === SIDE_BUY ? diff : -diff;
    return signedDiff * CONTRACT_SIZE * qty;
  }

  protected calculateUsedMargin(): number {
    if (!this.position) return 0;
    return Math.abs(this.position.qty * this.position.avgPrice * CONTRACT_SIZE) / LEVERAGE;
  }

  protected pushRealtimeQuote(bar: TvBar | null, symbol?: string): void {
    if (!this.host || !bar) {
      return;
    }

    const symbols = new Set<string>();
    symbols.add(symbol ?? this.position?.symbol ?? this.orders[0]?.symbol ?? SYMBOL);
    this.realtimeSymbols.forEach((subscribed) => symbols.add(subscribed));

    symbols.forEach((quoteSymbol) => {
      this.host?.realtimeUpdate(quoteSymbol, {
        trade: bar.close,
        bid: bar.close,
        ask: bar.close,
        spread: 0,
        bid_size: 1,
        ask_size: 1,
        size: 1,
      } as any);
    });
  }

  protected getOrderHistorySnapshot(): Order[] {
    return [...this.orderHistory]
      .filter((order) => FINAL_ORDER_STATUSES.has(order.status as number))
      .sort((a, b) => (b.updateTime ?? 0) - (a.updateTime ?? 0));
  }

  protected executionsForSymbol(symbol: string): Execution[] {
    return this.executions.filter((execution) => this.isSymbolMatch(symbol, execution.symbol));
  }

  protected isSymbolMatch(requestedSymbol: string, executionSymbol: string): boolean {
    const requested = requestedSymbol.toUpperCase();
    const execution = executionSymbol.toUpperCase();
    return (
      requested === execution
      || requested.endsWith(`:${execution}`)
      || execution.endsWith(`:${requested}`)
    );
  }

  protected recordExecution(order: PlacedOrder, fillTime: number, qty: number, price: number): void {
    if (qty <= 0) {
      return;
    }

    const executionTime = this.nextExecutionTime(fillTime);
    this.executionSeq += 1;

    const execution: Execution = {
      id: `exe_${this.executionSeq}`,
      orderId: order.id,
      symbol: order.symbol,
      side: order.side as any,
      qty,
      price,
      time: executionTime,
      commission: this.calculateCommission(qty),
    };

    this.executions.push(execution);
    this.host?.executionUpdate(execution);
  }

  protected nextExecutionTime(fillTime: number): number {
    const normalizedFillTime = Number.isFinite(fillTime) ? Math.trunc(fillTime) : Date.now();
    const nextTime = Math.max(normalizedFillTime, this.lastExecutionTime + 1);
    this.lastExecutionTime = nextTime;
    return nextTime;
  }

  protected updateSummaryValues(): void {
    if (this.summaryBalance) {
      this.summaryBalance.setValue(this.balance, true);
    }
    if (this.summaryEquity) {
      this.summaryEquity.setValue(this.equity, true);
    }
    if (this.summaryMargin) {
      this.summaryMargin.setValue(this.calculateUsedMargin(), true);
    }
  }

  protected publishAccountState(): void {
    this.host?.equityUpdate(this.equity);
    this.host?.marginAvailableUpdate(this.equity - this.calculateUsedMargin());
    this.updateSummaryValues();
    this.emitSnapshot();
  }

  protected safeHostCall(action: () => void): void {
    try {
      action();
    } catch (error) {
      console.warn('Broker host call failed during lifecycle transition:', error);
    }
  }

  protected syncHostState(): void {
    if (!this.host) {
      return;
    }

    this.safeHostCall(() => this.host?.ordersFullUpdate());
    this.safeHostCall(() => this.host?.positionsFullUpdate());

    if (this.position) {
      this.safeHostCall(() => this.host?.positionUpdate(this.toExternalPosition(this.position)!));
      this.publishPositionPnl();
      if (this.position.takeProfit !== undefined) {
        this.safeHostCall(() => this.host?.orderUpdate(this.createBracketOrder('tp', this.position, this.position.takeProfit, ORDER_TYPE_LIMIT) as any));
      }
      if (this.position.stopLoss !== undefined) {
        this.safeHostCall(() => this.host?.orderUpdate(this.createBracketOrder('sl', this.position, this.position.stopLoss, ORDER_TYPE_STOP) as any));
      }
    }

    this.pushRealtimeQuote(this.lastBar ?? this.datafeed.getCurrentBar());
    this.publishAccountState();
  }

  protected recordFinalOrder(order: Order): void {
    const normalizedOrder: Order = {
      ...(order as any),
      updateTime: order.updateTime ?? this.lastBar?.time ?? Date.now(),
    } as Order;

    const alreadyExists = this.orderHistory.some((item) => (
      item.id === order.id
      && item.status === order.status
      && (item.updateTime ?? 0) === (normalizedOrder.updateTime ?? 0)
    ));

    if (!alreadyExists) {
      this.orderHistory.push(normalizedOrder);
    }

    this.host?.orderUpdate(normalizedOrder);
  }

  protected emitSnapshot(): void {
    const snapshot = this.getSnapshot();
    this.listeners.forEach((listener) => listener(snapshot));
  }
}
