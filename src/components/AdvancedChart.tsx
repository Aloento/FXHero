import React, { useCallback, useEffect, useRef } from 'react';
import type {
  ChartingLibraryWidgetOptions,
  IChartingLibraryWidget,
  ResolutionString,
} from '../../public/charting_library/charting_library';
import CustomDatafeed from '../utils/datafeed';

export interface AdvancedChartProps {
  datafeed: CustomDatafeed;
  onChartReady?: (chartWidget: IChartingLibraryWidget) => void;
}

const DEBUG = (message: string, data?: any) => {
  console.debug(`[AdvancedChart] ${message}`, data ?? '');
};

// 标志全局script是否已开始加载，避免重复加载
let tvLibraryLoadingStarted = false;
let tvLibraryLoadPromise: Promise<void> | null = null;

const loadScript = (src: string, globalVarName: string): Promise<void> => {
  return new Promise((resolve, reject) => {
    // 如果全局变量已存在，直接返回
    if (window[globalVarName as keyof Window]) {
      DEBUG('TradingView library already loaded');
      return resolve();
    }

    // 如果已经开始加载，返回现有的Promise
    if (tvLibraryLoadingStarted && tvLibraryLoadPromise) {
      DEBUG('TradingView library is already loading, returning existing promise');
      return tvLibraryLoadPromise.then(resolve).catch(reject);
    }

    // 检查script标签是否存在
    const existingScript = document.querySelector(`script[src="${src}"]`);
    if (existingScript) {
      DEBUG('Script tag found, waiting for initialization...');
      tvLibraryLoadingStarted = true;

      // 设置超时，防止无限等待
      const timeout = 30000; // 30秒超时
      const startTime = Date.now();

      tvLibraryLoadPromise = new Promise((resolveTimeout, rejectTimeout) => {
        const checkInterval = setInterval(() => {
          if (window[globalVarName as keyof Window]) {
            clearInterval(checkInterval);
            tvLibraryLoadingStarted = false;
            tvLibraryLoadPromise = null;
            DEBUG('TradingView initialized from existing script');
            resolveTimeout();
          } else if (Date.now() - startTime > timeout) {
            clearInterval(checkInterval);
            tvLibraryLoadingStarted = false;
            tvLibraryLoadPromise = null;
            console.error('[AdvancedChart] TradingView initialization timeout');
            rejectTimeout(new Error('TradingView initialization timeout'));
          }
        }, 100);
      });

      return tvLibraryLoadPromise.then(resolve).catch(reject);
    }

    // 创建新的script标签
    DEBUG('Creating new script tag...');
    tvLibraryLoadingStarted = true;

    const script = document.createElement('script');
    script.src = src;
    script.type = 'text/javascript';

    tvLibraryLoadPromise = new Promise((resolveScript, rejectScript) => {
      script.onload = () => {
        DEBUG('Script loaded, TradingView available');
        tvLibraryLoadingStarted = false;
        tvLibraryLoadPromise = null;
        resolveScript();
      };

      script.onerror = () => {
        tvLibraryLoadingStarted = false;
        tvLibraryLoadPromise = null;
        rejectScript(new Error(`Failed to load ${src}`));
      };
    });

    document.head.appendChild(script);
    return tvLibraryLoadPromise.then(resolve).catch(reject);
  });
};

const AdvancedChart: React.FC<AdvancedChartProps> = ({ datafeed, onChartReady }) => {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const widgetRef = useRef<IChartingLibraryWidget | null>(null);

  // 用useCallback包装onChartReady，避免它在每次render时都改变
  const memoizedOnChartReady = useCallback((widget: IChartingLibraryWidget) => {
    DEBUG('onChartReady callback triggered');
    if (onChartReady) {
      onChartReady(widget);
    }
  }, [onChartReady]);

  useEffect(() => {
    let isMounted = true;

    const initWidget = async () => {
      try {
        DEBUG('Starting TradingView widget initialization...');

        // 加载 public/ 目录下的原生脚本。此处 TradingView 默认挂载在 window.TradingView 上
        await loadScript('/charting_library/charting_library.js', 'TradingView');

        if (!isMounted) {
          DEBUG('Component unmounted, skipping widget creation');
          return;
        }

        if (!chartContainerRef.current) {
          DEBUG('Chart container not found');
          return;
        }

        // 如果widget已存在，不要重复创建
        if (widgetRef.current) {
          DEBUG('Widget already exists, skipping creation');
          return;
        }

        DEBUG('Creating new widget with options', { symbol: 'FX_GAME', interval: '1' });

        const widgetOptions: ChartingLibraryWidgetOptions = {
          symbol: 'FX_GAME',
          interval: '1' as ResolutionString,
          container: chartContainerRef.current,
          library_path: '/charting_library/',
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

        const tvWidget = new window.TradingView.widget(widgetOptions);
        widgetRef.current = tvWidget;
        DEBUG('Widget created successfully');

        tvWidget.onChartReady(() => {
          if (!isMounted) {
            DEBUG('Chart ready but component unmounted');
            return;
          }
          DEBUG('Chart is ready');
          memoizedOnChartReady(tvWidget);
        });
      } catch (err) {
        console.error('Failed to load TradingView charting library:', err);
        if (isMounted) {
          DEBUG('Error during initialization', err);
        }
      }
    };

    initWidget();

    return () => {
      isMounted = false;
      if (widgetRef.current) {
        try {
          DEBUG('Removing widget on cleanup');
          widgetRef.current.remove();
          widgetRef.current = null;
        } catch (e) {
          console.warn('Error removing widget:', e);
        }
      }
    };
    // 注意：只在datafeed改变时重新初始化，不在onChartReady改变时
  }, [datafeed]);

  return <div ref={chartContainerRef} style={{ width: '100%', height: '100%', position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} />;
};

export default AdvancedChart;
