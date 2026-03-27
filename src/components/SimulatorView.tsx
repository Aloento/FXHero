import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { IChartingLibraryWidget, IPositionLineAdapter } from '../charting_library';
import { useSimulator } from '../hooks/useSimulator';
import CustomDatafeed from '../utils/datafeed';
import AdvancedChart from './AdvancedChart';
import GameSettlementMenu from './GameSettlementMenu';
import SimulatorControls from './SimulatorControls';

interface SimulatorViewProps {
    datafeed: CustomDatafeed;
    mode: 'replay' | 'game';
    onExit: () => void;
}

const SimulatorView: React.FC<SimulatorViewProps> = ({ datafeed, mode, onExit }) => {
    const { state, currentBar, tickIndex, actions } = useSimulator(datafeed);
    const [chartWidget, setChartWidget] = useState<IChartingLibraryWidget | null>(null);

    // 保存 TradingView 图表上绘制的持仓线实例
    const positionLineRef = useRef<IPositionLineAdapter | null>(null);

    // 用useCallback包装onChartReady，避免不必要的重新渲染
    const handleChartReady = useCallback((widget: IChartingLibraryWidget) => {
        console.log('[SimulatorView] Chart widget is ready');
        setChartWidget(widget);
        // 这里强制图表到达最新位置
        setTimeout(() => {
            try {
                widget.chart().executeActionById("timeScaleReset");
                console.log('[SimulatorView] Time scale reset executed');
            } catch (e) {
                console.warn('Error executing time scale reset:', e);
            }
        }, 500);
    }, []);

    // 初始化模式
    useEffect(() => {
        if (mode === 'game') {
            // 从总数据的 20% 处开始回溯挑战
            const startIdx = Math.floor(datafeed.getTotalBars() * 0.2);
            actions.initGame(startIdx);
        } else {
            // 复盘模式，直接显示全部
            datafeed.simulateTo(datafeed.getTotalBars() - 1);
            actions.initGame(datafeed.getTotalBars() - 1);
        }
    }, [mode]);

    // 根据持仓状态绘制持仓线
    useEffect(() => {
        if (!chartWidget) return;

        if (state.position) {
            if (!positionLineRef.current) {
                chartWidget.chart().createPositionLine().then(positionLine => {
                    if (positionLine) {
                        positionLineRef.current = positionLine;
                        positionLine
                            .onClose(() => {
                                handleClosePosition();
                            })
                            .setText(state.position?.type === 'LONG' ? "做多 1手" : "做空 1手")
                            .setQuantity("")
                            .setPrice(state.position?.entryPrice ?? 0)
                            .setExtendLeft(false)
                            .setLineStyle(0) // solid
                            .setLineColor(state.position?.type === 'LONG' ? "#26A69A" : "#EF5350")
                            .setBodyTextColor("#fff")
                            .setBodyBackgroundColor(state.position?.type === 'LONG' ? "#26A69A" : "#EF5350")
                            .setBodyBorderColor(state.position?.type === 'LONG' ? "#26A69A" : "#EF5350");
                    }
                }).catch(console.error);
            } else {
                const pnl = (state.equity - state.balance).toFixed(2);
                positionLineRef.current.setText(`${state.position.type === 'LONG' ? "做多" : "做空"} (盈亏: $${pnl})`);
            }
        } else {
            if (positionLineRef.current) {
                try { positionLineRef.current.remove(); } catch (e) { }
                positionLineRef.current = null;
            }
        }
    }, [chartWidget, state.position, state.equity]);

    const handleOpenLong = () => {
        actions.openPosition('LONG');
    };

    const handleOpenShort = () => {
        actions.openPosition('SHORT');
    };

    const handleClosePosition = () => {
        const trade = actions.closePosition();
        if (trade && chartWidget) {
            // 平仓后在图表上做标记
            const chart = chartWidget.chart();

            // 入场标记
            chart.createExecutionShape().then(shape => {
                shape
                    .setText(trade.type === 'LONG' ? "Buy" : "Sell")
                    .setTextColor("rgba(0,0,0,1)")
                    .setArrowColor(trade.type === 'LONG' ? "rgba(38, 166, 154, 1)" : "rgba(239, 83, 80, 1)")
                    .setDirection(trade.type === 'LONG' ? "buy" : "sell")
                    .setTime(trade.entryTime / 1000)
                    .setPrice(trade.entryPrice);
            }).catch(console.error);

            // 出场标记
            chart.createExecutionShape().then(shape => {
                shape
                    .setText(trade.type === 'LONG' ? `Close Long\nPnL: $${trade.netPnl.toFixed(2)}` : `Close Short\nPnL: $${trade.netPnl.toFixed(2)}`)
                    .setTooltip(`Entry: ${trade.entryPrice}\nExit: ${trade.exitPrice}\nNet PnL: $${trade.netPnl.toFixed(2)}`)
                    .setTextColor(trade.netPnl >= 0 ? "rgba(0,0,0,1)" : "rgba(0,0,0,1)")
                    .setArrowColor(trade.type === 'LONG' ? "rgba(239, 83, 80, 1)" : "rgba(38, 166, 154, 1)")
                    .setDirection(trade.type === 'LONG' ? "sell" : "buy")
                    .setTime(trade.exitTime / 1000)
                    .setPrice(trade.exitPrice);
            }).catch(console.error);
        }
    };

    return (
        <div className="flex-1 flex flex-col w-full h-full relative">
            <div className="flex-1 min-h-0 relative">
                <AdvancedChart
                    datafeed={datafeed}
                    onChartReady={handleChartReady}
                />
            </div>

            {mode === 'game' && (
                <SimulatorControls
                    state={state}
                    currentBar={currentBar}
                    onTogglePlay={actions.togglePlay}
                    onSetSpeed={actions.setSpeed}
                    onStop={actions.exitGame}
                    onOpenLong={handleOpenLong}
                    onOpenShort={handleOpenShort}
                    onClosePosition={handleClosePosition}
                />
            )}

            {state.isFinished && mode === 'game' && (
                <GameSettlementMenu
                    balance={state.balance}
                    initialBalance={1000}
                    trades={state.tradeHistory}
                    onRestart={() => actions.initGame(Math.floor(datafeed.getTotalBars() * 0.2))}
                    onExit={onExit}
                />
            )}
        </div>
    );
};

export default SimulatorView;
