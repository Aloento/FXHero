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
  const labelShapeIdsRef = useRef<Array<string | number>>([]);
  const labelSignatureRef = useRef<string>('');
  const foxStudyIdRef = useRef<string | number | null>(null);
  const estStudyIdRef = useRef<string | number | null>(null);

  // 用useCallback包装onChartReady，避免它在每次render时都改变
  const memoizedOnChartReady = useCallback((widget: IChartingLibraryWidget) => {
    if (onChartReady) {
      onChartReady(widget);
    }
  }, [onChartReady]);

  const applyDefaultStudies = useCallback(async (widget: IChartingLibraryWidget) => {
    const chart = widget.activeChart();
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
    chart.createStudy('FX HS Candles', true, false);
    chart.createStudy('FX TTW', true, false);
    chart.createStudy('FX XL Color K', true, false);

    if (chart.getCheckableActionState('Chart.Legend.ToggleVolumeVisibility' as ChartActionId)) {
      chart.executeActionById('Chart.Legend.ToggleVolumeVisibility' as ChartActionId);
    }

    chart.executeActionById('Chart.TimeScale.Reset' as ChartActionId);
    chart.executeActionById('Chart.Scales.Reset' as ChartActionId);
  }, []);

  const clearPivotLabels = useCallback((widget: IChartingLibraryWidget) => {
    const chart = widget.activeChart();
    for (const id of labelShapeIdsRef.current) {
      try {
        chart.removeEntity(id as any, { disableUndo: true });
      } catch {
        // ignore stale ids when chart was recreated
      }
    }
    labelShapeIdsRef.current = [];
    labelSignatureRef.current = '';
  }, []);

  const renderPivotLabels = useCallback(async (widget: IChartingLibraryWidget) => {
    const chart = widget.activeChart();
    const labels = [...datafeed.getPivotLabels('FOX'), ...datafeed.getPivotLabels('EST')]
      .sort((a, b) => a.time - b.time);
    const signature = labels
      .map((l) => `${l.id}|${l.time}|${l.price}|${l.text}`)
      .join(';');
    if (signature === labelSignatureRef.current) {
      return;
    }

    clearPivotLabels(widget);
    labelSignatureRef.current = signature;

    const offset = Math.max(datafeed.getMinMove() * 8, datafeed.getMinMove());
    const staggerMap = new Map<string, number>();
    for (const label of labels) {
      const isFox = label.id.startsWith('FOX_');
      const key = `${label.time}_${label.isTop ? 'T' : 'B'}`;
      const staggerIndex = staggerMap.get(key) ?? 0;
      staggerMap.set(key, staggerIndex + 1);

      const sideBase = label.isTop ? 1 : -1;
      const kindOffset = isFox ? 0 : datafeed.getMinMove() * 8;
      const staggerOffset = staggerIndex * datafeed.getMinMove() * 6;
      const finalOffset = sideBase * (offset + kindOffset + staggerOffset);

      const shapeId = await chart.createShape(
        {
          time: Math.floor(label.time / 1000),
          price: label.price + finalOffset,
        } as any,
        {
          shape: 'text',
          text: `${label.isTop ? '▼' : '▲'} ${label.text}`,
          lock: true,
          disableSelection: true,
          disableSave: true,
          disableUndo: true,
          ownerStudyId: (isFox ? foxStudyIdRef.current : estStudyIdRef.current) as any,
          showInObjectsTree: false,
          zOrder: 'top',
          overrides: {
            color: label.color,
          } as any,
        }
      );
      labelShapeIdsRef.current.push(shapeId as any);
    }
  }, [clearPivotLabels, datafeed]);

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
          await renderPivotLabels(tvWidget);
          const onSimulationBar = () => {
            if (!isMounted) return;
            void renderPivotLabels(tvWidget);
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
  }, [applyDefaultStudies, clearPivotLabels, datafeed, memoizedOnChartReady, renderPivotLabels, trading]);

  return <div ref={chartContainerRef} style={{ width: '100%', height: '100%', position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} />;
};

export default AdvancedChart;
