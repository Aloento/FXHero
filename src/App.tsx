import { AlertCircle, BarChart3, FileSpreadsheet, LayoutDashboard, Loader2, PlayCircle, UploadCloud } from "lucide-react";
import React, { useState } from "react";
import SimulatorView from "./components/SimulatorView";
import { parseCsvFile, ParsedCsvData } from "./utils/csvParser";
import CustomDatafeed from "./utils/datafeed";

const UploadArea = ({ onUpload, loading, error }: any) => (
  <div className="flex-1 flex items-center justify-center p-6 bg-gray-50">
    <div className="bg-white p-10 rounded-2xl border border-dashed border-gray-300 max-w-lg w-full text-center shadow-lg">
      <div className="mx-auto w-20 h-20 bg-blue-50 rounded-full flex items-center justify-center mb-6">
        <UploadCloud className="w-10 h-10 text-blue-500" />
      </div>
      <h2 className="text-2xl font-semibold mb-2 text-gray-800">导入历史数据</h2>
      <p className="text-gray-500 mb-8 text-sm leading-relaxed">
        请上传由 MT4 等系统导出的 <span className="text-blue-600 font-medium">CSV</span> 历史行情文件。<br />
      </p>

      <label className="relative inline-flex items-center justify-center px-8 py-3.5 text-base font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 cursor-pointer transition-all shadow-md hover:shadow-lg w-full">
        {loading ? (
          <span className="flex items-center gap-2"><Loader2 className="w-5 h-5 animate-spin" /> 解析数据中...</span>
        ) : "选择 CSV 文件"}
        <input type="file" accept=".csv" className="hidden" onChange={onUpload} disabled={loading} />
      </label>

      {error && (
        <div className="mt-6 p-4 bg-red-50 border border-red-200 rounded-lg flex items-start gap-3 text-left">
          <AlertCircle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
          <p className="text-sm text-red-600 leading-relaxed">{error}</p>
        </div>
      )}
    </div>
  </div>
);

type AppMode = 'idle' | 'mode_select' | 'replay' | 'game';

export default function App() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [fileName, setFileName] = useState("");
  const [parsedData, setParsedData] = useState<ParsedCsvData | null>(null);
  const [datafeed, setDatafeed] = useState<CustomDatafeed | null>(null);
  const [mode, setMode] = useState<AppMode>('idle');

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setLoading(true);
    setError("");
    setFileName(file.name);
    setParsedData(null);
    setDatafeed(null);

    if (!file.name.toLowerCase().endsWith(".csv")) {
      event.target.value = "";
      setError("只支持上传 .csv 格式的文件。");
      setLoading(false);
      return;
    }

    try {
      const data = await parseCsvFile(file);
      setParsedData(data);
      setMode('mode_select');
    } catch (err: any) {
      console.error(err);
      setError(err.message || "解析失败");
    } finally {
      setLoading(false);
      event.target.value = "";
    }
  };

  const startMode = (selectedMode: 'replay' | 'game') => {
    if (parsedData) {
      const df = new CustomDatafeed(parsedData.bars, parsedData.precision, parsedData.minMove);
      setDatafeed(df);
      setMode(selectedMode);
    }
  };

  const handleReset = () => {
    setMode('idle');
    setParsedData(null);
    setDatafeed(null);
    setFileName("");
  };

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 flex flex-col font-sans">
      <header className="bg-white border-b border-gray-200 p-4 flex items-center justify-between shrink-0 shadow-sm z-10 w-full">
        <div className="flex items-center gap-3">
          <div className="bg-blue-600 p-2 rounded-lg"><BarChart3 className="w-5 h-5 text-white" /></div>
          <h1 className="!m-0 !text-base !font-bold tracking-wide text-gray-800">FX 分析复盘模拟器</h1>
        </div>

        {parsedData && (
          <div className="flex items-center gap-4">
            <span className="text-sm text-gray-600 bg-gray-100 px-3 py-1.5 rounded-md border border-gray-200 flex items-center gap-2">
              <FileSpreadsheet className="w-4 h-4 text-blue-500" />
              {fileName} ({parsedData.bars.length} 根K线)
            </span>
            <button onClick={handleReset} className="px-4 py-2 bg-white border border-gray-300 hover:bg-gray-50 text-sm rounded-md transition-colors flex items-center gap-2 text-gray-700 shadow-sm">
              重新上传
            </button>
          </div>
        )}
      </header>

      <main className="flex-1 flex flex-col relative bg-gray-50 h-[calc(100vh-73px)]">
        {mode === 'idle' && (
          <UploadArea onUpload={handleFileUpload} loading={loading} error={error} />
        )}

        {mode === 'mode_select' && (
          <div className="flex-1 flex items-center justify-center p-6 bg-gray-50">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-4xl w-full">
              <div
                className="bg-white border hover:border-blue-500 rounded-xl p-8 cursor-pointer shadow-sm hover:shadow-lg transition-all group"
                onClick={() => startMode('replay')}
              >
                <div className="w-16 h-16 bg-blue-50 rounded-full flex items-center justify-center mb-6 group-hover:scale-110 transition-transform">
                  <LayoutDashboard className="w-8 h-8 text-blue-600" />
                </div>
                <h3 className="text-xl font-bold mb-3 text-gray-800">复盘模式</h3>
                <p className="text-gray-500">
                  一次性加载全部历史数据。支持使用高级图表画线工具进行静态技术分析和复盘。
                </p>
              </div>

              <div
                className="bg-white border hover:border-green-500 rounded-xl p-8 cursor-pointer shadow-sm hover:shadow-lg transition-all group"
                onClick={() => startMode('game')}
              >
                <div className="w-16 h-16 bg-green-50 rounded-full flex items-center justify-center mb-6 group-hover:scale-110 transition-transform">
                  <PlayCircle className="w-8 h-8 text-green-600" />
                </div>
                <h3 className="text-xl font-bold mb-3 text-gray-800">回溯挑战 (模拟交易)</h3>
                <p className="text-gray-500">
                  像游戏一样动态推进历史K线，设置了 $1000 初始资金。在未知后市的情况下进行买卖挑战。
                </p>
              </div>
            </div>
          </div>
        )}

        {(mode === 'replay' || mode === 'game') && datafeed && (
          <SimulatorView
            datafeed={datafeed}
            mode={mode}
            onExit={() => setMode('mode_select')}
          />
        )}
      </main>
    </div>
  );
}
