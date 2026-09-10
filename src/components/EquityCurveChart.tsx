import React, { useEffect, useRef } from 'react';
import { createChart, ColorType, IChartApi, ISeriesApi, LineSeries, LineData, Time } from 'lightweight-charts';
import { PaperPosition, PaperTrade } from '../types';

interface EquityCurveChartProps {
  positions: PaperPosition[];
  trades: PaperTrade[];
  startingBalance: number;
}

export const EquityCurveChart: React.FC<EquityCurveChartProps> = ({ positions, trades, startingBalance }) => {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Line'> | null>(null);

  useEffect(() => {
    if (!chartContainerRef.current) return;

    // Initialize Chart
    const chart = createChart(chartContainerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#18181b' },
        textColor: '#a1a1aa',
      },
      grid: {
        vertLines: { color: '#27272a' },
        horzLines: { color: '#27272a' },
      },
      width: chartContainerRef.current.clientWidth,
      height: 260,
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderColor: '#27272a',
      },
      rightPriceScale: {
        borderColor: '#27272a',
      },
    });

    const series = chart.addSeries(LineSeries, {
      color: '#00FF88',
      lineWidth: 2,
      crosshairMarkerVisible: true,
      crosshairMarkerRadius: 4,
      lastValueVisible: true,
      priceLineVisible: false,
    });

    chartRef.current = chart;
    seriesRef.current = series;

    const handleResize = () => {
      if (chartContainerRef.current && chartRef.current) {
        chartRef.current.applyOptions({ width: chartContainerRef.current.clientWidth });
      }
    };

    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      chart.remove();
    };
  }, []);

  // Process data into equity curve
  useEffect(() => {
    if (!chartRef.current || !seriesRef.current) return;

    let currentEquity = startingBalance;
    const rawPoints: { time: number; value: number }[] = [];

    // Add starting point (24h ago or before earliest trade)
    const nowSec = Math.floor(Date.now() / 1000);
    const earliestTime = trades.length > 0 ? Math.min(...trades.map((t) => t.timestamp)) : Date.now() - 86400000;
    const startSec = Math.min(nowSec - 86400, Math.floor(earliestTime / 1000) - 60);

    rawPoints.push({ time: startSec, value: currentEquity });

    // Process trades chronologically
    const sortedTrades = [...trades].sort((a, b) => a.timestamp - b.timestamp);
    const openPositionCosts = new Map<string, number>();

    sortedTrades.forEach((trade) => {
      if (trade.action === 'BUY') {
        currentEquity -= trade.solAmount;
        openPositionCosts.set(trade.tokenMint, (openPositionCosts.get(trade.tokenMint) || 0) + trade.solAmount);
      } else if (trade.action === 'SELL') {
        currentEquity += trade.solAmount;
        const cost = openPositionCosts.get(trade.tokenMint) || 0;
        openPositionCosts.set(trade.tokenMint, Math.max(0, cost - trade.solAmount));
      }

      rawPoints.push({
        time: Math.floor(trade.timestamp / 1000),
        value: currentEquity,
      });
    });

    // Add current open position unrealized value
    const currentOpenValue = positions
      .filter((p) => p.status === 'OPEN')
      .reduce((sum, p) => sum + p.quantity * p.currentPriceSol, 0);

    const finalEquity = currentEquity + currentOpenValue;

    if (rawPoints.length > 0) {
      rawPoints.push({
        time: nowSec,
        value: finalEquity,
      });
    }

    // Sort by time and deduplicate timestamps for lightweight-charts strict monotonicity
    rawPoints.sort((a, b) => a.time - b.time);

    const deduplicatedData: LineData[] = [];
    for (const pt of rawPoints) {
      if (deduplicatedData.length === 0) {
        deduplicatedData.push({ time: pt.time as Time, value: pt.value });
      } else {
        const last = deduplicatedData[deduplicatedData.length - 1];
        if (last.time === pt.time) {
          deduplicatedData[deduplicatedData.length - 1] = { time: pt.time as Time, value: pt.value };
        } else if ((pt.time as number) > (last.time as number)) {
          deduplicatedData.push({ time: pt.time as Time, value: pt.value });
        }
      }
    }

    seriesRef.current.setData(deduplicatedData);
    chartRef.current.timeScale().fitContent();
  }, [trades, positions, startingBalance]);

  return (
    <div className="rounded bg-[#18181b] border border-[#27272a] p-3">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-[#00FF88] animate-pulse" />
          <h2 className="text-xs font-mono font-bold uppercase text-[#fafafa]">Portfolio Equity Curve</h2>
        </div>
        <span className="text-[10px] text-[#71717a] font-mono">Real-time P&L Tracking (SOL)</span>
      </div>
      <div ref={chartContainerRef} className="w-full" />
    </div>
  );
};
