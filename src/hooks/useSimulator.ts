import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
            setCurrentBar(df.getCurrentBar());
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

    const togglePlay = useCallback(() => {
        setState(s => {
            if (s.isFinished) {
                return s;
            }
            return { ...s, isPlaying: !s.isPlaying };
        });
    }, []);

    const play = useCallback(() => {
        setState(s => {
            if (s.isFinished) {
                return s;
            }
            return { ...s, isPlaying: true };
        });
    }, []);

    const pause = useCallback(() => {
        setState(s => ({ ...s, isPlaying: false }));
    }, []);

    const playAtSpeed = useCallback((ms: number) => {
        setState(s => {
            if (s.isFinished) {
                return s;
            }
            return { ...s, isPlaying: true, speed: ms };
        });
    }, []);

    const setSpeed = useCallback((ms: number) => {
        setState(s => ({ ...s, speed: ms }));
    }, []);

    const initGame = useCallback((startIndex: number) => {
        if (!datafeedRef.current) return;
        if (timerRef.current) {
            clearInterval(timerRef.current);
            timerRef.current = null;
        }
        setTickIndex(startIndex);
        datafeedRef.current.simulateTo(startIndex);
        setCurrentBar(datafeedRef.current.getCurrentBar());
        setState({
            isPlaying: false,
            speed: 1000,
            isFinished: false,
        });
    }, []);

    const exitGame = useCallback(() => {
        setState(s => ({ ...s, isPlaying: false, isFinished: true }));
    }, []);

    const actions = useMemo(() => ({
        togglePlay,
        play,
        pause,
        playAtSpeed,
        setSpeed,
        initGame,
        exitGame,
    }), [exitGame, initGame, pause, play, playAtSpeed, setSpeed, togglePlay]);

    return {
        state,
        currentBar,
        tickIndex,
        actions,
    };
}
