import React, { useCallback, useEffect, useRef } from 'react';
import type {
  ChartingLibraryWidgetConstructor,
  ChartingLibraryWidgetOptions,
  IBrokerConnectionAdapterHost,
  IBrokerTerminal,
  IChartingLibraryWidget,
  ResolutionString,
  SingleBrokerMetaInfo,
  TradingTerminalWidgetOptions,
} from '../charting_library';
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

  // 用useCallback包装onChartReady，避免它在每次render时都改变
  const memoizedOnChartReady = useCallback((widget: IChartingLibraryWidget) => {
    if (onChartReady) {
      onChartReady(widget);
    }
  }, [onChartReady]);

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
          disabled_features: [
            'header_symbol_search',
            'header_compare',
            'timeframes_toolbar',
          ],
          enabled_features: [
            'study_templates',
            'use_localstorage_for_settings',
          ],
          theme: 'light',
          fullscreen: false,
          autosize: true,
          debug: true,
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

        tvWidget.onChartReady(() => {
          if (!isMounted) {
            return;
          }
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
          widgetRef.current.remove();
          widgetRef.current = null;
        } catch (e) {
          console.warn('Error removing widget:', e);
        }
      }
    };
    // 注意：只在datafeed改变时重新初始化，不在onChartReady改变时
  }, [datafeed, trading]);

  return <div ref={chartContainerRef} style={{ width: '100%', height: '100%', position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} />;
};

export default AdvancedChart;
