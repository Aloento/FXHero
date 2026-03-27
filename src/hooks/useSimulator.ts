import { useCallback, useEffect, useRef, useState } from 'react';
import { TvBar } from '../utils/csvParser';
import CustomDatafeed from '../utils/datafeed';

interface SimulatorState {
    isPlaying: boolean;
    speed: number;
    isFinished: boolean;
}

export function useSimulator(datafeed: CustomDatafeed | null) {
    const [state, setState] = useState<SimulatorState>({
        isPlaying: false,
        speed: 1000,
        isFinished: false,
    });

    const [currentBar, setCurrentBar] = useState<TvBar | null>(null);
    const [tickIndex, setTickIndex] = useState<number>(0);

    const timerRef = useRef<number | null>(null);
    const datafeedRef = useRef(datafeed);
    datafeedRef.current = datafeed;
    const tickIndexRef = useRef(tickIndex);
    tickIndexRef.current = tickIndex;

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
        setCurrentBar(df.getCurrentBar());
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

    const initGame = (startIndex: number) => {
        if (!datafeedRef.current) return;
        setTickIndex(startIndex);
        datafeedRef.current.simulateTo(startIndex);
        setCurrentBar(datafeedRef.current.getCurrentBar());
        setState({
            isPlaying: false,
            speed: 1000,
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
            initGame,
            exitGame
        }
    };
}
