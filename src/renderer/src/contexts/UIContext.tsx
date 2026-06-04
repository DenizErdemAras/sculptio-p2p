// src/renderer/src/contexts/UIContext.tsx
import React, { createContext, useState, useEffect, useCallback } from 'react';

export type View = 'menu' | 'settings' | 'lobby' | 'room' | 'sandbox';

export type UIAlert = {
    id: number;
    title: string;
    message: string;
    createdAt: number;
};

interface UIContextType {
    view: View;
    setView: (view: View) => void;

    alerts: UIAlert[];
    alert: (title: string, message?: string) => number;
    dismissAlert: (id: number) => void;
    clearAlerts: () => void;
    
    // Window Controls
    isFullscreen: boolean;
    isTitleBarHovered: boolean;
    minimizeWindow: () => void;
    maximizeWindow: () => void;
    closeWindow: () => void;
    toggleFullscreen: () => void;
}

export const UIContext = createContext<UIContextType | null>(null);

const ALERT_DURATION_MS = 6_000;

export const UIProvider = ({ children }: { children: React.ReactNode }) => {
    const [view, setView] = useState<View>('menu');
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [isTitleBarHovered, setIsTitleBarHovered] = useState(false);
    const [alerts, setAlerts] = useState<UIAlert[]>([]);

    const dismissAlert = useCallback((id: number) => {
        setAlerts(prev => prev.filter(alert => alert.id !== id));
    }, []);

    const clearAlerts = useCallback(() => {
        setAlerts([]);
    }, []);

    const alert = useCallback((title: string, message = '') => {
        const id =
            Date.now() +
            Math.floor(Math.random() * 1_000_000);

        const newAlert: UIAlert = {
            id,
            title,
            message,
            createdAt: Date.now()
        };

        setAlerts(prev => [...prev, newAlert]);

        window.setTimeout(() => {
            dismissAlert(id);
        }, ALERT_DURATION_MS);

        return id;
    }, [dismissAlert]);

    useEffect(() => {
        window.api.onTitlebarHover((hoverState: boolean) => {
            setIsTitleBarHovered(hoverState);
        });
    }, []);

    useEffect(() => {
        let unsubscribe: (() => void) | undefined;

        if (window.api && window.api.onFullscreenChange) {
            unsubscribe = window.api.onFullscreenChange((nativeFullscreenState) => {
                setIsFullscreen(nativeFullscreenState);
            });
        }

        return () => {
            if (unsubscribe) unsubscribe();
        };
    }, []);

    const minimizeWindow = () => {
        if (window.api && window.api.windowMinimize) window.api.windowMinimize();
    };

    const maximizeWindow = () => {
        if (window.api && window.api.windowMaximize) window.api.windowMaximize();
    };

    const closeWindow = () => {
        if (window.api && window.api.windowClose) window.api.windowClose();
    };

    const toggleFullscreen = () => {
        if (window.api && window.api.windowFullscreen) {
            window.api.windowFullscreen();
        }
    };

    return (
        <UIContext.Provider value={{
            view,
            setView,

            alerts,
            alert,
            dismissAlert,
            clearAlerts,

            isFullscreen,
            isTitleBarHovered,
            minimizeWindow,
            maximizeWindow,
            closeWindow,
            toggleFullscreen
        }}>
            {children}
        </UIContext.Provider>
    );
};