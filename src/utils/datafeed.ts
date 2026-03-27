import type {
  Bar,
  DatafeedErrorCallback,
  HistoryCallback,
  HistoryMetadata,
  IDatafeedChartApi,
  IExternalDatafeed,
  LibrarySymbolInfo,
  OnReadyCallback,
  PeriodParams,
  ResolutionString,
  ResolveCallback,
  SearchSymbolsCallback,
  SubscribeBarsCallback,
} from '../charting_library';
import { TvBar } from './csvParser';

type SubscribeCallback = (bar: Bar) => void;

class CustomDatafeed implements IExternalDatafeed, IDatafeedChartApi {
  private bars: TvBar[];
  private currentTickIndex: number;
  private precision: number;
  private minMove: number;

  private onRealtimeCallback: SubscribeCallback | null = null;
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
        if (this.onRealtimeCallback) {
          this.onRealtimeCallback({
            time: currentBar.time,
            open: currentBar.open,
            high: currentBar.high,
            low: currentBar.low,
            close: currentBar.close,
          });
        }
      }
    }
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
}

export default CustomDatafeed;
