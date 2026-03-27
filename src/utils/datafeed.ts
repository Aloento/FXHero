import type {
  Bar,
  DatafeedErrorCallback,
  HistoryCallback,
  HistoryMetadata,
  IDatafeedChartApi,
  IDatafeedQuotesApi,
  IExternalDatafeed,
  LibrarySymbolInfo,
  OnReadyCallback,
  PeriodParams,
  QuoteData,
  QuotesCallback,
  QuotesErrorCallback,
  ResolutionString,
  ResolveCallback,
  SearchSymbolsCallback,
  SubscribeBarsCallback
} from '../charting_library';
import { TvBar } from './csvParser';

type SubscribeCallback = (bar: Bar) => void;

class CustomDatafeed implements IExternalDatafeed, IDatafeedChartApi, IDatafeedQuotesApi {
  private bars: TvBar[];
  private currentTickIndex: number;
  private precision: number;
  private minMove: number;

  private onRealtimeCallback: SubscribeCallback | null = null;
  private simulationListeners: Set<(bar: TvBar) => void> = new Set();
  private quoteListeners: Map<string, { symbols: string[], callback: QuotesCallback }> = new Map();
  private lastUpdateBarInfo: { time: number } | null = null;

  constructor(bars: TvBar[], precision: number, minMove: number) {
    this.bars = bars;
    this.precision = precision;
    this.minMove = minMove;
    this.currentTickIndex = bars.length - 1;
  }

  public simulateTo(index: number): void {
    if (index >= 0 && index < this.bars.length) {
      if (this.currentTickIndex !== index) {
        this.currentTickIndex = index;
        const currentBar = this.bars[index];
        this.simulationListeners.forEach((listener) => listener(currentBar));
        if (this.onRealtimeCallback) {
          this.onRealtimeCallback({
            time: currentBar.time,
            open: currentBar.open,
            high: currentBar.high,
            low: currentBar.low,
            close: currentBar.close,
          });
        }
        this.quoteListeners.forEach(({ symbols, callback }) => {
          const quotesData: QuoteData[] = symbols.map((sym) => ({
            s: 'ok',
            n: sym,
            v: {
              lp: currentBar.close,
              ask: currentBar.close,
              bid: currentBar.close,
              open_price: currentBar.open,
              high_price: currentBar.high,
              low_price: currentBar.low,
              volume: currentBar.volume || 0,
            }
          }));
          callback(quotesData);
        });
      }
    }
  }

  public subscribeSimulation(listener: (bar: TvBar) => void): void {
    this.simulationListeners.add(listener);
  }

  public unsubscribeSimulation(listener: (bar: TvBar) => void): void {
    this.simulationListeners.delete(listener);
  }

  public getCurrentBar(): TvBar | null {
    if (this.currentTickIndex >= 0 && this.currentTickIndex < this.bars.length) {
      return this.bars[this.currentTickIndex];
    }
    return null;
  }

  public getTotalBars(): number {
    return this.bars.length;
  }

  onReady(callback: OnReadyCallback): void {
    setTimeout(() =>
      callback({
        supported_resolutions: ['1', '5', '15', '30', '60', 'D', 'W', 'M'] as ResolutionString[],
        supports_marks: true,
        supports_timescale_marks: true,
        supports_time: true,
      })
    );
  }

  searchSymbols(
    userInput: string,
    exchange: string,
    symbolType: string,
    onResult: SearchSymbolsCallback
  ): void {
    onResult([]);
  }

  resolveSymbol(
    symbolName: string,
    onResolve: ResolveCallback,
    onError: DatafeedErrorCallback
  ): void {
    setTimeout(() => {
      onResolve({
        name: 'FX_GAME',
        description: 'Backtest Challenge',
        type: 'forex',
        session: '24x7',
        timezone: 'Etc/UTC',
        exchange: 'FX_GAME',
        listed_exchange: 'FX_GAME',
        ticker: 'FX_GAME',
        minmov: 1,
        pricescale: Math.pow(10, this.precision),
        has_intraday: true,
        supported_resolutions: ['1', '5', '15', '30', '60', 'D', 'W', 'M'] as ResolutionString[],
        volume_precision: 0,
        data_status: 'streaming',
        format: 'price',
      } as LibrarySymbolInfo);
    }, 0);
  }

  getBars(
    symbolInfo: LibrarySymbolInfo,
    resolution: ResolutionString,
    periodParams: PeriodParams,
    onResult: HistoryCallback,
    onError: DatafeedErrorCallback
  ): void {
    const { from, to, firstDataRequest } = periodParams;

    const fromMs = from * 1000;
    const toMs = to * 1000;

    const currentSimulatedTime = this.bars[this.currentTickIndex]?.time ?? 0;

    const visibleBars = this.bars.filter(
      (b) => b.time >= fromMs && b.time <= toMs && b.time <= currentSimulatedTime
    );

    if (visibleBars.length > 0) {
      const historyMetadata: HistoryMetadata = { noData: false };
      onResult(visibleBars, historyMetadata);
    } else {
      const earlierBars = this.bars.filter(b => b.time < fromMs && b.time <= currentSimulatedTime);
      if (earlierBars.length > 0) {
        const nextTime = Math.floor(earlierBars[earlierBars.length - 1].time / 1000);
        onResult([], { noData: true, nextTime });
      } else {
        onResult([], { noData: true });
      }
    }
  }

  subscribeBars(
    symbolInfo: LibrarySymbolInfo,
    resolution: ResolutionString,
    onTick: SubscribeBarsCallback,
    listenerGuid: string,
    onResetCacheNeededCallback: () => void
  ): void {
    this.onRealtimeCallback = onTick;
  }

  unsubscribeBars(listenerGuid: string): void {
    this.onRealtimeCallback = null;
  }

  getQuotes(symbols: string[], onDataCallback: QuotesCallback, onErrorCallback: QuotesErrorCallback): void {
    const currentBar = this.getCurrentBar();
    if (!currentBar) {
      onErrorCallback('No data');
      return;
    }
    const data: QuoteData[] = symbols.map((sym) => ({
      s: 'ok',
      n: sym,
      v: {
        ch: 0,
        chp: 0,
        short_name: sym,
        exchange: 'FX_GAME',
        description: 'FX Game',
        lp: currentBar.close,
        ask: currentBar.close,
        bid: currentBar.close,
        spread: 0,
        open_price: currentBar.open,
        high_price: currentBar.high,
        low_price: currentBar.low,
        volume: currentBar.volume || 0,
      }
    }));
    onDataCallback(data);
  }

  subscribeQuotes(symbols: string[], fastSymbols: string[], onRealtimeCallback: QuotesCallback, listenerGUID: string): void {
    this.quoteListeners.set(listenerGUID, { symbols: [...symbols, ...fastSymbols], callback: onRealtimeCallback });
  }

  unsubscribeQuotes(listenerGUID: string): void {
    this.quoteListeners.delete(listenerGUID);
  }
}

export default CustomDatafeed;
