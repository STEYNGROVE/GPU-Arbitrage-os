import React, { useState } from 'react';
import { DePINToken, BinanceHedgePosition } from '../types/arbitrage';
import {
  X,
  ShieldCheck,
  Zap,
  TrendingDown,
  DollarSign,
  Lock,
  CheckCircle2
} from 'lucide-react';

interface HedgeModalProps {
  token: DePINToken | null;
  isOpen: boolean;
  onClose: () => void;
  onConfirmHedge: (hedge: BinanceHedgePosition) => void;
}

export const HedgeModal: React.FC<HedgeModalProps> = ({
  token,
  isOpen,
  onClose,
  onConfirmHedge,
}) => {
  const [leverage, setLeverage] = useState<number>(3);
  const [sizeTokens, setSizeTokens] = useState<number>(1000);
  const [side, setSide] = useState<'SHORT' | 'LONG'>('SHORT');
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  if (!isOpen || !token) return null;

  const sizeUsd = sizeTokens * token.spotPriceUsd;
  const initialMarginReq = sizeUsd / leverage;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setTimeout(() => {
      const newHedge: BinanceHedgePosition = {
        id: `HDG-${Date.now().toString(36).toUpperCase()}-${token.symbol}`,
        pair: `${token.symbol}USDT`,
        side,
        sizeTokens,
        sizeUsd,
        entryPrice: token.spotPriceUsd,
        markPrice: token.spotPriceUsd,
        unrealizedPnl: 0,
        leverage,
        hedgeRatio: 1.0,
        linkedContractId: `CTR-${Date.now().toString(36).toUpperCase()}-GPU`,
        purpose: `Delta neutral lock on ${token.name} compute yield`,
      };
      onConfirmHedge(newHedge);
      setIsSubmitting(false);
      onClose();
    }, 600);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
      <div className="w-full max-w-lg bg-[#0b0f19] border border-slate-800 rounded-xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-900/60">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded bg-amber-950 flex items-center justify-center text-amber-400 border border-amber-800">
              <ShieldCheck className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-white">Binance USD-M Futures Delta Hedge</h3>
              <p className="text-[11px] text-slate-400 font-mono">
                Pair: {token.futuresHedgingPair}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4 text-xs">
          <div className="p-3 bg-slate-900/80 border border-slate-800 rounded flex items-center justify-between">
            <div>
              <span className="font-bold text-slate-200 text-sm">{token.symbol}</span>
              <span className="text-slate-400 ml-2">({token.name})</span>
              <div className="text-[11px] text-slate-400 mt-0.5">{token.impliedComputeGpu}</div>
            </div>
            <div className="text-right font-mono">
              <div className="font-bold text-white text-sm">${token.spotPriceUsd.toFixed(2)}</div>
              <div className="text-[11px] text-emerald-400">{token.change24h > 0 ? '+' : ''}{token.change24h}%</div>
            </div>
          </div>

          {/* Position Side */}
          <div className="space-y-1.5">
            <label className="text-slate-300 font-medium">Hedge Position Side</label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setSide('SHORT')}
                className={`py-2 text-xs font-bold rounded border transition-colors flex items-center justify-center gap-1.5 ${
                  side === 'SHORT'
                    ? 'bg-rose-950/60 border-rose-600 text-rose-300'
                    : 'bg-slate-950 border-slate-800 text-slate-400'
                }`}
              >
                <TrendingDown className="w-3.5 h-3.5" />
                <span>SHORT (Delta Neutral Hedge)</span>
              </button>
              <button
                type="button"
                onClick={() => setSide('LONG')}
                className={`py-2 text-xs font-bold rounded border transition-colors flex items-center justify-center gap-1.5 ${
                  side === 'LONG'
                    ? 'bg-emerald-950/60 border-emerald-600 text-emerald-300'
                    : 'bg-slate-950 border-slate-800 text-slate-400'
                }`}
              >
                <span>LONG (Speculative Basis)</span>
              </button>
            </div>
          </div>

          {/* Size in Tokens */}
          <div className="space-y-1.5">
            <div className="flex justify-between">
              <label className="text-slate-300 font-medium">Hedge Size ({token.symbol} Tokens)</label>
              <span className="font-mono text-slate-400">${sizeUsd.toFixed(2)} USD</span>
            </div>
            <input
              type="number"
              min="10"
              step="50"
              value={sizeTokens}
              onChange={(e) => setSizeTokens(Math.max(1, Number(e.target.value)))}
              className="w-full px-3 py-1.5 bg-slate-950 border border-slate-700 rounded text-slate-100 font-mono text-xs focus:outline-none focus:border-amber-400"
            />
          </div>

          {/* Leverage Slider */}
          <div className="space-y-1.5">
            <div className="flex justify-between">
              <span className="text-slate-300 font-medium">Binance Futures Leverage:</span>
              <span className="font-mono text-amber-400 font-bold">{leverage}x</span>
            </div>
            <input
              type="range"
              min="1"
              max="20"
              value={leverage}
              onChange={(e) => setLeverage(Number(e.target.value))}
              className="w-full accent-amber-400 cursor-pointer h-1.5 bg-slate-800 rounded-lg"
            />
            <div className="flex justify-between text-[10px] text-slate-500 font-mono">
              <span>1x (Isolated)</span>
              <span>5x</span>
              <span>10x</span>
              <span>20x (Max)</span>
            </div>
          </div>

          {/* Financial summary */}
          <div className="p-3 bg-slate-950/80 border border-slate-800 rounded space-y-1.5 text-xs">
            <div className="flex justify-between text-slate-300">
              <span>Required Margin Collateral:</span>
              <span className="font-mono text-amber-400 font-bold">${initialMarginReq.toFixed(2)} USDT</span>
            </div>
            <div className="flex justify-between text-slate-400 text-[11px]">
              <span>Binance Taker Fee (VIP 3):</span>
              <span className="font-mono text-slate-300">${(sizeUsd * 0.0003).toFixed(2)} USDT</span>
            </div>
            <div className="flex justify-between text-slate-300 text-[11px] pt-1 border-t border-slate-800">
              <span>Hedge Coverage:</span>
              <span className="text-emerald-400 font-bold">100% Token Volatility Protection</span>
            </div>
          </div>

          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-slate-400 hover:text-white"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-bold text-slate-950 bg-gradient-to-r from-amber-400 to-yellow-300 hover:from-amber-300 hover:to-yellow-200 rounded shadow-md disabled:opacity-50 cursor-pointer"
            >
              <Zap className="w-3.5 h-3.5 fill-current" />
              <span>{isSubmitting ? 'Routing to Binance...' : 'Submit Futures Hedge Order'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
