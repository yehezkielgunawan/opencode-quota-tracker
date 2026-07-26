const tokenFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
})

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

export type Timestamp = Date | number

export function formatTokens(tokens: number): string {
  return tokenFormatter.format(tokens)
}

export function formatUsd(amount: number): string {
  return usdFormatter.format(amount)
}

export function formatResetCountdown(resetsAt: Timestamp, now: Timestamp): string {
  const resetTime = resetsAt instanceof Date ? resetsAt.getTime() : resetsAt
  const currentTime = now instanceof Date ? now.getTime() : now

  if (!Number.isFinite(resetTime) || !Number.isFinite(currentTime)) return "unknown"

  const millisecondsRemaining = resetTime - currentTime
  if (millisecondsRemaining <= 0) return "now"

  const totalMinutes = Math.ceil(millisecondsRemaining / 60_000)
  const days = Math.floor(totalMinutes / (24 * 60))
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60)
  const minutes = totalMinutes % 60

  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  return `${minutes}m`
}
