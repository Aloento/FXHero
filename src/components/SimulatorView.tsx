import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { IChartingLibraryWidget } from '../charting_library';
import { useSimulator } from '../hooks/useSimulator';
import { LocalCsvBroker, type BrokerSnapshot } from '../trading/localCsvBroker';
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
    const [attemptId, setAttemptId] = useState(0);

    const brokerRef = useRef<LocalCsvBroker | null>(null);
    if (!brokerRef.current) {
        brokerRef.current = new LocalCsvBroker(datafeed);
    }

    const [brokerSnapshot, setBrokerSnapshot] = useState<BrokerSnapshot>(brokerRef.current.getSnapshot());

    useEffect(() => {
        const broker = brokerRef.current;
        if (!broker) return;
        const unsubscribe = broker.subscribeSnapshot(setBrokerSnapshot);
        return unsubscribe;
    }, []);

    useEffect(() => {
        return () => {
            brokerRef.current?.dispose();
            brokerRef.current = null;
        };
    }, []);

    const tradingConfig = useMemo(() => {
        const broker = brokerRef.current;
        if (!broker || mode !== 'game') {
            return undefined;
        }
        return {
            brokerConfig: broker.getWidgetBrokerConfig(),
            brokerFactory: broker.createBrokerFactory(),
        };
    }, [mode]);

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
            const totalBars = datafeed.getTotalBars();
            // 随机选择起点，留出足够后市（如一天1M数据=1440根K线）与前市（为了均线等指标预热）
            const minStart = Math.min(Math.floor(totalBars * 0.1) || 0, 1000);
            const maxStart = Math.max(minStart + 1, totalBars - 1440);
            const startIdx = Math.floor(Math.random() * (maxStart - minStart) + minStart);

            brokerRef.current?.reset();
            actions.initGame(startIdx);
        } else {
            // 复盘模式，直接显示全部
            datafeed.simulateTo(datafeed.getTotalBars() - 1);
            actions.initGame(datafeed.getTotalBars() - 1);
        }
    }, [mode]);

    // 自动平仓
    useEffect(() => {
        if (state.isFinished && mode === 'game') {
            brokerRef.current?.forceCloseAll();
        }
    }, [state.isFinished, mode]);

    return (
        <div className="flex-1 flex flex-col w-full h-full relative">
            {mode === 'game' && (
                <SimulatorControls
                    state={state}
                    currentBar={currentBar}
                    onTogglePlay={actions.togglePlay}
                    onSetSpeed={actions.setSpeed}
                    onStop={() => {
                        brokerRef.current?.forceCloseAll();
                        actions.exitGame();
                    }}
                />
            )}

            <div className="flex-1 min-h-0 relative">
                <AdvancedChart
                    key={attemptId}
                    datafeed={datafeed}
                    onChartReady={handleChartReady}
                    trading={tradingConfig}
                />
            </div>

            {state.isFinished && mode === 'game' && (
                <GameSettlementMenu
                    balance={brokerSnapshot.balance}
                    initialBalance={1000}
                    trades={brokerSnapshot.trades}
                    onRestart={() => {
                        const totalBars = datafeed.getTotalBars();
                        const minStart = Math.min(Math.floor(totalBars * 0.1) || 0, 1000);
                        const maxStart = Math.max(minStart + 1, totalBars - 1440);
                        const startIdx = Math.floor(Math.random() * (maxStart - minStart) + minStart);

                        brokerRef.current?.reset();
                        actions.initGame(startIdx);
                        setAttemptId(a => a + 1);
                    }}
                    onExit={onExit}
                />
            )}
        </div>
    );
};

export default SimulatorView;
