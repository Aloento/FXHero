import type {
  AccountId,
  AccountManagerInfo,
  BrokerConfigFlags,
  Execution,
  IBrokerConnectionAdapterHost,
  IBrokerTerminal,
  InstrumentInfo,
  LeverageInfo,
  LeverageInfoParams,
  LeveragePreviewResult,
  LeverageSetParams,
  LeverageSetResult,
  Order,
  OrderPreviewResult,
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
const COMMISSION_PER_LOT = 6;
const LEVERAGE = 500;

const CONNECTION_STATUS_CONNECTED = 1;
const ORDER_STATUS_CANCELED = 1;
const ORDER_STATUS_FILLED = 2;
const ORDER_STATUS_REJECTED = 5;
const ORDER_STATUS_WORKING = 6;
const ORDER_TYPE_LIMIT = 1;
const ORDER_TYPE_MARKET = 2;
const ORDER_TYPE_STOP = 3;
const SIDE_BUY = 1;
const SIDE_SELL = -1;
const PARENT_TYPE_POSITION = 2;
const FINAL_ORDER_STATUSES = new Set([ORDER_STATUS_CANCELED, ORDER_STATUS_FILLED, ORDER_STATUS_REJECTED]);

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

export type TradeRecord = {
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
  takeProfit?: number;
  stopLoss?: number;
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
  private executions: Execution[] = [];
  private trades: TradeRecord[] = [];

  private balance: number;
  private equity: number;
  private floatingPnl = 0;

  private summaryBalance: any;
  private summaryEquity: any;
  private summaryMargin: any;

  private listeners = new Set<(snapshot: BrokerSnapshot) => void>();

  private readonly onSimulationBar = (bar: TvBar) => {
    // Keep order ticket quotes in sync with the simulated market.
    this.pushRealtimeQuote(bar);

    // Process pending limit/stop orders
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
        const orderIdx = this.orders.findIndex(o => o.id === order.id);
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
  }

  public reset(): void {
    this.currentOrderSeq = 0;
    this.position = null;
    this.orders = [];
    this.orderHistory = [];
    this.executions = [];
    this.trades = [];
    this.balance = this.initialBalance;
    this.equity = this.initialBalance;
    this.floatingPnl = 0;

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
    }
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
      supportLeverage: true,
      supportPlaceOrderPreview: true,
      supportSymbolSearch: false,
      supportExecutions: true,
    };

    return {
      configFlags,
    };
  }

  public createBrokerFactory(): (host: IBrokerConnectionAdapterHost) => IBrokerTerminal {
    return (host: IBrokerConnectionAdapterHost) => {
      const safeHost = host ?? null;
      this.host = safeHost;


      const brokerImpl = {
        chartContextMenuActions: async (_context: unknown, options?: unknown) => {
          if (!this.host) {
            return [];
          }
          return this.host.defaultContextMenuActions(_context as never, options as never);
        },
        isTradable: async (_symbol: string) => true,
        leverageInfo: async (leverageInfoParams: LeverageInfoParams): Promise<LeverageInfo> => ({
          title: 'Leverage',
          leverage: LEVERAGE,
          min: 1,
          max: 500,
          step: 1,
        }),
        setLeverage: async (leverageSetParams: LeverageSetParams): Promise<LeverageSetResult> => {
          return { leverage: leverageSetParams.leverage };
        },
        previewLeverage: async (leverageSetParams: LeverageSetParams): Promise<LeveragePreviewResult> => {
          return { infos: [`Set leverage to ${leverageSetParams.leverage}x`] };
        },
        connectionStatus: () => CONNECTION_STATUS_CONNECTED,
        orders: async () => {
          const allOrders = [...this.orders];
          if (this.position) {
            if (this.position.takeProfit !== undefined) {
              allOrders.push(this.createBracketOrder('tp', this.position, this.position.takeProfit, ORDER_TYPE_LIMIT) as any);
            }
            if (this.position.stopLoss !== undefined) {
              allOrders.push(this.createBracketOrder('sl', this.position, this.position.stopLoss, ORDER_TYPE_STOP) as any);
            }
          }
          return allOrders;
        },
        ordersHistory: async () => [...this.orderHistory],
        positions: async () => {
          const pos = this.toExternalPosition(this.position);
          return pos ? [pos] : [];
        },
        executions: async (symbol: string) => this.executionsForSymbol(symbol),
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
        previewOrder: async (order: PreOrder): Promise<OrderPreviewResult> => {
          const bar = this.datafeed.getCurrentBar();
          const price = order.type === ORDER_TYPE_MARKET ? (bar?.close || 0) : (order.limitPrice ?? order.stopPrice ?? bar?.close ?? 0);
          const requiredMargin = (order.qty * CONTRACT_SIZE * price) / LEVERAGE;
          const currentAvailable = this.equity - this.calculateUsedMargin();
          const commission = this.calculateCommission(order.qty);

          const result: OrderPreviewResult = {
            sections: [
              {
                header: 'Margin & Fees Check',
                rows: [
                  { title: 'Required Margin', value: `$${requiredMargin.toFixed(2)}` },
                  { title: 'Available Margin', value: `$${currentAvailable.toFixed(2)}` },
                  { title: 'Commission', value: `$${commission.toFixed(2)}` },
                ],
              },
            ],
            errors: [],
          };

          if (requiredMargin > currentAvailable) {
            result.errors?.push(`Insufficient margin. Required: $${requiredMargin.toFixed(2)}, Available: $${currentAvailable.toFixed(2)}`);
          }

          return result;
        },
        placeOrder: async (order: PreOrder): Promise<PlaceOrderResult> => {
          const bar = this.datafeed.getCurrentBar();
          if (!bar) {
            throw new Error('No current bar available for execution');
          }

          this.pushRealtimeQuote(bar, order.symbol);

          if (!(order as any).isClose) {
            // Margin check
            const price = order.type === ORDER_TYPE_MARKET ? bar.close : (order.limitPrice ?? order.stopPrice ?? bar.close);
            const requiredMargin = (order.qty * CONTRACT_SIZE * price) / LEVERAGE;
            const currentAvailable = this.equity - this.calculateUsedMargin();
            if (requiredMargin > currentAvailable) {
              return Promise.reject(new Error(`可用资金不足。开仓所需保证金: $${requiredMargin.toFixed(2)} (500x杠杆)`));
            }
          }

          const orderId = this.nextId('ord');

          if (order.type === ORDER_TYPE_MARKET || (order as any).isClose) {
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
              takeProfit: this.normalizeBracketPrice(order.takeProfit),
              stopLoss: this.normalizeBracketPrice(order.stopLoss),
            };

            this.recordFinalOrder(filledOrder);

            this.applyFilledOrder(filledOrder, bar.time, Boolean((order as any).isClose));
          } else {
            const workingOrder = {
              id: orderId,
              symbol: order.symbol,
              type: order.type,
              side: order.side,
              qty: order.qty,
              status: ORDER_STATUS_WORKING as any,
              updateTime: bar.time,
              limitPrice: order.limitPrice,
              stopPrice: order.stopPrice,
              takeProfit: this.normalizeBracketPrice(order.takeProfit),
              stopLoss: this.normalizeBracketPrice(order.stopLoss),
              isClose: (order as any).isClose,
            } as Order;

            this.orders.push(workingOrder);
            this.host?.orderUpdate(workingOrder);
          }

          return { orderId };
        },
        modifyOrder: async (order: Order) => {
          const idx = this.orders.findIndex((item) => item.id === order.id);
          if (idx >= 0) {
            this.orders[idx] = order;
            this.host?.orderUpdate(order);
          } else if (this.position && order.parentId === this.position.id) {
            // Modify position brackets
            if (order.id.startsWith('tp_')) {
              this.position.takeProfit = this.normalizeBracketPrice(order.limitPrice);
              this.position.updateTime = Date.now();
            } else if (order.id.startsWith('sl_')) {
              this.position.stopLoss = this.normalizeBracketPrice(order.stopPrice);
              this.position.updateTime = Date.now();
            }
            this.host?.positionUpdate(this.toExternalPosition(this.position)!);
            this.host?.orderUpdate(order);

            // Re-evaluate in case new bracket is triggered immediately
            const currentBar = this.datafeed.getCurrentBar();
            if (currentBar) {
              const triggeredPrice = this.getTriggeredBracketPrice(this.position, currentBar);
              if (triggeredPrice !== null) {
                this.executeBracketClose(triggeredPrice, currentBar.time);
              } else {
                this.position.updateTime = currentBar.time;
                this.floatingPnl = this.calculateFloatingPnl(this.position, currentBar.close);
                this.equity = this.balance + this.floatingPnl;
                this.publishPositionPnl();
                this.publishAccountState();
              }
            }
          }
        },
        cancelOrder: async (orderId: string) => {
          const idx = this.orders.findIndex((item) => item.id === orderId);
          if (idx >= 0) {
            const order = this.orders[idx] as any;
            order.status = ORDER_STATUS_CANCELED;
            order.updateTime = Date.now();
            this.orders.splice(idx, 1);
            this.recordFinalOrder(order);
          } else if (this.position) {
            let canceledOrder: Order | null = null;
            if (orderId === `tp_${this.position.id}`) {
              canceledOrder = this.createBracketOrder('tp', this.position, this.position.takeProfit!, ORDER_TYPE_LIMIT);
              this.position.takeProfit = undefined;
              this.position.updateTime = Date.now();
            } else if (orderId === `sl_${this.position.id}`) {
              canceledOrder = this.createBracketOrder('sl', this.position, this.position.stopLoss!, ORDER_TYPE_STOP);
              this.position.stopLoss = undefined;
              this.position.updateTime = Date.now();
            }
            if (canceledOrder) {
              (canceledOrder as any).status = ORDER_STATUS_CANCELED;
              (canceledOrder as any).updateTime = Date.now();
              this.host?.positionUpdate(this.toExternalPosition(this.position)!);
              this.recordFinalOrder(canceledOrder);
            }
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
        editPositionBrackets: async (positionId: string, brackets: any) => {
          if (!this.position || this.position.id !== positionId) {
            return;
          }

          const prevTp = this.position.takeProfit;
          const prevSl = this.position.stopLoss;

          this.position.takeProfit = this.normalizeBracketPrice(brackets.takeProfit);
          this.position.stopLoss = this.normalizeBracketPrice(brackets.stopLoss);
          this.position.updateTime = Date.now();

          this.host?.positionUpdate(this.toExternalPosition(this.position)!);

          if (this.position.takeProfit !== undefined) {
            this.host?.orderUpdate(this.createBracketOrder('tp', this.position, this.position.takeProfit, ORDER_TYPE_LIMIT) as any);
          } else if (prevTp !== undefined) {
            const canceledOrder = this.createBracketOrder('tp', this.position, prevTp, ORDER_TYPE_LIMIT);
            canceledOrder.status = ORDER_STATUS_CANCELED as any;
            canceledOrder.updateTime = Date.now();
            this.recordFinalOrder(canceledOrder as any);
          }

          if (this.position.stopLoss !== undefined) {
            this.host?.orderUpdate(this.createBracketOrder('sl', this.position, this.position.stopLoss, ORDER_TYPE_STOP) as any);
          } else if (prevSl !== undefined) {
            const canceledOrder = this.createBracketOrder('sl', this.position, prevSl, ORDER_TYPE_STOP);
            canceledOrder.status = ORDER_STATUS_CANCELED as any;
            canceledOrder.updateTime = Date.now();
            this.recordFinalOrder(canceledOrder as any);
          }

          const currentBar = this.datafeed.getCurrentBar();
          if (currentBar) {
            const triggeredPrice = this.getTriggeredBracketPrice(this.position, currentBar);
            if (triggeredPrice !== null) {
              this.executeBracketClose(triggeredPrice, currentBar.time);
              return;
            }

            this.position.updateTime = currentBar.time;
            this.floatingPnl = this.calculateFloatingPnl(this.position, currentBar.close);
            this.equity = this.balance + this.floatingPnl;
            this.publishPositionPnl();
          }

          this.publishAccountState();
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
          this.pushRealtimeQuote(this.datafeed.getCurrentBar());
        },
        unsubscribeEquity: () => undefined,
        subscribeMarginAvailable: (symbol: string) => {
          this.host?.marginAvailableUpdate(this.equity - this.calculateUsedMargin());
          this.pushRealtimeQuote(this.datafeed.getCurrentBar(), symbol);
        },
        unsubscribeMarginAvailable: (_symbol: string) => undefined,
        subscribeRealtime: (symbol: string) => {
          this.pushRealtimeQuote(this.datafeed.getCurrentBar(), symbol);
        },
        unsubscribeRealtime: () => undefined,
      };

      return brokerImpl as unknown as IBrokerTerminal;
    };
  }

  private buildAccountManagerInfo(): AccountManagerInfo {
    if (!this.summaryBalance && this.host?.factory?.createWatchedValue) {
      this.summaryBalance = this.host.factory.createWatchedValue(this.balance);
    }
    if (!this.summaryEquity && this.host?.factory?.createWatchedValue) {
      this.summaryEquity = this.host.factory.createWatchedValue(this.equity);
    }
    if (!this.summaryMargin && this.host?.factory?.createWatchedValue) {
      this.summaryMargin = this.host.factory.createWatchedValue(this.calculateUsedMargin());
    }

    return {
      accountTitle: ACCOUNT_TITLE,
      marginUsed: this.summaryMargin,
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
        {
          text: 'Margin Used',
          wValue: this.summaryMargin,
          formatter: FORMATTERS.fixedInCurrency as any,
          isDefault: true,
        }
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
        { id: 'pl', label: 'Profit', dataFields: ['pl'], formatter: FORMATTERS.fixedInCurrency as any },
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

  private createBracketOrder(prefix: string, position: InternalPosition, price: number, type: number): Order {
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

  private executeBracketClose(price: number, time: number): void {
    if (!this.position) return;

    const fillPrice = price;
    const closeQty = this.position.qty;
    const side = this.position.side;

    // Create fill order for record
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
      pl: this.floatingPnl,
    } as unknown as Position;
  }

  private applyFilledOrder(order: PlacedOrder, fillTime: number, isCloseOrder: boolean): void {
    this.recordExecution(order, fillTime);

    if (!this.position) {
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

      // Emit initial brackets
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

      // Update brackets on chart
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

      // Keep brackets updated if position partially closes
      if (current.takeProfit !== undefined) {
        this.host?.orderUpdate(this.createBracketOrder('tp', current, current.takeProfit, ORDER_TYPE_LIMIT) as any);
      }
      if (current.stopLoss !== undefined) {
        this.host?.orderUpdate(this.createBracketOrder('sl', current, current.stopLoss, ORDER_TYPE_STOP) as any);
      }
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
        takeProfit: this.normalizeBracketPrice(order.takeProfit),
        stopLoss: this.normalizeBracketPrice(order.stopLoss),
      };
      this.host?.positionsFullUpdate();
      this.host?.positionUpdate(this.toExternalPosition(this.position)!);

      // Update brackets on chart
      if (this.position.takeProfit !== undefined) {
        this.host?.orderUpdate(this.createBracketOrder('tp', this.position, this.position.takeProfit, ORDER_TYPE_LIMIT) as any);
      }
      if (this.position.stopLoss !== undefined) {
        this.host?.orderUpdate(this.createBracketOrder('sl', this.position, this.position.stopLoss, ORDER_TYPE_STOP) as any);
      }
    } else {
      this.position = null;
      this.host?.positionsFullUpdate();
      this.host?.ordersFullUpdate(); // This will clear previous bracket lines
    }

    this.floatingPnl = this.position ? this.calculateFloatingPnl(this.position, fillPrice) : 0;
    this.equity = this.balance + this.floatingPnl;
    this.publishPositionPnl();
    this.publishAccountState();
  }

  private getTriggeredBracketPrice(position: InternalPosition, bar: TvBar): number | null {
    const takeProfit = this.normalizeBracketPrice(position.takeProfit);
    const stopLoss = this.normalizeBracketPrice(position.stopLoss);

    if (position.side === SIDE_BUY) {
      if (takeProfit !== undefined && bar.high >= takeProfit) {
        return takeProfit;
      }
      if (stopLoss !== undefined && bar.low <= stopLoss) {
        return stopLoss;
      }
      return null;
    }

    if (takeProfit !== undefined && bar.low <= takeProfit) {
      return takeProfit;
    }
    if (stopLoss !== undefined && bar.high >= stopLoss) {
      return stopLoss;
    }
    return null;
  }

  private publishPositionPnl(): void {
    if (!this.position) {
      return;
    }

    this.host?.plUpdate(this.position.id, this.floatingPnl);
    this.host?.positionPartialUpdate(this.position.id, {
      pl: this.floatingPnl,
      updateTime: this.position.updateTime,
    } as Partial<Position>);
  }

  private normalizeBracketPrice(price: unknown): number | undefined {
    if (price === null || price === undefined || price === '') {
      return undefined;
    }

    const normalized = this.extractPriceValue(price);
    return Number.isFinite(normalized) ? normalized : undefined;
  }

  private extractPriceValue(raw: unknown): number {
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

  private calculateCommission(qty: number): number {
    return COMMISSION_PER_LOT * qty;
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

  private calculateUsedMargin(): number {
    if (!this.position) return 0;
    // Calculation: Math.abs(qty * avgPrice * CONTRACT_SIZE) / LEVERAGE
    return Math.abs(this.position.qty * this.position.avgPrice * CONTRACT_SIZE) / LEVERAGE;
  }

  private pushRealtimeQuote(bar: TvBar | null, symbol?: string): void {
    if (!this.host || !bar) {
      return;
    }

    const quoteSymbol = symbol ?? this.position?.symbol ?? this.orders[0]?.symbol ?? SYMBOL;
    this.host.realtimeUpdate(quoteSymbol, {
      trade: bar.close,
      bid: bar.close,
      ask: bar.close,
      spread: 0,
      bid_size: 1,
      ask_size: 1,
      size: 1,
    } as any);
  }

  private executionsForSymbol(symbol: string): Execution[] {
    return this.executions.filter((execution) => this.isSymbolMatch(symbol, execution.symbol));
  }

  private isSymbolMatch(requestedSymbol: string, executionSymbol: string): boolean {
    const requested = requestedSymbol.toUpperCase();
    const execution = executionSymbol.toUpperCase();
    return (
      requested === execution ||
      requested.endsWith(`:${execution}`) ||
      execution.endsWith(`:${requested}`)
    );
  }

  private recordExecution(order: PlacedOrder, fillTime: number): void {
    const execution: Execution = {
      symbol: order.symbol,
      side: order.side as any,
      qty: order.qty,
      price: order.avgPrice ?? this.datafeed.getCurrentBar()?.close ?? 0,
      time: fillTime,
      commission: this.calculateCommission(order.qty),
    };

    this.executions.push(execution);
    this.host?.executionUpdate(execution);
  }

  private updateSummaryValues(): void {
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

  private publishAccountState(): void {
    this.host?.equityUpdate(this.equity);
    this.host?.marginAvailableUpdate(this.equity - this.calculateUsedMargin());
    this.updateSummaryValues();
    this.emitSnapshot();
  }

  private recordFinalOrder(order: Order): void {
    const alreadyExists = this.orderHistory.some((item) => (
      item.id === order.id
      && item.status === order.status
      && (item.updateTime ?? 0) === (order.updateTime ?? 0)
    ));

    if (!alreadyExists) {
      this.orderHistory.push(order);
    }

    this.host?.orderUpdate(order);
    if (FINAL_ORDER_STATUSES.has(order.status as number)) {
      this.host?.ordersFullUpdate();
    }
  }

  private emitSnapshot(): void {
    const snapshot = this.getSnapshot();
    this.listeners.forEach((listener) => listener(snapshot));
  }
}
