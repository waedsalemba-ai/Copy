/**
 * Centralized formatting utilities for Solana, USD, token quantities, and addresses.
 */

export function formatSol(
  val: number | null | undefined,
  decimals = 2,
  showSign = false
): string {
  if (val === null || val === undefined || !Number.isFinite(val)) {
    return '0.00 SOL';
  }
  const sign = showSign && val > 0 ? '+' : '';
  return `${sign}${val.toFixed(decimals)} SOL`;
}

export function formatUsd(
  val: number | null | undefined,
  decimals = 0
): string {
  if (val === null || val === undefined || !Number.isFinite(val)) {
    return '$0';
  }
  if (decimals === 0) {
    return `$${Math.round(val).toLocaleString()}`;
  }
  return `$${val.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

export function formatRoi(percent: number | null | undefined): string {
  if (percent === null || percent === undefined || !Number.isFinite(percent)) {
    return '0.00%';
  }
  const sign = percent > 0 ? '+' : '';
  return `${sign}${percent.toFixed(2)}%`;
}

export function formatAddress(
  address: string | null | undefined,
  prefixLen = 4,
  suffixLen = 4
): string {
  if (!address) return '—';
  if (address.length <= prefixLen + suffixLen + 2) return address;
  return `${address.slice(0, prefixLen)}...${address.slice(-suffixLen)}`;
}

export function formatTokenQuantity(quantity: number): string {
  if (!Number.isFinite(quantity)) return '—';

  const absoluteQuantity = Math.abs(quantity);
  if (absoluteQuantity === 0) return '0';
  if (absoluteQuantity >= 1000) {
    return quantity.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  if (absoluteQuantity >= 1) {
    return quantity.toLocaleString(undefined, { maximumFractionDigits: 6 });
  }
  if (absoluteQuantity >= 0.0001) {
    return quantity.toLocaleString(undefined, { maximumFractionDigits: 8 });
  }

  return quantity.toExponential(4);
}
