import React from 'react';
import type { TradeRecord } from '../trading/types';

interface SettlementProps {
  balance: number;
  initialBalance: number;
  trades: TradeRecord[];
  onRestart: () => void;
  onExit: () => void;
}

const GameSettlementMenu: React.FC<SettlementProps> = ({
  balance,
  initialBalance,
  trades,
  onRestart,
  onExit
}) => {
  const netPnl = balance - initialBalance;
  const winTrades = trades.filter(t => t.netPnl > 0);
  const winRate = trades.length > 0 ? (winTrades.length / trades.length) * 100 : 0;

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4 backdrop-blur-sm">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-3xl overflow-hidden flex flex-col max-h-[90vh]">
        <div className="bg-blue-600 p-6 text-white text-center">
          <h2 className="text-3xl font-bold mb-2">回溯挑战结束</h2>
          <p className="text-blue-100">复盘统计</p>
        </div>

        <div className="p-6 flex-1 overflow-auto">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
            <div className="bg-gray-50 p-4 rounded-lg text-center border border-gray-100">
              <div className="text-gray-500 text-sm mb-1">最终资金</div>
              <div className="text-2xl font-bold text-gray-800">${balance.toFixed(2)}</div>
            </div>
            <div className="bg-gray-50 p-4 rounded-lg text-center border border-gray-100">
              <div className="text-gray-500 text-sm mb-1">净利润</div>
              <div className={`text-2xl font-bold ${netPnl >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                ${netPnl.toFixed(2)}
              </div>
            </div>
            <div className="bg-gray-50 p-4 rounded-lg text-center border border-gray-100">
              <div className="text-gray-500 text-sm mb-1">交易笔数</div>
              <div className="text-2xl font-bold text-gray-800">{trades.length}</div>
            </div>
            <div className="bg-gray-50 p-4 rounded-lg text-center border border-gray-100">
              <div className="text-gray-500 text-sm mb-1">胜率</div>
              <div className="text-2xl font-bold text-gray-800">{winRate.toFixed(1)}%</div>
            </div>
          </div>

          <h3 className="font-bold text-lg mb-3 border-b pb-2">交易记录</h3>
          {trades.length === 0 ? (
            <div className="text-center text-gray-400 py-8">本次挑战没有进行任何交易。</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="bg-gray-50 text-gray-600">
                  <tr>
                    <th className="p-3">类型</th>
                    <th className="p-3">入场价</th>
                    <th className="p-3">出场价</th>
                    <th className="p-3">毛利</th>
                    <th className="p-3">手续费</th>
                    <th className="p-3">净盈亏</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {trades.map((t, i) => (
                    <tr key={t.id} className="hover:bg-gray-50">
                      <td className="p-3">
                        <span className={`px-2 py-1 rounded text-xs font-bold ${t.type === 'LONG' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                          {t.type === 'LONG' ? '多' : '空'}
                        </span>
                      </td>
                      <td className="p-3">{t.entryPrice.toFixed(5)}</td>
                      <td className="p-3">{t.exitPrice.toFixed(5)}</td>
                      <td className="p-3">${t.pnl.toFixed(2)}</td>
                      <td className="p-3">${t.commission.toFixed(2)}</td>
                      <td className={`p-3 font-bold ${t.netPnl > 0 ? 'text-green-600' : 'text-red-600'}`}>
                        ${t.netPnl.toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="bg-gray-50 p-4 border-t flex justify-end gap-3">
          <button onClick={onExit} className="px-6 py-2 border border-gray-300 text-gray-700 font-medium rounded hover:bg-gray-100 transition">
            返回首页
          </button>
          <button onClick={onRestart} className="px-6 py-2 bg-blue-600 text-white font-medium rounded hover:bg-blue-700 shadow-sm transition">
            重新挑战
          </button>
        </div>
      </div>
    </div>
  );
};

export default GameSettlementMenu;
