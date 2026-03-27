import { useCallback, useEffect, useRef, useState } from 'react';
import { TvBar } from '../utils/csvParser';
import CustomDatafeed from '../utils/datafeed';

export interface Position {
    id: string;
    type: 'LONG' | 'SHORT';
    entryPrice: number;
    entryTime: number;
}

export interface TradeRecord {
    id: string;
    type: 'LONG' | 'SHORT';
    entryTime: number;
    entryPrice: number;
    exitTime: number;
    exitPrice: number;
    pnl: number;
    commission: number;
    netPnl: number;
}

interface SimulatorState {
    isPlaying: boolean;
    speed: number;
    balance: number;
    equity: number;
    position: Position | null;
    tradeHistory: TradeRecord[];
    isFinished: boolean;
}

const CONTRACT_SIZE = 100000;
const FIX_COMMISSION = 6;

export function useSimulator(datafeed: CustomDatafeed | null) {
    const [state, setState] = useState<SimulatorState>({
        isPlaying: false,
        speed: 1000,
        balance: 1000,
        equity: 1000,
        position: null,
        tradeHistory: [],
        isFinished: false,
    });

    const [currentBar, setCurrentBar] = useState<TvBar | null>(null);
    const [tickIndex, setTickIndex] = useState<number>(0);

    const timerRef = useRef<number | null>(null);
    const stateRef = useRef(state);
    stateRef.current = state;
    const barRef = useRef(currentBar);
    barRef.current = currentBar;
    const datafeedRef = useRef(datafeed);
    datafeedRef.current = datafeed;
    const tickIndexRef = useRef(tickIndex);
    tickIndexRef.current = tickIndex;

    const calculateFloatingPnl = (pos: Position | null, currentPrice: number): number => {
        if (!pos) return 0;
        const diff = currentPrice - pos.entryPrice;
        return pos.type === 'LONG' ? diff * CONTRACT_SIZE : -diff * CONTRACT_SIZE;
    };

    const getEquity = (balance: number, pos: Position | null, currentPrice: number): number => {
        if (!pos) return balance;
        return balance + calculateFloatingPnl(pos, currentPrice) - FIX_COMMISSION;
    };

    const closePositionInternal = (currentState: SimulatorState, bar: TvBar | null): { newState: SimulatorState; trade: TradeRecord | null } => {
        const pos = currentState.position;
        if (!pos || !bar) return { newState: currentState, trade: null };

        const pnl = calculateFloatingPnl(pos, bar.close);
        const netPnl = pnl - FIX_COMMISSION;
        const newBalance = currentState.balance + netPnl;

        const trade: TradeRecord = {
            id: pos.id,
            type: pos.type,
            entryTime: pos.entryTime,
            entryPrice: pos.entryPrice,
            exitTime: bar.time,
            exitPrice: bar.close,
            pnl,
            commission: FIX_COMMISSION,
            netPnl,
        };

        const newState = {
            ...currentState,
            position: null,
            balance: newBalance,
            equity: newBalance,
            tradeHistory: [...currentState.tradeHistory, trade],
        };

        return { newState, trade };
    };

    const advanceTick = useCallback(() => {
        const df = datafeedRef.current;
        if (!df) return;

        const nextIndex = tickIndexRef.current + 1;
        if (nextIndex >= df.getTotalBars()) {
            setState(s => ({ ...s, isPlaying: false, isFinished: true }));
            return;
        }

        df.simulateTo(nextIndex);
        setTickIndex(nextIndex);

        const newBar = df.getCurrentBar();
        setCurrentBar(newBar);

        setState(prevState => {
            let updatedState = prevState;

            if (newBar && prevState.position) {
                const newEquity = getEquity(prevState.balance, prevState.position, newBar.close);
                updatedState = { ...updatedState, equity: newEquity };

                // 爆仓：净值不大于0就强制平仓
                if (newEquity <= 0) {
                    const { newState: closedState } = closePositionInternal(updatedState, newBar);
                    updatedState = closedState;
                }
            }

            return updatedState;
        });
    }, []);

    useEffect(() => {
        if (state.isPlaying) {
            if (timerRef.current) clearInterval(timerRef.current);
            timerRef.current = window.setInterval(advanceTick, state.speed);
        } else {
            if (timerRef.current) clearInterval(timerRef.current);
        }
        return () => {
            if (timerRef.current) clearInterval(timerRef.current);
        };
    }, [state.isPlaying, state.speed, advanceTick]);

    const togglePlay = () => setState(s => ({ ...s, isPlaying: !s.isPlaying }));

    const setSpeed = (ms: number) => setState(s => ({ ...s, speed: ms }));

    const openPosition = (type: 'LONG' | 'SHORT') => {
        const pos = stateRef.current.position;
        const bar = barRef.current;
        if (pos) {
            return false;
        }
        if (!bar) return false;

        const newPos: Position = {
            id: Math.random().toString(36).substr(2, 9),
            type,
            entryPrice: bar.close,
            entryTime: bar.time,
        };

        const newEquity = getEquity(stateRef.current.balance, newPos, bar.close);
        setState(s => ({
            ...s,
            position: newPos,
            equity: newEquity,
        }));

        return newPos;
    };

    const closePosition = () => {
        const pos = stateRef.current.position;
        const bar = barRef.current;
        if (!pos || !bar) return null;

        const { newState, trade } = closePositionInternal(stateRef.current, bar);
        setState(newState);
        return trade;
    };

    const initGame = (startIndex: number) => {
        if (!datafeedRef.current) return;
        setTickIndex(startIndex);
        datafeedRef.current.simulateTo(startIndex);
        setCurrentBar(datafeedRef.current.getCurrentBar());
        setState({
            isPlaying: false,
            speed: 1000,
            balance: 1000,
            equity: 1000,
            position: null,
            tradeHistory: [],
            isFinished: false,
        });
    };

    const exitGame = () => {
        setState(s => ({ ...s, isPlaying: false, isFinished: true }));
    };

    return {
        state,
        currentBar,
        tickIndex,
        actions: {
            togglePlay,
            setSpeed,
            openPosition,
            closePosition,
            initGame,
            exitGame
        }
    };
}
