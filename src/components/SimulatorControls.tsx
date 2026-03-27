import { Pause, Play, Square } from 'lucide-react';
import { memo } from 'react';

const SimulatorControls = memo(({
    state,
    currentBar,
    onTogglePlay,
    onSetSpeed,
    onStop,
    onOpenLong,
    onOpenShort,
    onClosePosition
}: any) => {
    const formatTime = (ts: number | undefined) => {
        if (!ts) return "--/--/-- --:--:--";
        const d = new Date(ts);
        return d.toISOString().replace('T', ' ').substring(0, 19);
    };

    const pos = state.position;

    return (
        <div className="bg-white border-b border-gray-200 p-3 flex items-center justify-between shadow-sm z-20">

            {/* 左侧：交易控制 */}
            <div className="flex items-center gap-3">
                <button
                    onClick={onOpenLong}
                    disabled={pos !== null || !currentBar}
                    className="bg-green-600 hover:bg-green-700 disabled:bg-gray-300 disabled:cursor-not-allowed text-white px-4 py-2 rounded font-bold shadow-sm transition"
                >
                    做多 1手
                </button>
                <button
                    onClick={onOpenShort}
                    disabled={pos !== null || !currentBar}
                    className="bg-red-600 hover:bg-red-700 disabled:bg-gray-300 disabled:cursor-not-allowed text-white px-4 py-2 rounded font-bold shadow-sm transition"
                >
                    做空 1手
                </button>

                {pos && (
                    <div className="flex items-center gap-3 ml-4 bg-gray-100 p-2 rounded border border-gray-200">
                        <span className={`font-bold ${pos.type === 'LONG' ? 'text-green-600' : 'text-red-600'}`}>
                            当前持仓: {pos.type === 'LONG' ? '多' : '空'} 1手
                        </span>
                        <span className="text-gray-700 font-mono">
                            浮亏: <span className={state.equity - state.balance > 0 ? "text-green-600" : "text-red-600"}>
                                ${(state.equity - state.balance).toFixed(2)}
                            </span>
                        </span>
                        <button
                            onClick={onClosePosition}
                            className="bg-yellow-500 hover:bg-yellow-600 text-white px-3 py-1 rounded shadow-sm text-sm"
                        >
                            一键平仓
                        </button>
                    </div>
                )}
            </div>

            {/* 中间：播放控制 */}
            <div className="flex items-center gap-4">
                <button onClick={onTogglePlay} className="p-2 rounded-full hover:bg-gray-100 text-gray-700">
                    {state.isPlaying ? <Pause size={20} /> : <Play size={20} />}
                </button>

                <select
                    value={state.speed}
                    onChange={(e) => onSetSpeed(Number(e.target.value))}
                    className="border border-gray-300 rounded p-1 text-sm bg-white"
                >
                    <option value={2000}>极慢 (2s)</option>
                    <option value={1000}>正常 (1s)</option>
                    <option value={500}>快 (0.5s)</option>
                    <option value={100}>极快 (0.1s)</option>
                </select>

                <button onClick={onStop} className="p-2 rounded-full hover:bg-gray-100 text-red-500 tooltip" title="结束并进行结算">
                    <Square size={20} />
                </button>
            </div>

            {/* 右侧：状态面板 */}
            <div className="flex flex-col items-end">
                <span className="text-xl font-mono font-bold text-gray-800 tabular-nums">
                    {formatTime(currentBar?.time)}
                </span>
                <div className="text-sm font-semibold flex gap-4 mt-1">
                    <span className="text-gray-600">资金: ${state.balance.toFixed(2)}</span>
                    <span className="text-gray-600">净值: ${state.equity.toFixed(2)}</span>
                </div>
            </div>

        </div>
    );
});

export default SimulatorControls;
