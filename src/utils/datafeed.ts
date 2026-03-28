import type {
  Bar,
  DatafeedErrorCallback,
  HistoryCallback,
  HistoryMetadata,
  IDatafeedChartApi,
  IDatafeedQuotesApi,
  IExternalDatafeed,
  LibrarySymbolInfo,
  Mark,
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
import { PivotLevel, TvBar } from './csvParser';

type SubscribeCallback = (bar: Bar) => void;

export type PivotKind = 'FOX' | 'EST';

export interface DynamicPivotPoint {
  time: number;
  value: number;
  level: PivotLevel;
  temporary: boolean;
}

interface DynamicPivotState {
  pointsByTime: Map<number, DynamicPivotPoint>;
  lastHigh: number;
  lastLow: number;
  pendingHighTime: number | null;
  pendingLowTime: number | null;
}

interface PivotRenderPoint {
  time: number;
  value: number;
  isTop: boolean;
  temporary: boolean;
}

interface PivotRenderBundle {
  pointsByTime: Map<number, DynamicPivotPoint>;
  labels: Array<{
    id: string;
    time: number;
    price: number;
    isTop: boolean;
    text: string;
    color: string;
  }>;
}

class CustomDatafeed implements IExternalDatafeed, IDatafeedChartApi, IDatafeedQuotesApi {
  private bars: TvBar[];
  private barIndexByTime: Map<number, number>;
  private currentTickIndex: number;
  private precision: number;
  private minMove: number;

  private onRealtimeCallback: SubscribeCallback | null = null;
  private simulationListeners: Set<(bar: TvBar) => void> = new Set();
  private quoteListeners: Map<string, { symbols: string[], callback: QuotesCallback }> = new Map();
  private lastUpdateBarInfo: { time: number } | null = null;
  private dynamicPivotStates: Record<PivotKind, DynamicPivotState>;
  private pivotRenderCache: Partial<Record<PivotKind, { index: number; bundle: PivotRenderBundle }>> = {};

  constructor(bars: TvBar[], precision: number, minMove: number) {
    this.bars = bars;
    this.barIndexByTime = new Map<number, number>();
    for (let i = 0; i < bars.length; i++) {
      this.barIndexByTime.set(bars[i].time, i);
    }
    this.precision = precision;
    this.minMove = minMove;
    this.currentTickIndex = bars.length - 1;
    this.dynamicPivotStates = {
      FOX: this.createDynamicPivotState(),
      EST: this.createDynamicPivotState(),
    };
  }

  public simulateTo(index: number): void {
    if (index >= 0 && index < this.bars.length) {
      if (this.currentTickIndex !== index) {
        this.currentTickIndex = index;
        const currentBar = this.bars[index];
        this.updateDynamicPivots(index);
        this.simulationListeners.forEach((listener) => {
          try {
            listener(currentBar);
          } catch (error) {
            console.error('Simulation listener failed:', error);
          }
        });
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

  private createDynamicPivotState(): DynamicPivotState {
    return {
      pointsByTime: new Map<number, DynamicPivotPoint>(),
      lastHigh: Number.NEGATIVE_INFINITY,
      lastLow: Number.POSITIVE_INFINITY,
      pendingHighTime: null,
      pendingLowTime: null,
    };
  }

  public resetDynamicPivots(uptoIndex?: number): void {
    this.dynamicPivotStates.FOX = this.createDynamicPivotState();
    this.dynamicPivotStates.EST = this.createDynamicPivotState();
    const targetIndex = typeof uptoIndex === 'number' ? uptoIndex : this.currentTickIndex;
    if (targetIndex >= 0) {
      for (let i = 0; i <= targetIndex && i < this.bars.length; i++) {
        this.updateDynamicPivots(i);
      }
    }
  }

  private updateDynamicPivots(index: number): void {
    const bar = this.bars[index];
    if (!bar) return;

    this.updateSinglePivotState('FOX', bar, bar.foxIsPivot, bar.foxLevel);
    this.updateSinglePivotState('EST', bar, bar.estIsPivot, bar.estLevel);
    this.pivotRenderCache = {};
  }

  private updateSinglePivotState(kind: PivotKind, bar: TvBar, isPivot?: boolean, levelHint?: PivotLevel | null): void {
    const state = this.dynamicPivotStates[kind];

    if (bar.high > state.lastHigh) {
      if (state.pendingHighTime != null) {
        state.pointsByTime.delete(state.pendingHighTime);
      }
      state.pointsByTime.set(bar.time, {
        time: bar.time,
        value: bar.high,
        level: 'HIGH',
        temporary: true,
      });
      state.pendingHighTime = bar.time;
    }

    if (bar.low < state.lastLow) {
      if (state.pendingLowTime != null) {
        state.pointsByTime.delete(state.pendingLowTime);
      }
      state.pointsByTime.set(bar.time, {
        time: bar.time,
        value: bar.low,
        level: 'LOW',
        temporary: true,
      });
      state.pendingLowTime = bar.time;
    }

    if (isPivot) {
      const inferredLevel: PivotLevel = levelHint ?? (bar.high - state.lastHigh >= state.lastLow - bar.low ? 'HIGH' : 'LOW');
      const pivotValue = inferredLevel === 'HIGH' ? bar.high : bar.low;

      if (inferredLevel === 'HIGH' && state.pendingHighTime != null) {
        state.pointsByTime.delete(state.pendingHighTime);
      }
      if (inferredLevel === 'LOW' && state.pendingLowTime != null) {
        state.pointsByTime.delete(state.pendingLowTime);
      }

      state.pointsByTime.set(bar.time, {
        time: bar.time,
        value: pivotValue,
        level: inferredLevel,
        temporary: false,
      });

      if (inferredLevel === 'HIGH') {
        state.lastHigh = Math.max(state.lastHigh, pivotValue);
        state.pendingHighTime = null;
      } else {
        state.lastLow = Math.min(state.lastLow, pivotValue);
        state.pendingLowTime = null;
      }
      return;
    }

    state.lastHigh = Math.max(state.lastHigh, bar.high);
    state.lastLow = Math.min(state.lastLow, bar.low);
  }

  private normalizeTs(ts: number): number {
    // PineJS time can be in seconds, while our bars are milliseconds.
    return ts < 1e12 ? ts * 1000 : ts;
  }

  public getBarByUnixTime(ts: number): TvBar | null {
    const normalized = this.normalizeTs(ts);
    const idx = this.barIndexByTime.get(normalized) ?? -1;
    if (idx < 0 || idx > this.currentTickIndex) return null;
    return this.bars[idx];
  }

  public getDynamicPivotAt(kind: PivotKind, ts: number): DynamicPivotPoint | null {
    const normalized = this.normalizeTs(ts);
    const point = this.dynamicPivotStates[kind].pointsByTime.get(normalized);
    if (!point) return null;
    const idx = this.barIndexByTime.get(normalized) ?? -1;
    if (idx < 0 || idx > this.currentTickIndex) return null;
    return point;
  }

  public getPivotLinePointAt(kind: PivotKind, ts: number): DynamicPivotPoint | null {
    const normalized = this.normalizeTs(ts);
    const bundle = this.getPivotRenderBundle(kind);
    return bundle.pointsByTime.get(normalized) ?? null;
  }

  public getPivotLabels(kind: PivotKind): Array<{
    id: string;
    time: number;
    price: number;
    isTop: boolean;
    text: string;
    color: string;
  }> {
    return this.getPivotRenderBundle(kind).labels;
  }

  public getMinMove(): number {
    return this.minMove;
  }

  private getPivotRenderBundle(kind: PivotKind): PivotRenderBundle {
    const cached = this.pivotRenderCache[kind];
    if (cached && cached.index === this.currentTickIndex) {
      return cached.bundle;
    }
    const bundle = this.buildPivotRenderBundle(kind);
    this.pivotRenderCache[kind] = { index: this.currentTickIndex, bundle };
    return bundle;
  }

  private buildPivotRenderBundle(kind: PivotKind): PivotRenderBundle {
    const pivotRows = this.bars
      .slice(0, this.currentTickIndex + 1)
      .filter((bar) => (kind === 'FOX' ? bar.foxIsPivot : bar.estIsPivot));

    if (pivotRows.length === 0) {
      return { pointsByTime: new Map<number, DynamicPivotPoint>(), labels: [] };
    }

    let isTop = pivotRows.length > 1 ? pivotRows[0].high > pivotRows[1].high : true;
    const sequence: PivotRenderPoint[] = pivotRows.map((bar) => {
      const value = isTop ? bar.high : bar.low;
      const currentIsTop = isTop;
      isTop = !isTop;
      return { time: bar.time, value, isTop: currentIsTop, temporary: false };
    });

    // 根据用户要求：移除FOX/EST最新模拟点，仅使用确认pivot构建序列。

    const pointsByTime = new Map<number, DynamicPivotPoint>();
    const labels: Array<{
      id: string;
      time: number;
      price: number;
      isTop: boolean;
      text: string;
      color: string;
    }> = [];
    const markerName = kind === 'FOX' ? 'Fox' : 'Est';
    const labelColor = kind === 'FOX' ? '#D32F2F' : '#00ACC1';
    const multiplier = Math.pow(10, this.precision);

    // Build connected line values so custom line study renders as continuous segments.
    if (sequence.length === 1) {
      const p = sequence[0];
      pointsByTime.set(p.time, {
        time: p.time,
        value: p.value,
        level: p.isTop ? 'HIGH' : 'LOW',
        temporary: p.temporary,
      });
    } else {
      for (let i = 0; i < sequence.length - 1; i++) {
        const start = sequence[i];
        const end = sequence[i + 1];
        const startIndex = this.barIndexByTime.get(start.time);
        const endIndex = this.barIndexByTime.get(end.time);
        if (startIndex == null || endIndex == null || endIndex < startIndex) {
          continue;
        }
        const total = Math.max(1, endIndex - startIndex);
        for (let idx = startIndex; idx <= endIndex; idx++) {
          const ratio = (idx - startIndex) / total;
          const value = start.value + (end.value - start.value) * ratio;
          const barTime = this.bars[idx].time;
          pointsByTime.set(barTime, {
            time: barTime,
            value,
            level: end.isTop ? 'HIGH' : 'LOW',
            temporary: false,
          });
        }
      }
    }

    for (let i = 0; i < sequence.length; i++) {
      const current = sequence[i];
      const next = i < sequence.length - 1 ? sequence[i + 1] : null;

      let text = markerName;
      if (next) {
        const startIndex = this.barIndexByTime.get(current.time);
        const endIndex = this.barIndexByTime.get(next.time);
        if (startIndex != null && endIndex != null && endIndex > startIndex) {
          const barCount = endIndex - startIndex;
          const pointsDiff = Math.round(Math.abs((next.value - current.value) * multiplier));
          const rate = (pointsDiff / barCount).toFixed(1);
          text = `${markerName} ${pointsDiff}P, ${barCount}K, Δ${rate}`;
        }
      }

      labels.push({
        id: `${kind}_${current.time}`,
        time: current.time,
        price: current.value,
        isTop: current.isTop,
        text,
        color: labelColor,
      });
    }

    return { pointsByTime, labels };
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

  public getPrecision(): number {
    return this.precision;
  }

  onReady(callback: OnReadyCallback): void {
    setTimeout(() =>
      callback({
        supported_resolutions: ['1', '5', '15', '30', '60', 'D', 'W', 'M'] as ResolutionString[],
        supports_marks: false,
        supports_timescale_marks: false,
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
        pointvalue: 100000,
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

  getMarks(
    symbolInfo: LibrarySymbolInfo,
    from: number,
    to: number,
    onDataCallback: (marks: Mark[]) => void,
    resolution: ResolutionString
  ): void {
    onDataCallback([]);
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
