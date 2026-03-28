import type {
  AccountManagerInfo,
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
  PreOrder,
} from '../charting_library';
import CustomDatafeed from '../utils/datafeed';
import {
  ACCOUNT_ID,
  ACCOUNT_TITLE,
  CONNECTION_STATUS_CONNECTED,
  CONTRACT_SIZE,
  FORMATTERS,
  LEVERAGE,
  ORDER_STATUS_CANCELED,
  ORDER_STATUS_FILLED,
  ORDER_STATUS_WORKING,
  ORDER_TYPE_LIMIT,
  ORDER_TYPE_MARKET,
  ORDER_TYPE_STOP,
  SIDE_BUY,
  SIDE_SELL,
  SYMBOL,
} from './constants';
import { LocalCsvBrokerCore } from './LocalCsvBrokerCore';

export class LocalCsvBroker extends LocalCsvBrokerCore {
  public constructor(datafeed: CustomDatafeed, initialBalance = 1000) {
    super(datafeed, initialBalance);
  }

  public createBrokerFactory(): (host: IBrokerConnectionAdapterHost) => IBrokerTerminal {
    return (host: IBrokerConnectionAdapterHost) => {
      this.host = host ?? null;

      // TradingView may call brokerFactory before internal update hooks are wired.
      // Defer initial synchronization to avoid hitting undefined callbacks.
      setTimeout(() => {
        this.syncHostState();
      }, 0);

      const brokerImpl = {
        chartContextMenuActions: async (_context: unknown, options?: unknown) => {
          if (!this.host) {
            return [];
          }
          return this.host.defaultContextMenuActions(_context as never, options as never);
        },
        isTradable: async (_symbol: string) => true,
        leverageInfo: async (_leverageInfoParams: LeverageInfoParams): Promise<LeverageInfo> => ({
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
        ordersHistory: async () => this.getOrderHistorySnapshot(),
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
          const price = order.type === ORDER_TYPE_MARKET
            ? (bar?.close || 0)
            : (order.limitPrice ?? order.stopPrice ?? bar?.close ?? 0);
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
            if (order.id.startsWith('tp_')) {
              this.position.takeProfit = this.resolveTakeProfitFromOrder(order);
              this.position.updateTime = Date.now();
            } else if (order.id.startsWith('sl_')) {
              this.position.stopLoss = this.resolveStopLossFromOrder(order);
              this.position.updateTime = Date.now();
            }
            this.host?.positionUpdate(this.toExternalPosition(this.position)!);
            this.host?.orderUpdate(order);

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
            if (orderId === `tp_${this.position.id}` && this.position.takeProfit !== undefined) {
              canceledOrder = this.createBracketOrder('tp', this.position, this.position.takeProfit, ORDER_TYPE_LIMIT);
              this.position.takeProfit = undefined;
              this.position.updateTime = Date.now();
            } else if (orderId === `sl_${this.position.id}` && this.position.stopLoss !== undefined) {
              canceledOrder = this.createBracketOrder('sl', this.position, this.position.stopLoss, ORDER_TYPE_STOP);
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
          this.realtimeSymbols.add(symbol);
          this.host?.marginAvailableUpdate(this.equity - this.calculateUsedMargin());
          this.pushRealtimeQuote(this.datafeed.getCurrentBar(), symbol);
        },
        unsubscribeMarginAvailable: (symbol: string) => {
          this.realtimeSymbols.delete(symbol);
        },
        subscribeRealtime: (symbol: string) => {
          this.realtimeSymbols.add(symbol);
          this.pushRealtimeQuote(this.datafeed.getCurrentBar(), symbol);
        },
        unsubscribeRealtime: () => {
          this.realtimeSymbols.clear();
        },
      };

      return brokerImpl as unknown as IBrokerTerminal;
    };
  }

  protected buildAccountManagerInfo(): AccountManagerInfo {
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
        { id: 'pl', label: 'Profit', dataFields: ['pl'], formatter: FORMATTERS.fixedInCurrency as any },
      ] as any,
      historyColumns: [
        { id: 'id', label: 'ID', dataFields: ['id'], formatter: FORMATTERS.text as any },
        { id: 'symbol', label: 'Symbol', dataFields: ['symbol'], formatter: FORMATTERS.symbol as any },
        { id: 'side', label: 'Side', dataFields: ['side'], formatter: FORMATTERS.side as any },
        { id: 'avgPrice', label: 'Price', dataFields: ['avgPrice'], formatter: FORMATTERS.formatPrice as any },
        { id: 'qty', label: 'Qty', dataFields: ['qty'], formatter: FORMATTERS.formatQuantity as any },
        { id: 'status', label: 'Status', dataFields: ['status'], formatter: FORMATTERS.status as any },
        { id: 'updateTime', label: 'Time', dataFields: ['updateTime'], formatter: FORMATTERS.text as any },
      ] as any,
      pages: [],
    };
  }
}
