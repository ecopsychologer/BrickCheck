export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function parseMoney(value: string | undefined): number | null {
  if (!value) return null;
  const cleaned = value.replace(/[$,]/g, '').trim();
  const parsed = Number.parseFloat(cleaned);
  return Number.isFinite(parsed) ? roundMoney(parsed) : null;
}

export function formatMoney(value: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
}
