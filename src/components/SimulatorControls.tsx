import { Pause, Play, Square } from 'lucide-react';
import { memo } from 'react';
import { createPortal } from 'react-dom';

interface SimulatorControlsProps {
  state: {
    isPlaying: boolean;
    speed: number;
  };
  currentBar: { time: number } | null;
  onTogglePlay: () => void;
  onSetSpeed: (speed: number) => void;
  onStop: () => void;
}

const SimulatorControls = memo(({
  state,
  currentBar,
  onTogglePlay,
  onSetSpeed,
  onStop,
}: SimulatorControlsProps) => {
  const formatTime = (ts: number | undefined) => {
    if (!ts) return "--/--/-- --:--:--";
    const d = new Date(ts);
    return d.toISOString().replace('T', ' ').substring(0, 19);
  };

  const targetNode = document.getElementById('header-controls');

  const content = (
    <div className="flex items-center gap-4 bg-gray-100 px-3 py-1.5 rounded-lg border border-gray-200">
      <span className="font-mono text-sm font-bold text-gray-800 tabular-nums min-w-[150px] text-center">
        {formatTime(currentBar?.time)}
      </span>
      <div className="flex items-center gap-2 border-l border-gray-300 pl-4">
        <button onClick={onTogglePlay} className="p-1.5 rounded-full hover:bg-gray-200 text-gray-700 bg-white shadow-sm border border-gray-200 transition-all">
          {state.isPlaying ? <Pause size={16} /> : <Play size={16} />}
        </button>

        <select
          value={state.speed}
          onChange={(e) => onSetSpeed(Number(e.target.value))}
          className="border border-gray-300 rounded px-2 py-1 flex-1 min-w-[90px] text-xs bg-white text-gray-700 shadow-sm outline-none"
        >
          <option value={2000}>极慢 (2s)</option>
          <option value={1000}>正常 (1s)</option>
          <option value={500}>快 (0.5s)</option>
          <option value={100}>极快 (0.1s)</option>
        </select>

        <button onClick={onStop} className="p-1.5 rounded-full hover:bg-red-50 hover:text-red-600 hover:border-red-200 text-red-500 tooltip bg-white shadow-sm border border-gray-200 transition-all ml-1" title="结束并进行结算">
          <Square size={16} />
        </button>
      </div>
    </div>
  );

  return targetNode ? createPortal(content, targetNode) : null;
});

export default SimulatorControls;
