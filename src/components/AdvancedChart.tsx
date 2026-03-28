import React, { useCallback, useEffect, useRef } from 'react';
import type {
  ChartActionId,
  ChartingLibraryWidgetConstructor,
  ChartingLibraryWidgetOptions,
  IBrokerConnectionAdapterHost,
  IBrokerTerminal,
  IChartingLibraryWidget,
  ResolutionString,
  SingleBrokerMetaInfo,
  TradingTerminalWidgetOptions,
} from '../charting_library';
import { createCustomIndicatorsGetter } from '../utils/customIndicators';
import CustomDatafeed from '../utils/datafeed';

export interface AdvancedChartProps {
  datafeed: CustomDatafeed;
  onChartReady?: (chartWidget: IChartingLibraryWidget) => void;
  trading?: {
    brokerConfig: SingleBrokerMetaInfo;
    brokerFactory: (host: IBrokerConnectionAdapterHost) => IBrokerTerminal;
  };
}

type TradingViewEsmModule = {
  widget: ChartingLibraryWidgetConstructor;
};

let tvEsmLoadPromise: Promise<TradingViewEsmModule> | null = null;

const SESSION_EVENTS = [
  { key: 'ASIA_OPEN', name: '亚盘', type: '开始' as const, seconds: (1 * 60 + 30) * 60, color: '#1565C0', top: true },
  { key: 'ASIA_CLOSE', name: '亚盘', type: '结束' as const, seconds: (7 * 60) * 60, color: '#1565C0', top: false },
  { key: 'EU_OPEN', name: '欧盘', type: '开始' as const, seconds: (8 * 60) * 60, color: '#2E7D32', top: true },
  { key: 'EU_CLOSE', name: '欧盘', type: '结束' as const, seconds: (16 * 60 + 30) * 60, color: '#2E7D32', top: false },
  { key: 'US_OPEN', name: '美盘', type: '开始' as const, seconds: (13 * 60 + 30) * 60, color: '#C62828', top: true },
  { key: 'US_CLOSE', name: '美盘', type: '结束' as const, seconds: (20 * 60) * 60, color: '#C62828', top: false },
];

const loadTradingViewEsm = (): Promise<TradingViewEsmModule> => {
  if (!tvEsmLoadPromise) {
    const modulePath = '/tradingview/charting_library.esm.js';
    tvEsmLoadPromise = (import(/* @vite-ignore */ modulePath) as Promise<TradingViewEsmModule>).catch((error) => {
      // Reset cache when loading fails so subsequent attempts can recover.
      tvEsmLoadPromise = null;
      throw error;
    });
  }

  return tvEsmLoadPromise;
};

const AdvancedChart: React.FC<AdvancedChartProps> = ({ datafeed, onChartReady, trading }) => {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const widgetRef = useRef<IChartingLibraryWidget | null>(null);
  const simulationListenerRef = useRef<((bar: any) => void) | null>(null);
  const visibleRangeListenerRef = useRef<((range: { from: number; to: number }) => void) | null>(null);
  const labelShapeStateRef = useRef<Map<string, {
    entityId: string | number;
    signature: string;
    ownerStudyId?: string | number;
  }>>(new Map());
  const isRenderingLabelsRef = useRef<boolean>(false);
  const needsRerenderLabelsRef = useRef<boolean>(false);
  const lastPivotTailRef = useRef<{ FOX: string | null; EST: string | null }>({ FOX: null, EST: null });
  const foxStudyIdRef = useRef<string | number | null>(null);
  const estStudyIdRef = useRef<string | number | null>(null);

  // 用useCallback包装onChartReady，避免它在每次render时都改变
  const memoizedOnChartReady = useCallback((widget: IChartingLibraryWidget) => {
    if (onChartReady) {
      onChartReady(widget);
    }
  }, [onChartReady]);

  const clearPivotLabels = useCallback((widget: IChartingLibraryWidget) => {
    const chart = widget.activeChart();
    for (const state of labelShapeStateRef.current.values()) {
      try {
        chart.removeEntity(state.entityId as any, { disableUndo: true });
      } catch {
        // ignore stale ids when chart was recreated
      }
    }
    labelShapeStateRef.current.clear();
    isRenderingLabelsRef.current = false;
    needsRerenderLabelsRef.current = false;
  }, []);

  const applyDefaultStudies = useCallback(async (widget: IChartingLibraryWidget) => {
    const chart = widget.activeChart();
    clearPivotLabels(widget);
    chart.removeAllStudies();
    foxStudyIdRef.current = null;
    estStudyIdRef.current = null;

    const studies = new Set(widget.getStudiesList());
    const supertrendName = studies.has('SuperTrend')
      ? 'SuperTrend'
      : studies.has('Supertrend')
        ? 'Supertrend'
        : null;
    if (supertrendName) {
      chart.createStudy(supertrendName, true, false);
    } else {
      console.warn('SuperTrend/Supertrend not found in studies list.');
    }

    chart.createStudy('MACD', false, false, {
      in_0: 12,
      in_1: 26,
      in_2: 9,
      in_3: 'close',
    } as any);

    foxStudyIdRef.current = await chart.createStudy('FX FOX', true, false);
    estStudyIdRef.current = await chart.createStudy('FX EST', true, false);
    lastPivotTailRef.current = { FOX: null, EST: null };
    chart.createStudy('FX HS Candles', true, false);
    chart.createStudy('FX TTW', true, false);
    chart.createStudy('FX XL Color K', true, false);

    if (chart.getCheckableActionState('Chart.Legend.ToggleVolumeVisibility' as ChartActionId)) {
      chart.executeActionById('Chart.Legend.ToggleVolumeVisibility' as ChartActionId);
    }

    chart.executeActionById('Chart.TimeScale.Reset' as ChartActionId);
    chart.executeActionById('Chart.Scales.Reset' as ChartActionId);
  }, [clearPivotLabels]);

  const renderPivotLabels = useCallback(async (widget: IChartingLibraryWidget) => {
    if (widgetRef.current !== widget) {
      return;
    }

    const chart = widget.activeChart();
    const labels = [
      ...datafeed.getPivotLabels('FOX').map((label) => ({ ...label, kind: 'FOX' as const })),
      ...datafeed.getPivotLabels('EST').map((label) => ({ ...label, kind: 'EST' as const })),
    ].sort((a, b) => a.time - b.time);

    const visibleRange = chart.getVisibleRange();
    const visiblePaddingSec = 12 * 60 * 60;
    const visibleFrom = visibleRange.from - visiblePaddingSec;
    const visibleTo = visibleRange.to + visiblePaddingSec;

    const desiredById = new Map<string, {
      point: { time: number; price: number };
      text: string;
      color: string;
      signature: string;
      ownerStudyId?: string | number;
    }>();

    const offset = Math.max(datafeed.getMinMove() * 8, datafeed.getMinMove());
    const staggerMap = new Map<string, number>();
    for (const label of labels) {
      const isFox = label.kind === 'FOX';
      const ownerStudyId = isFox ? foxStudyIdRef.current : estStudyIdRef.current;
      if (ownerStudyId == null) {
        continue;
      }

      const key = `${label.time}_${label.isTop ? 'T' : 'B'}`;
      const staggerIndex = staggerMap.get(key) ?? 0;
      staggerMap.set(key, staggerIndex + 1);

      const sideBase = label.isTop ? 1 : -1;
      const kindOffset = isFox ? 0 : datafeed.getMinMove() * 8;
      const staggerOffset = staggerIndex * datafeed.getMinMove() * 6;
      const finalOffset = sideBase * (offset + kindOffset + staggerOffset);

      const pointTime = datafeed.toChartUnixSeconds(label.time);
      if (pointTime < visibleFrom || pointTime > visibleTo) {
        continue;
      }
      const pointPrice = label.price + finalOffset;
      const signature = `${pointTime}|${pointPrice}|${label.text}|${label.color}|${ownerStudyId}`;

      desiredById.set(label.id, {
        point: {
          time: pointTime,
          price: pointPrice,
        },
        text: label.text,
        color: label.color,
        signature,
        ownerStudyId,
      });
    }

    const daySec = 24 * 60 * 60;
    const fromDay = Math.floor(visibleFrom / daySec) - 1;
    const toDay = Math.floor(visibleTo / daySec) + 1;
    const sessionOffset = Math.max(datafeed.getMinMove() * 40, datafeed.getMinMove() * 16);
    const sessionOwnerStudyId = foxStudyIdRef.current ?? estStudyIdRef.current;

    for (let day = fromDay; day <= toDay; day++) {
      const dayStartSec = day * daySec;
      for (const event of SESSION_EVENTS) {
        const eventSec = dayStartSec + event.seconds;
        if (eventSec < visibleFrom || eventSec > visibleTo) {
          continue;
        }

        const bar = datafeed.getBarByUnixTime(eventSec);
        if (!bar) {
          continue;
        }

        const pointPrice = event.top
          ? bar.high + sessionOffset
          : bar.low - sessionOffset;
        const pointTime = datafeed.toChartUnixSeconds(bar.time);
        const labelId = `SESSION_${event.key}_${pointTime}`;
        const text = `>>> ${event.name}${event.type} <<<`;
        const signature = `${pointTime}|${pointPrice}|${text}|${event.color}|${sessionOwnerStudyId ?? 'none'}`;

        desiredById.set(labelId, {
          point: {
            time: pointTime,
            price: pointPrice,
          },
          text,
          color: event.color,
          signature,
          ownerStudyId: sessionOwnerStudyId ?? undefined,
        });
      }
    }

    for (const [labelId, state] of labelShapeStateRef.current.entries()) {
      const next = desiredById.get(labelId);
      const shouldRecreate = !next || next.signature !== state.signature || next.ownerStudyId !== state.ownerStudyId;
      if (!shouldRecreate) {
        continue;
      }

      let removed = false;
      try {
        chart.removeEntity(state.entityId as any, { disableUndo: true });
        removed = true;
      } catch {
        // Keep old state when remove fails to avoid leaking duplicates by recreating on every tick.
      }
      if (removed) {
        labelShapeStateRef.current.delete(labelId);
      }
    }

    for (const [labelId, desired] of desiredById.entries()) {
      if (labelShapeStateRef.current.has(labelId)) {
        continue;
      }

      if (widgetRef.current !== widget) {
        return;
      }

      const shapeOptions: any = {
        shape: 'text',
        text: desired.text,
        lock: true,
        disableSelection: true,
        disableSave: true,
        disableUndo: true,
        showInObjectsTree: false,
        zOrder: 'top',
        overrides: {
          color: desired.color,
        } as any,
      };
      if (desired.ownerStudyId != null) {
        shapeOptions.ownerStudyId = desired.ownerStudyId as any;
      }

      const shapeId = await chart.createShape(desired.point as any, shapeOptions);

      labelShapeStateRef.current.set(labelId, {
        entityId: shapeId as any,
        signature: desired.signature,
        ownerStudyId: desired.ownerStudyId,
      });
    }
  }, [datafeed]);

  const schedulePivotLabelRender = useCallback((widget: IChartingLibraryWidget) => {
    if (widgetRef.current !== widget) {
      return;
    }

    if (isRenderingLabelsRef.current) {
      needsRerenderLabelsRef.current = true;
      return;
    }

    isRenderingLabelsRef.current = true;
    const run = async () => {
      try {
        do {
          needsRerenderLabelsRef.current = false;
          await renderPivotLabels(widget);
        } while (needsRerenderLabelsRef.current);
      } finally {
        isRenderingLabelsRef.current = false;
      }
    };

    void run();
  }, [renderPivotLabels]);

  const refreshPivotStudiesOnNewPoint = useCallback((widget: IChartingLibraryWidget) => {
    if (widgetRef.current !== widget) {
      return;
    }

    const foxLabels = datafeed.getPivotLabels('FOX');
    const estLabels = datafeed.getPivotLabels('EST');
    const foxTail = foxLabels.length > 0 ? foxLabels[foxLabels.length - 1].id : null;
    const estTail = estLabels.length > 0 ? estLabels[estLabels.length - 1].id : null;

    const prev = lastPivotTailRef.current;
    const foxChanged = foxTail !== prev.FOX;
    const estChanged = estTail !== prev.EST;

    if (!foxChanged && !estChanged) {
      return;
    }

    lastPivotTailRef.current = { FOX: foxTail, EST: estTail };

    // First sample establishes baseline; refresh from the next new pivot onwards.
    if (prev.FOX == null && prev.EST == null) {
      return;
    }

    const chart = widget.activeChart();
    const refreshStudy = (studyId: string | number | null) => {
      if (studyId == null) {
        return;
      }
      try {
        const studyApi = chart.getStudyById(studyId as any);
        if (!studyApi.isVisible()) {
          return;
        }
        studyApi.setVisible(false);
        studyApi.setVisible(true);
      } catch {
        // ignore stale study references during chart re-init
      }
    };

    if (foxChanged) {
      refreshStudy(foxStudyIdRef.current);
    }
    if (estChanged) {
      refreshStudy(estStudyIdRef.current);
    }
  }, [datafeed]);

  useEffect(() => {
    let isMounted = true;
    let initRetry = 0;

    const initWidget = async () => {
      try {
        const tvModule = await loadTradingViewEsm();

        if (!isMounted) {
          return;
        }

        if (!chartContainerRef.current) {
          return;
        }

        // 如果widget已存在，不要重复创建
        if (widgetRef.current) {
          return;
        }

        const widgetOptions: ChartingLibraryWidgetOptions = {
          symbol: 'FX_GAME',
          interval: '1' as ResolutionString,
          container: chartContainerRef.current,
          library_path: '/tradingview/',
          locale: 'zh',
          custom_indicators_getter: createCustomIndicatorsGetter(datafeed),
          disabled_features: [
            'header_symbol_search',
            'header_compare',
            'timeframes_toolbar',
            'create_volume_indicator_by_default',
            'create_volume_indicator_by_default_once',
            'use_localstorage_for_settings',
            'save_chart_properties_to_local_storage',
          ],
          enabled_features: [],
          overrides: {
            'mainSeriesProperties.candleStyle.drawBorder': false,
          },
          theme: 'light',
          fullscreen: false,
          autosize: true,
          debug: false,
          datafeed: datafeed,
        };

        const finalOptions = trading
          ? {
            ...(widgetOptions as TradingTerminalWidgetOptions),
            broker_config: trading.brokerConfig,
            broker_factory: trading.brokerFactory,
          }
          : widgetOptions;

        const tvWidget = new tvModule.widget(finalOptions as TradingTerminalWidgetOptions);
        widgetRef.current = tvWidget;

        tvWidget.onChartReady(async () => {
          if (!isMounted) {
            return;
          }
          await applyDefaultStudies(tvWidget);
          schedulePivotLabelRender(tvWidget);
          const onVisibleRangeChanged = () => {
            if (!isMounted) return;
            schedulePivotLabelRender(tvWidget);
          };
          visibleRangeListenerRef.current = onVisibleRangeChanged;
          tvWidget.activeChart().onVisibleRangeChanged().subscribe(null, onVisibleRangeChanged);
          const onSimulationBar = () => {
            if (!isMounted) return;
            try {
              refreshPivotStudiesOnNewPoint(tvWidget);
              schedulePivotLabelRender(tvWidget);
            } catch (error) {
              console.error('Simulation chart refresh failed:', error);
            }
          };
          simulationListenerRef.current = onSimulationBar;
          datafeed.subscribeSimulation(onSimulationBar);
          memoizedOnChartReady(tvWidget);
        });
      } catch (err) {
        console.error('Failed to load TradingView charting library:', err);
        if (isMounted && initRetry < 1) {
          initRetry += 1;
          setTimeout(() => {
            void initWidget();
          }, 120);
        }
      }
    };

    initWidget();

    return () => {
      isMounted = false;
      if (widgetRef.current) {
        try {
          if (simulationListenerRef.current) {
            datafeed.unsubscribeSimulation(simulationListenerRef.current);
            simulationListenerRef.current = null;
          }
          if (visibleRangeListenerRef.current) {
            widgetRef.current.activeChart().onVisibleRangeChanged().unsubscribe(null, visibleRangeListenerRef.current);
            visibleRangeListenerRef.current = null;
          }
          clearPivotLabels(widgetRef.current);
          widgetRef.current.remove();
          widgetRef.current = null;
          foxStudyIdRef.current = null;
          estStudyIdRef.current = null;
        } catch (e) {
          console.warn('Error removing widget:', e);
        }
      }
    };
    // 注意：只在datafeed改变时重新初始化，不在onChartReady改变时
  }, [applyDefaultStudies, clearPivotLabels, datafeed, memoizedOnChartReady, refreshPivotStudiesOnNewPoint, schedulePivotLabelRender, trading]);

  return <div ref={chartContainerRef} style={{ width: '100%', height: '100%', position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} />;
};

export default AdvancedChart;
