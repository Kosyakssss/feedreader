const MAX_QUIET: i64 = 6 * 3_600_000;
const MAX_BACKOFF: i64 = 12 * 3_600_000;

pub fn next(ok: bool, fresh: bool, fails: i64, interval: i64, base: i64) -> (i64, i64) {
    if !ok {
        return (fails + 1, interval.max(base));
    }
    let interval = if fresh || interval < base { base } else { ((interval as f64 * 1.5) as i64).min(MAX_QUIET) };
    (0, interval)
}

pub fn backoff(fails: i64, base: i64) -> i64 {
    base.saturating_mul(1i64 << fails.clamp(0, 10)).min(MAX_BACKOFF)
}
