import type {
  AccountId,
  AccountManagerInfo,
  BrokerConfigFlags,
  IBrokerConnectionAdapterHost,
  IBrokerTerminal,
  InstrumentInfo,
  Order,
  PlaceOrderResult,
  PlacedOrder,
  Position,
  PreOrder,
  SingleBrokerMetaInfo,
} from '../charting_library';
import type { TvBar } from '../utils/csvParser';
import CustomDatafeed from '../utils/datafeed';

const ACCOUNT_ID = 'demo-account-1' as unknown as AccountId;
const ACCOUNT_TITLE = 'FX Hero Demo';
const SYMBOL = 'FX_GAME';
const CONTRACT_SIZE = 100000;
const FIX_COMMISSION = 6;

const CONNECTION_STATUS_CONNECTED = 1;
const ORDER_STATUS_CANCELED = 1;
const ORDER_STATUS_FILLED = 2;
const ORDER_TYPE_LIMIT = 1;
const ORDER_TYPE_MARKET = 2;
const ORDER_TYPE_STOP = 3;
const SIDE_BUY = 1;
const SIDE_SELL = -1;

const FORMATTERS = {
  fixedInCurrency: 'fixedInCurrency',
  text: 'text',
  symbol: 'symbol',
  side: 'side',
  positionSide: 'positionSide',
  formatQuantity: 'formatQuantity',
  status: 'status',
  formatPrice: 'formatPrice',
} as const;

type TradeRecord = {
  id: string;
  type: 'LONG' | 'SHORT';
  entryTime: number;
  entryPrice: number;
  exitTime: number;
  exitPrice: number;
  pnl: number;
  commission: number;
  netPnl: number;
};

type InternalPosition = {
  id: string;
  symbol: string;
  side: number;
  qty: number;
  avgPrice: number;
  updateTime: number;
  entryTime: number;
};

export type BrokerSnapshot = {
  balance: number;
  equity: number;
  floatingPnl: number;
  position: Position | null;
  trades: TradeRecord[];
};

export class LocalCsvBroker {
  private readonly datafeed: CustomDatafeed;
  private readonly initialBalance: number;

  private host: IBrokerConnectionAdapterHost | null = null;
  private currentOrderSeq = 0;
  private position: InternalPosition | null = null;
  private orders: Order[] = [];
  private orderHistory: Order[] = [];
  private trades: TradeRecord[] = [];

  private balance: number;
  private equity: number;
  private floatingPnl = 0;

  private summaryBalance: any;
  private summaryEquity: any;

  private listeners = new Set<(snapshot: BrokerSnapshot) => void>();

  private readonly onSimulationBar = (bar: TvBar) => {
    if (!this.position) {
      this.floatingPnl = 0;
      this.equity = this.balance;
      this.host?.equityUpdate(this.equity);
      this.emitSnapshot();
      return;
    }

    this.floatingPnl = this.calculateFloatingPnl(this.position, bar.close);
    this.equity = this.balance + this.floatingPnl;

    this.host?.plUpdate(this.position.id, this.floatingPnl);
    this.host?.equityUpdate(this.equity);
    this.updateSummaryValues();
    this.emitSnapshot();
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
  }

  public reset(): void {
    this.currentOrderSeq = 0;
    this.position = null;
    this.orders = [];
    this.orderHistory = [];
    this.trades = [];
    this.balance = this.initialBalance;
    this.equity = this.initialBalance;
    this.floatingPnl = 0;

    this.host?.ordersFullUpdate();
    this.host?.positionsFullUpdate();
    this.host?.equityUpdate(this.equity);
    this.updateSummaryValues();
    this.emitSnapshot();
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
      supportOrderBrackets: false,
      supportPositionBrackets: false,
      supportEditAmount: true,
      supportModifyOrderPrice: true,
      supportModifyBrackets: false,
      supportPLUpdate: true,
      supportMargin: false,
      supportLeverage: false,
      supportSymbolSearch: false,
      supportExecutions: false,
    };

    return {
      configFlags,
    };
  }

  public createBrokerFactory(): (host: IBrokerConnectionAdapterHost) => IBrokerTerminal {
    return (host: IBrokerConnectionAdapterHost) => {
      const safeHost = host ?? null;
      this.host = safeHost;

      // Avoid calling host.connectionStatusUpdate during factory creation.
      // Some runtime paths call broker_factory before host is fully prepared.
      if (safeHost?.factory?.createWatchedValue) {
        this.summaryBalance = safeHost.factory.createWatchedValue(this.balance);
        this.summaryEquity = safeHost.factory.createWatchedValue(this.equity);
      } else {
        this.summaryBalance = null;
        this.summaryEquity = null;
      }

      const brokerImpl = {
        chartContextMenuActions: async (_context: unknown, options?: unknown) => {
          if (!this.host) {
            return [];
          }
          return this.host.defaultContextMenuActions(_context as never, options as never);
        },
        isTradable: async (_symbol: string) => true,
        connectionStatus: () => CONNECTION_STATUS_CONNECTED,
        orders: async () => [...this.orders],
        ordersHistory: async () => [...this.orderHistory],
        positions: async () => {
          const pos = this.toExternalPosition(this.position);
          return pos ? [pos] : [];
        },
        executions: async (_symbol: string) => [],
        symbolInfo: async (_symbol: string): Promise<InstrumentInfo> => ({
          qty: {
            min: 0.01,
            max: 100,
            step: 0.01,
            default: 1,
          },
          pipValue: 10,
          pipSize: 0.0001,
          minTick: 0.0001,
          type: 'forex',
          brokerSymbol: SYMBOL,
          description: 'CSV Replay Instrument',
          currency: 'USD',
          allowedOrderTypes: [ORDER_TYPE_MARKET, ORDER_TYPE_LIMIT, ORDER_TYPE_STOP] as any,
        }),
        accountManagerInfo: (): AccountManagerInfo => this.buildAccountManagerInfo(),
        accountsMetainfo: async () => [{
          id: ACCOUNT_ID,
          name: ACCOUNT_TITLE,
          type: 'demo',
          currency: 'USD',
        }],
        currentAccount: () => ACCOUNT_ID,
        placeOrder: async (order: PreOrder): Promise<PlaceOrderResult> => {
          const bar = this.datafeed.getCurrentBar();
          if (!bar) {
            throw new Error('No current bar available for execution');
          }

          const orderId = this.nextId('ord');
          const filledOrder: PlacedOrder = {
            id: orderId,
            symbol: order.symbol,
            type: order.type,
            side: order.side,
            qty: order.qty,
            status: ORDER_STATUS_FILLED as never,
            avgPrice: bar.close,
            filledQty: order.qty,
            updateTime: bar.time,
            limitPrice: order.limitPrice,
            stopPrice: order.stopPrice,
          };

          this.orderHistory.push(filledOrder);
          this.host?.orderUpdate(filledOrder);

          this.applyFilledOrder(filledOrder, bar.time, Boolean(order.isClose));
          return { orderId };
        },
        modifyOrder: async (order: Order) => {
          const idx = this.orders.findIndex((item) => item.id === order.id);
          if (idx >= 0) {
            this.orders[idx] = order;
            this.host?.orderUpdate(order);
          }
        },
        cancelOrder: async (orderId: string) => {
          const idx = this.orders.findIndex((item) => item.id === orderId);
          if (idx >= 0) {
            const order = this.orders[idx] as any;
            order.status = ORDER_STATUS_CANCELED;
            order.updateTime = Date.now();
            this.orders.splice(idx, 1);
            this.orderHistory.push(order);
            this.host?.orderUpdate(order);
          }
        },
        closePosition: async (positionId: string, amount?: number) => {
          if (!this.position || this.position.id !== positionId) {
            return;
          }
          const qty = Math.min(amount ?? this.position.qty, this.position.qty);
          const closeSide = this.position.side === SIDE_BUY ? SIDE_SELL : SIDE_BUY;
          await (brokerImpl as any).placeOrder({
            symbol: this.position.symbol,
            type: ORDER_TYPE_MARKET,
            side: closeSide,
            qty,
            isClose: true,
          } as PreOrder);
        },
        reversePosition: async (positionId: string) => {
          if (!this.position || this.position.id !== positionId) {
            return;
          }
          const reverseSide = this.position.side === SIDE_BUY ? SIDE_SELL : SIDE_BUY;
          await (brokerImpl as any).placeOrder({
            symbol: this.position.symbol,
            type: ORDER_TYPE_MARKET,
            side: reverseSide,
            qty: this.position.qty * 2,
          } as PreOrder);
        },
        subscribeEquity: () => {
          this.host?.equityUpdate(this.equity);
        },
        unsubscribeEquity: () => undefined,
      };

      return brokerImpl as unknown as IBrokerTerminal;
    };
  }

  private buildAccountManagerInfo(): AccountManagerInfo {
    return {
      accountTitle: ACCOUNT_TITLE,
      summary: [
        {
          text: 'Balance',
          wValue: this.summaryBalance,
          formatter: FORMATTERS.fixedInCurrency as any,
          isDefault: true,
        },
        {
          text: 'Equity',
          wValue: this.summaryEquity,
          formatter: FORMATTERS.fixedInCurrency as any,
          isDefault: true,
        },
      ],
      orderColumns: [
        { id: 'id', label: 'ID', dataFields: ['id'], formatter: FORMATTERS.text as any },
        { id: 'symbol', label: 'Symbol', dataFields: ['symbol'], formatter: FORMATTERS.symbol as any },
        { id: 'side', label: 'Side', dataFields: ['side'], formatter: FORMATTERS.side as any },
        { id: 'qty', label: 'Qty', dataFields: ['qty'], formatter: FORMATTERS.formatQuantity as any },
        { id: 'status', label: 'Status', dataFields: ['status'], formatter: FORMATTERS.status as any },
      ] as any,
      positionColumns: [
        { id: 'symbol', label: 'Symbol', dataFields: ['symbol'], formatter: FORMATTERS.symbol as any },
        { id: 'side', label: 'Side', dataFields: ['side'], formatter: FORMATTERS.positionSide as any },
        { id: 'qty', label: 'Qty', dataFields: ['qty'], formatter: FORMATTERS.formatQuantity as any },
        { id: 'avgPrice', label: 'Avg', dataFields: ['avgPrice'], formatter: FORMATTERS.formatPrice as any },
      ] as any,
      historyColumns: [
        { id: 'id', label: 'ID', dataFields: ['id'], formatter: FORMATTERS.text as any },
        { id: 'symbol', label: 'Symbol', dataFields: ['symbol'], formatter: FORMATTERS.symbol as any },
        { id: 'side', label: 'Side', dataFields: ['side'], formatter: FORMATTERS.side as any },
        { id: 'qty', label: 'Qty', dataFields: ['qty'], formatter: FORMATTERS.formatQuantity as any },
        { id: 'status', label: 'Status', dataFields: ['status'], formatter: FORMATTERS.status as any },
      ] as any,
      pages: [],
    };
  }

  private nextId(prefix: string): string {
    this.currentOrderSeq += 1;
    return `${prefix}_${this.currentOrderSeq}`;
  }

  private toExternalPosition(position: InternalPosition | null): Position | null {
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
    };
  }

  private applyFilledOrder(order: PlacedOrder, fillTime: number, isCloseOrder: boolean): void {
    if (!this.position) {
      this.position = {
        id: this.nextId('pos'),
        symbol: order.symbol,
        side: order.side,
        qty: order.qty,
        avgPrice: order.avgPrice ?? 0,
        updateTime: fillTime,
        entryTime: fillTime,
      };
      this.floatingPnl = 0;
      this.equity = this.balance;
      this.host?.positionUpdate(this.toExternalPosition(this.position)!);
      this.host?.equityUpdate(this.equity);
      this.updateSummaryValues();
      this.emitSnapshot();
      return;
    }

    const current = this.position;
    const sameSide = current.side === order.side;

    if (sameSide && !isCloseOrder) {
      const nextQty = current.qty + order.qty;
      const fillPrice = order.avgPrice ?? current.avgPrice;
      current.avgPrice = (current.avgPrice * current.qty + fillPrice * order.qty) / nextQty;
      current.qty = nextQty;
      current.updateTime = fillTime;
      this.host?.positionUpdate(this.toExternalPosition(current)!);
      this.emitSnapshot();
      return;
    }

    const fillPrice = order.avgPrice ?? current.avgPrice;
    const closeQty = Math.min(order.qty, current.qty);
    const pnl = this.calculateClosedPnl(current.side, current.avgPrice, fillPrice, closeQty);
    const netPnl = pnl - FIX_COMMISSION;

    this.balance += netPnl;
    this.orderHistory.push({
      ...order,
      status: ORDER_STATUS_FILLED as never,
      updateTime: fillTime,
    });

    const trade: TradeRecord = {
      id: current.id,
      type: current.side === SIDE_BUY ? 'LONG' : 'SHORT',
      entryTime: current.entryTime,
      entryPrice: current.avgPrice,
      exitTime: fillTime,
      exitPrice: fillPrice,
      pnl,
      commission: FIX_COMMISSION,
      netPnl,
    };
    this.trades.push(trade);

    const remaining = current.qty - closeQty;
    if (remaining > 0 && order.qty <= current.qty) {
      current.qty = remaining;
      current.updateTime = fillTime;
      this.host?.positionUpdate(this.toExternalPosition(current)!);
    } else if (order.qty > current.qty) {
      const openQty = order.qty - current.qty;
      this.position = {
        id: this.nextId('pos'),
        symbol: order.symbol,
        side: order.side,
        qty: openQty,
        avgPrice: fillPrice,
        updateTime: fillTime,
        entryTime: fillTime,
      };
      this.host?.positionsFullUpdate();
      this.host?.positionUpdate(this.toExternalPosition(this.position)!);
    } else {
      this.position = null;
      this.host?.positionsFullUpdate();
    }

    this.floatingPnl = this.position ? this.calculateFloatingPnl(this.position, fillPrice) : 0;
    this.equity = this.balance + this.floatingPnl;
    this.host?.equityUpdate(this.equity);
    this.updateSummaryValues();
    this.emitSnapshot();
  }

  private calculateFloatingPnl(position: InternalPosition, currentPrice: number): number {
    const diff = currentPrice - position.avgPrice;
    const signedDiff = position.side === SIDE_BUY ? diff : -diff;
    return signedDiff * CONTRACT_SIZE * position.qty;
  }

  private calculateClosedPnl(side: number, entryPrice: number, exitPrice: number, qty: number): number {
    const diff = exitPrice - entryPrice;
    const signedDiff = side === SIDE_BUY ? diff : -diff;
    return signedDiff * CONTRACT_SIZE * qty;
  }

  private updateSummaryValues(): void {
    if (this.summaryBalance) {
      this.summaryBalance.setValue(this.balance, true);
    }
    if (this.summaryEquity) {
      this.summaryEquity.setValue(this.equity, true);
    }
  }

  private emitSnapshot(): void {
    const snapshot = this.getSnapshot();
    this.listeners.forEach((listener) => listener(snapshot));
  }
}
