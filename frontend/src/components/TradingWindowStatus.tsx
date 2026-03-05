/**
 * Trading Window Status - Shows if current time/day is good for signals
 * 
 * Displays:
 * - Green: Currently in good trading window (signals expected)
 * - Red: Bad time/day (don't wait for signals)
 * - Yellow: Marginal (some signals may come through)
 * - Next good window time
 */

import { useEffect, useState } from 'react';

interface GateConfig {
  enabled: boolean;
  blockedHours: number[];
  blockedDays: string[];
  allowedSymbols: string[];
}

interface WindowStatus {
  isGood: boolean;
  status: 'excellent' | 'good' | 'marginal' | 'blocked';
  message: string;
  details: string[];
  nextGoodWindow: string | null;
  currentHour: number;
  currentDay: string;
}

const DEFAULT_BLOCKED_HOURS = [0, 11, 14, 15, 16, 17, 18, 19, 20, 21];
const DEFAULT_BLOCKED_DAYS = ['Monday', 'Tuesday', 'Saturday'];

const EXCELLENT_HOURS = [5, 7];     // 85%+ win rate
const GOOD_HOURS = [1, 2, 9, 12];   // 50-85% win rate

export function useTradingWindowStatus(): WindowStatus {
  const [status, setStatus] = useState<WindowStatus>({
    isGood: false,
    status: 'blocked',
    message: 'Checking...',
    details: [],
    nextGoodWindow: null,
    currentHour: new Date().getUTCHours(),
    currentDay: new Date().toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }),
  });

  useEffect(() => {
    const checkWindow = () => {
      const now = new Date();
      const hourUtc = now.getUTCHours();
      const dayName = now.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
      
      // Fetch gate config
      fetch('/api/gate/config')
        .then(r => r.json())
        .then(data => {
          const config: GateConfig = data?.config || {
            enabled: true,
            blockedHours: DEFAULT_BLOCKED_HOURS,
            blockedDays: DEFAULT_BLOCKED_DAYS,
            allowedSymbols: [],
          };

          if (!config.enabled) {
            setStatus({
              isGood: true,
              status: 'good',
              message: 'Gate Disabled - All Signals Allowed',
              details: ['Hard gate is turned off'],
              nextGoodWindow: null,
              currentHour: hourUtc,
              currentDay: dayName,
            });
            return;
          }

          const blockedHours = config.blockedHours || DEFAULT_BLOCKED_HOURS;
          const blockedDays = config.blockedDays || DEFAULT_BLOCKED_DAYS;

          const isBlockedHour = blockedHours.includes(hourUtc);
          const isBlockedDay = blockedDays.includes(dayName);
          
          const isExcellentHour = EXCELLENT_HOURS.includes(hourUtc);
          const isGoodHour = GOOD_HOURS.includes(hourUtc) || isExcellentHour;

          let windowStatus: WindowStatus['status'] = 'blocked';
          let message = '';
          let details: string[] = [];
          let isGood = false;

          if (isBlockedDay) {
            windowStatus = 'blocked';
            message = '❌ Bad Day for Trading';
            details = [`${dayName} has <30% historical win rate`, 'No signals expected today'];
          } else if (isBlockedHour) {
            windowStatus = 'blocked';
            message = '❌ Bad Hour for Trading';
            details = [`${hourUtc}:00 UTC has <40% win rate`, 'Signals blocked during this hour'];
          } else if (isExcellentHour) {
            windowStatus = 'excellent';
            message = '🎯 EXCELLENT Trading Window';
            details = ['85%+ historical win rate', 'High probability signals expected'];
            isGood = true;
          } else if (isGoodHour) {
            windowStatus = 'good';
            message = '✅ Good Trading Window';
            details = ['50%+ historical win rate', 'Quality signals may arrive'];
            isGood = true;
          } else {
            windowStatus = 'marginal';
            message = '⚠️ Marginal Window';
            details = ['Limited historical data', 'Few signals expected'];
            isGood = true;
          }

          // Calculate next good window
          const nextGoodWindow = calculateNextGoodWindow(blockedHours, blockedDays);

          setStatus({
            isGood,
            status: windowStatus,
            message,
            details,
            nextGoodWindow,
            currentHour: hourUtc,
            currentDay: dayName,
          });
        })
        .catch(() => {
          // Fallback if API fails
          setStatus({
            isGood: false,
            status: 'blocked',
            message: '⚠️ Unable to check trading window',
            details: ['API error - check connection'],
            nextGoodWindow: null,
            currentHour: hourUtc,
            currentDay: dayName,
          });
        });
    };

    checkWindow();
    const interval = setInterval(checkWindow, 60000); // Update every minute

    return () => clearInterval(interval);
  }, []);

  return status;
}

function calculateNextGoodWindow(blockedHours: number[], blockedDays: string[]): string | null {
  const now = new Date();
  let checkTime = new Date(now);
  
  // Check next 48 hours
  for (let i = 0; i < 48; i++) {
    const hour = checkTime.getUTCHours();
    const day = checkTime.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
    
    if (!blockedDays.includes(day) && !blockedHours.includes(hour)) {
      const dayName = checkTime.toDateString() === now.toDateString() 
        ? 'Today' 
        : checkTime.toDateString() === new Date(now.getTime() + 86400000).toDateString()
          ? 'Tomorrow'
          : day;
      return `${dayName} at ${hour}:00 UTC`;
    }
    
    checkTime.setHours(checkTime.getHours() + 1);
  }
  
  return null;
}

interface TradingWindowStatusProps {
  compact?: boolean;
}

export function TradingWindowStatus({ compact = false }: TradingWindowStatusProps) {
  const status = useTradingWindowStatus();

  const statusColors = {
    excellent: 'bg-emerald-500/20 border-emerald-500/40 text-emerald-300',
    good: 'bg-cyan-500/20 border-cyan-500/40 text-cyan-300',
    marginal: 'bg-amber-500/20 border-amber-500/40 text-amber-300',
    blocked: 'bg-rose-500/20 border-rose-500/40 text-rose-300',
  };

  const statusIcons = {
    excellent: '🎯',
    good: '✅',
    marginal: '⚠️',
    blocked: '❌',
  };

  if (compact) {
    return (
      <div className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border ${statusColors[status.status]}`}>
        <span>{statusIcons[status.status]}</span>
        <span className="text-xs font-medium">{status.message}</span>
        {status.nextGoodWindow && !status.isGood && (
          <span className="text-[10px] opacity-70">
            (Next: {status.nextGoodWindow})
          </span>
        )}
      </div>
    );
  }

  return (
    <div className={`rounded-xl border p-4 ${statusColors[status.status]}`}>
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold">
            <span className="text-lg">{statusIcons[status.status]}</span>
            {status.message}
          </div>
          
          <div className="mt-2 text-xs opacity-80 space-y-0.5">
            {status.details.map((detail, i) => (
              <div key={i}>• {detail}</div>
            ))}
          </div>

          <div className="mt-3 text-[10px] opacity-60">
            Current: {status.currentDay} {status.currentHour}:00 UTC
          </div>
        </div>

        {status.nextGoodWindow && !status.isGood && (
          <div className="text-right">
            <div className="text-[10px] opacity-70 uppercase tracking-wider">Next Window</div>
            <div className="text-sm font-medium">{status.nextGoodWindow}</div>
          </div>
        )}
      </div>

      {/* Visual timeline of upcoming hours */}
      <div className="mt-4">
        <div className="flex gap-1">
          {Array.from({ length: 12 }, (_, i) => {
            const hour = (status.currentHour + i) % 24;
            const isBlocked = !status.isGood && i === 0;
            const isNextGood = status.nextGoodWindow?.includes(`${hour}:00`);
            
            return (
              <div
                key={i}
                className={`flex-1 h-1.5 rounded-full ${
                  i === 0 
                    ? status.isGood ? 'bg-emerald-400' : 'bg-rose-400'
                    : isNextGood
                      ? 'bg-cyan-400/50'
                      : 'bg-white/10'
                }`}
                title={`${hour}:00 UTC`}
              />
            );
          })}
        </div>
        <div className="flex justify-between text-[9px] opacity-40 mt-1">
          <span>Now</span>
          <span>+12h</span>
        </div>
      </div>
    </div>
  );
}
