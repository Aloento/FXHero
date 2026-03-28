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
    const { state, currentBar, actions } = useSimulator(datafeed);
    const [attemptId, setAttemptId] = useState(0);
    const [settlementReady, setSettlementReady] = useState(false);
    const finalizedAttemptRef = useRef<number | null>(null);

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

    const getRandomStartIndex = useCallback(() => {
        const totalBars = datafeed.getTotalBars();
        const minStart = Math.min(Math.floor(totalBars * 0.1) || 0, 1000);
        const maxStart = Math.max(minStart + 1, totalBars - 1440);
        return Math.floor(Math.random() * (maxStart - minStart) + minStart);
    }, [datafeed]);

    const handleChartReady = useCallback((widget: IChartingLibraryWidget) => {
        setTimeout(() => {
            try {
                widget.chart().executeActionById('timeScaleReset');
            } catch (e) {
                console.warn('Error executing time scale reset:', e);
            }
        }, 500);
    }, []);

    useEffect(() => {
        if (mode === 'game') {
            const startIdx = getRandomStartIndex();

            finalizedAttemptRef.current = null;
            setSettlementReady(false);
            brokerRef.current?.reset();
            actions.initGame(startIdx);
        } else {
            finalizedAttemptRef.current = null;
            setSettlementReady(false);
            datafeed.simulateTo(datafeed.getTotalBars() - 1);
            actions.initGame(datafeed.getTotalBars() - 1);
        }
    }, [actions.initGame, datafeed, getRandomStartIndex, mode]);

    useEffect(() => {
        if (mode !== 'game') {
            return;
        }

        if (!state.isFinished) {
            setSettlementReady(false);
            return;
        }

        if (finalizedAttemptRef.current !== attemptId) {
            brokerRef.current?.forceCloseAll();
            finalizedAttemptRef.current = attemptId;
        }

        setSettlementReady(true);
    }, [attemptId, mode, state.isFinished]);

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

            {state.isFinished && mode === 'game' && settlementReady && (
                <GameSettlementMenu
                    balance={brokerSnapshot.balance}
                    initialBalance={1000}
                    trades={brokerSnapshot.trades}
                    onRestart={() => {
                        const startIdx = getRandomStartIndex();

                        finalizedAttemptRef.current = null;
                        setSettlementReady(false);
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
