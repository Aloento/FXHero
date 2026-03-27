import React, { useState, useEffect, useRef, memo } from "react";

// ==========================================
// 1. 常量配置 (日间主题)
// ==========================================
const CHART_COLORS = {
  bg: "#FFFFFF",
  text: "#191919",
  grid: "#E6E6E6",
  xlMap: { Blue: "#2962FF", Red: "#FF5252", Magenta: "#E040FB", Aqua: "#00BCD4" },
  hsUp: "#00C853",
  hsDown: "#FFB300",
  ttwUp: "#00BCD4",
  ttwMid: "#4CAF50",
  ttwLow: "#2196F3",
  fox: "#D32F2F",
  est: "#00ACC1",
  mainUp: "#26A69A",
  mainDown: "#EF5350",
};

// ==========================================
// 2. 工具函数 (依赖加载与数据解析)
// ==========================================
const loadScript = (src, globalVarName) => {
  return new Promise((resolve, reject) => {
    if (window[globalVarName]) return resolve();
    if (document.querySelector(`script[src="${src}"]`)) {
      const interval = setInterval(() => {
        if (window[globalVarName]) {
          clearInterval(interval);
          resolve();
        }
      }, 50);
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.crossOrigin = "anonymous";
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
};

const parseNum = (str) => {
  if (!str || str.trim() === "") return null;
  const n = parseFloat(str);
  return isNaN(n) ? null : n;
};

// 计算自适应精度 (从最后一行有效数据推断，过滤 MT4 浮点误差)
const calculatePrecision = (rawData) => {
  let maxDecimals = 2;
  for (let i = rawData.length - 1; i >= 0; i--) {
    const row = rawData[i];
    if (row.Open && row.High && row.Low && row.Close) {
      const lengths = [row.Open, row.High, row.Low, row.Close]
        .filter((v) => typeof v === "string" && v.includes("."))
        .map((v) => v.split(".")[1].length);

      const validLengths = lengths.filter((l) => l <= 6);
      if (validLengths.length > 0) {
        maxDecimals = Math.max(...validLengths);
        break;
      }
    }
  }
  return Math.min(Math.max(maxDecimals, 2), 6);
};

// 计算交替折线，并将向后（下一段）的数据直接标注在当前顶点上
const buildPivotsData = (pivots, markerName, color, maxDecimals, timeToIndex) => {
  if (pivots.length === 0) return { lineData: [], markers: [] };
  
  const lineData = [];
  const markers = [];
  const multiplier = Math.pow(10, maxDecimals);

  let isTop = pivots.length > 1 ? pivots[0].high > pivots[1].high : true;
  const sequence = pivots.map((p) => {
    const val = isTop ? p.high : p.low;
    const currentIsTop = isTop;
    isTop = !isTop; 
    return { time: p.time, value: val, isTop: currentIsTop };
  });

  for (let i = 0; i < sequence.length; i++) {
    const curr = sequence[i];
    const next = i < sequence.length - 1 ? sequence[i + 1] : null;

    lineData.push({ time: curr.time, value: curr.value });
    
    // 默认文本（最后一个顶点不显示向后数据）
    let text = markerName; 

    // 如果有下一个顶点，计算当前到下一个顶点的参数
    if (next) {
      const startIndex = timeToIndex.get(curr.time);
      const endIndex = timeToIndex.get(next.time);

      if (startIndex !== undefined && endIndex !== undefined && endIndex > startIndex) {
        const barCount = endIndex - startIndex;
        const pointsDiff = Math.round(Math.abs((next.value - curr.value) * multiplier));
        const rate = (pointsDiff / barCount).toFixed(1);

        // 严格按照要求的格式拼接
        text = `${markerName} ${pointsDiff}P, ${barCount}K, Δ${rate}`;
      }
    }

    markers.push({
      time: curr.time,
      position: curr.isTop ? "aboveBar" : "belowBar", // 顶点在上方，底点在下方
      color: color,
      shape: curr.isTop ? "arrowDown" : "arrowUp",
      text: text,
    });
  }

  return { lineData, markers };
};

// ==========================================
// 3. 核心业务：CSV 数据转换引擎
// ==========================================
const transformData = (rawData) => {
  const mainCandles = [], hsCandles = [];
  const ttwUp = [], ttwMid = [], ttwLow = [];
  const rawFoxPivots = [], rawEstPivots = [];

  const maxDecimals = calculatePrecision(rawData);
  const minMove = 1 / Math.pow(10, maxDecimals);

  rawData.forEach((row) => {
    if (!row.Time || !row.Open) return;

    const parts = row.Time.split(" ");
    if (parts.length !== 2) return;
    const [y, m, d] = parts[0].split(".");
    const [H, M] = parts[1].split(":");
    const timestamp = Date.UTC(parseInt(y), parseInt(m) - 1, parseInt(d), parseInt(H), parseInt(M)) / 1000;

    const open = parseFloat(row.Open), high = parseFloat(row.High);
    const low = parseFloat(row.Low), close = parseFloat(row.Close);

    const candle = { time: timestamp, open, high, low, close };
    if (row.XL_Color && CHART_COLORS.xlMap[row.XL_Color]) {
      candle.color = candle.wickColor = CHART_COLORS.xlMap[row.XL_Color];
    }
    mainCandles.push(candle);

    const hsO = parseNum(row["HS_B2(Open)"]), hsH = parseNum(row["HS_B0(High)"]);
    const hsL = parseNum(row["HS_B1(Low)"]), hsC = parseNum(row["HS_B3(Close)"]);
    if (hsO !== null && hsH !== null && hsL !== null && hsC !== null) {
      hsCandles.push({ time: timestamp, open: hsO, high: hsH, low: hsL, close: hsC });
    }

    const tU = parseNum(row.TTW_Upper), tM = parseNum(row.TTW_Middle), tL = parseNum(row.TTW_Lower);
    if (tU !== null) ttwUp.push({ time: timestamp, value: tU });
    if (tM !== null) ttwMid.push({ time: timestamp, value: tM });
    if (tL !== null) ttwLow.push({ time: timestamp, value: tL });

    if (row.Fox_IsPivot === "TRUE") rawFoxPivots.push({ time: timestamp, high, low });
    if (row.Est_IsPivot === "TRUE") rawEstPivots.push({ time: timestamp, high, low });
  });

  const sortByTime = (a, b) => a.time - b.time;
  [mainCandles, hsCandles, ttwUp, ttwMid, ttwLow, rawFoxPivots, rawEstPivots].forEach(arr => arr.sort(sortByTime));

  const timeToIndex = new Map();
  mainCandles.forEach((c, idx) => timeToIndex.set(c.time, idx));

  // Fox 的标记：顶点在上方，底点在下方
  const foxData = buildPivotsData(rawFoxPivots, "Fox", CHART_COLORS.fox, maxDecimals, timeToIndex);
  // Est 的标记：顶点在上方，底点在下方
  const estData = buildPivotsData(rawEstPivots, "Est", CHART_COLORS.est, maxDecimals, timeToIndex);

  const allMarkers = [...foxData.markers, ...estData.markers].sort(sortByTime);

  return {
    mainCandles, hsCandles,
    ttwUp, ttwMid, ttwLow,
    foxLine: foxData.lineData,
    estLine: estData.lineData,
    markers: allMarkers, 
    precision: maxDecimals, 
    minMove,
  };
};

// ==========================================
// 4. React 视图组件
// ==========================================
class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { hasError: false, errorMsg: "" }; }
  static getDerivedStateFromError(error) { return { hasError: true, errorMsg: error.message }; }
  render() {
    if (this.state.hasError) {
      return (
        <div className="flex-1 flex items-center justify-center p-6 text-gray-800">
          <div className="bg-red-50 border border-red-200 p-6 rounded-lg max-w-lg text-center">
            <AlertCircleIcon className="w-10 h-10 text-red-500 mx-auto mb-4" />
            <h3 className="text-lg font-bold mb-2">图表渲染出错</h3>
            <p className="text-sm opacity-80 text-red-600">{this.state.errorMsg}</p>
            <button onClick={() => window.location.reload()} className="mt-4 px-4 py-2 bg-red-600 text-white hover:bg-red-700 rounded transition">
              重新加载页面
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const ChartViewer = memo(({ data }) => {
  const chartContainerRef = useRef(null);
  const chartRef = useRef(null);

  useEffect(() => {
    if (!data || !chartContainerRef.current || !window.LightweightCharts) return;

    const { createChart, CrosshairMode } = window.LightweightCharts;

    const chart = createChart(chartContainerRef.current, {
      layout: { background: { type: "solid", color: CHART_COLORS.bg }, textColor: CHART_COLORS.text },
      grid: { vertLines: { color: CHART_COLORS.grid }, horzLines: { color: CHART_COLORS.grid } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: CHART_COLORS.grid, autoScale: true },
      timeScale: { borderColor: CHART_COLORS.grid, timeVisible: true, secondsVisible: false },
    });

    chartRef.current = chart;

    const priceFormatOptions = { type: "price", precision: data.precision, minMove: data.minMove };
    const lineConfig = { crosshairMarkerVisible: false, priceLineVisible: false, priceFormat: priceFormatOptions };

    // 1. 底层：色带
    chart.addCandlestickSeries({
      upColor: CHART_COLORS.hsUp, downColor: CHART_COLORS.hsDown,
      borderVisible: false, wickVisible: false, priceLineVisible: false, priceFormat: priceFormatOptions,
    }).setData(data.hsCandles);

    // 2. 中层：三清线
    chart.addLineSeries({ ...lineConfig, color: CHART_COLORS.ttwUp, lineWidth: 1 }).setData(data.ttwUp);
    chart.addLineSeries({ ...lineConfig, color: CHART_COLORS.ttwMid, lineWidth: 1 }).setData(data.ttwMid);
    chart.addLineSeries({ ...lineConfig, color: CHART_COLORS.ttwLow, lineWidth: 1 }).setData(data.ttwLow);

    // 3. 顶层下方：Fox 折线
    chart.addLineSeries({ ...lineConfig, color: CHART_COLORS.fox, lineWidth: 4, crosshairMarkerVisible: true })
         .setData(data.foxLine);

    // 4. 顶层上方：Est 折线
    chart.addLineSeries({ ...lineConfig, color: CHART_COLORS.est, lineWidth: 2, crosshairMarkerVisible: true })
         .setData(data.estLine);

    // 5. 最顶层：主图 K 线及所有顶点标记
    const mainSeries = chart.addCandlestickSeries({
      upColor: CHART_COLORS.mainUp, downColor: CHART_COLORS.mainDown,
      borderVisible: false, wickUpColor: CHART_COLORS.mainUp, wickDownColor: CHART_COLORS.mainDown,
      priceFormat: priceFormatOptions,
    });
    mainSeries.setData(data.mainCandles);
    if (data.markers.length > 0) mainSeries.setMarkers(data.markers);

    chart.timeScale().fitContent();

    const resizeObserver = new ResizeObserver((entries) => {
      if (entries.length === 0 || entries[0].target !== chartContainerRef.current) return;
      window.requestAnimationFrame(() => {
        if (chartRef.current) {
          chartRef.current.applyOptions({ height: entries[0].contentRect.height, width: entries[0].contentRect.width });
        }
      });
    });
    resizeObserver.observe(chartContainerRef.current);

    return () => {
      resizeObserver.disconnect();
      if (chartRef.current) {
        try { chartRef.current.remove(); } catch (e) { /* ignore */ }
        chartRef.current = null;
      }
    };
  }, [data]);

  return <div className="absolute inset-0 w-full h-full" ref={chartContainerRef} />;
});

const UploadArea = ({ onUpload, loading, error }) => (
  <div className="flex-1 flex items-center justify-center p-6 bg-gray-50">
    <div className="bg-white p-10 rounded-2xl border border-dashed border-gray-300 max-w-lg w-full text-center shadow-lg">
      <div className="mx-auto w-20 h-20 bg-blue-50 rounded-full flex items-center justify-center mb-6">
        <UploadCloudIcon className="w-10 h-10 text-blue-500" />
      </div>
      <h2 className="text-2xl font-semibold mb-2 text-gray-800">导入历史数据</h2>
      <p className="text-gray-500 mb-8 text-sm leading-relaxed">
        请上传由 MT4 脚本导出的 <span className="text-blue-600 font-medium">*_IndicatorsData.csv</span> 文件。<br />
        支持彩色K线、色带、Fox、Est、三清线数据。
      </p>

      <label className="relative inline-flex items-center justify-center px-8 py-3.5 text-base font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 cursor-pointer transition-all shadow-md hover:shadow-lg w-full">
        {loading ? (
          <span className="flex items-center gap-2"><Loader2Icon className="w-5 h-5 animate-spin" /> 解析数据中...</span>
        ) : "选择 CSV 文件"}
        <input type="file" accept=".csv" className="hidden" onChange={onUpload} disabled={loading} />
      </label>

      {error && (
        <div className="mt-6 p-4 bg-red-50 border border-red-200 rounded-lg flex items-start gap-3 text-left">
          <AlertCircleIcon className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
          <p className="text-sm text-red-600 leading-relaxed">{error}</p>
        </div>
      )}
    </div>
  </div>
);

// ==========================================
// 5. 主应用入口
// ==========================================
export default function App() {
  const [appState, setAppState] = useState({
    isReady: false, loading: false, error: "", fileName: "", chartData: null,
  });

  useEffect(() => {
    Promise.all([
      loadScript("https://unpkg.com/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js", "LightweightCharts"),
      loadScript("https://unpkg.com/papaparse@5.4.1/papaparse.min.js", "Papa"),
    ]).then(() => setAppState((s) => ({ ...s, isReady: true })))
      .catch(() => setAppState((s) => ({ ...s, error: "核心依赖加载失败，请检查网络。" })));
  }, []);

  const handleFileUpload = (event) => {
    const file = event.target.files[0];
    if (!file) return;
    
    setAppState((s) => ({ ...s, fileName: file.name, loading: true, error: "", chartData: null }));

    if (!file.name.toLowerCase().endsWith(".csv")) {
      event.target.value = "";
      return setAppState((s) => ({ ...s, loading: false, error: "只支持上传 .csv 格式的文件。" }));
    }

    window.Papa.parse(file, {
      header: true, skipEmptyLines: true,
      complete: (results) => {
        try {
          const transformed = transformData(results.data);
          setAppState((s) => ({ ...s, chartData: transformed, loading: false }));
        } catch (err) {
          console.error(err);
          setAppState((s) => ({ ...s, error: "数据解析失败，请确保CSV格式正确。", loading: false }));
        }
      },
      error: (err) => setAppState((s) => ({ ...s, error: `文件读取错误: ${err.message}`, loading: false })),
    });

    event.target.value = ""; 
  };

  const handleReset = () => setAppState((s) => ({ ...s, chartData: null, fileName: "", error: "" }));

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 flex flex-col font-sans">
      <header className="bg-white border-b border-gray-200 p-4 flex items-center justify-between shrink-0 shadow-sm z-10">
        <div className="flex items-center gap-3">
          <div className="bg-blue-600 p-2 rounded-lg"><BarChartIcon className="w-5 h-5 text-white" /></div>
          <h1 className="!m-0 !text-base !font-bold tracking-wide text-gray-800">FX分析复盘面板</h1>
        </div>

        {appState.chartData && (
          <div className="flex items-center gap-4">
            <span className="text-sm text-gray-600 bg-gray-100 px-3 py-1.5 rounded-md border border-gray-200 flex items-center gap-2">
              <FileSpreadsheetIcon className="w-4 h-4 text-blue-500" />
              {appState.fileName} ({appState.chartData.mainCandles.length} 根K线)
            </span>
            <button onClick={handleReset} className="px-4 py-2 bg-white border border-gray-300 hover:bg-gray-50 text-sm rounded-md transition-colors flex items-center gap-2 text-gray-700 shadow-sm">
              <RefreshCwIcon className="w-4 h-4" /> 重新上传
            </button>
          </div>
        )}
      </header>

      <main className="flex-1 flex flex-col relative overflow-hidden bg-gray-50">
        {!appState.isReady ? (
          <div className="flex-1 flex items-center justify-center p-6 text-gray-500">
            <div className="flex flex-col items-center gap-4"><Loader2Icon className="w-10 h-10 animate-spin text-blue-500" /> 正在加载引擎...</div>
          </div>
        ) : !appState.chartData ? (
          <UploadArea onUpload={handleFileUpload} loading={appState.loading} error={appState.error} />
        ) : (
          <ErrorBoundary>
            <div className="flex-1 relative w-full h-full border-t border-gray-200 shadow-inner">
              <ChartViewer data={appState.chartData} />
            </div>
          </ErrorBoundary>
        )}
      </main>
    </div>
  );
}

// ==========================================
// 6. SVG 图标集合
// ==========================================
function BarChartIcon(props) { return <svg {...props} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="20" x2="18" y2="10"></line><line x1="12" y1="20" x2="12" y2="4"></line><line x1="6" y1="20" x2="6" y2="14"></line></svg>; }
function UploadCloudIcon(props) { return <svg {...props} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242" /><path d="M12 12v9" /><path d="m16 16-4-4-4 4" /></svg>; }
function FileSpreadsheetIcon(props) { return <svg {...props} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2v4a2 2 0 0 0 2 2h4" /><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z" /><path d="M8 11h8" /><path d="M8 15h8" /><path d="M11 11v4" /></svg>; }
function AlertCircleIcon(props) { return <svg {...props} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>; }
function RefreshCwIcon(props) { return <svg {...props} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /></svg>; }
function Loader2Icon(props) { return <svg {...props} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>; }