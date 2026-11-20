// Lining up two versions of a file: which line of one corresponds to which line of the other, and how much changed.

// For every line of a (0-based), the corresponding line of b. Matched lines map exactly (longest common subsequence),
// lines in between are spread evenly over the gap between their matched neighbours.
export function alignLines(a, b) {
  const n = a.length, m = b.length;
  const map = new Int32Array(n).fill(-1);
  let s = 0;
  while (s < n && s < m && a[s] === b[s]) { map[s] = s; s++; }
  let ea = n, eb = m;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; map[ea] = eb; }
  const A = a.slice(s, ea), B = b.slice(s, eb);
  if (A.length && B.length) {
    if (A.length * B.length <= 4e6) {
      const N = A.length, M = B.length;
      const dp = Array.from({ length: N + 1 }, () => new Uint32Array(M + 1));
      for (let i = N - 1; i >= 0; i--) for (let j = M - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      let i = 0, j = 0;
      while (i < N && j < M) {
        if (A[i] === B[j]) { map[s + i] = s + j; i++; j++; }
        else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
        else j++;
      }
    }
  }
  // fill the unmatched lines between matched neighbours
  let prevA = -1, prevB = -1;
  for (let i = 0; i <= n; i++) {
    if (i < n && map[i] < 0) continue;
    const nextB = i < n ? map[i] : m;
    const gap = i - prevA - 1;
    for (let k = 1; k <= gap; k++) {
      const t = k / (gap + 1);
      map[prevA + k] = Math.min(m - 1, Math.max(0, Math.round(prevB + t * (nextB - prevB))));
    }
    prevA = i;
    prevB = nextB;
  }
  return map;
}

// Lines added to b and removed from a.
export function diffStats(a, b) {
  const map = alignLines(a, b);
  let common = 0;
  for (let i = 0; i < a.length; i++) if (map[i] >= 0 && a[i] === b[map[i]]) common++;
  return { added: b.length - common, removed: a.length - common, same: a.length === b.length && common === a.length };
}

// 1-based line of `from` -> 1-based line of `to`.
export function mapLine(from, to, line) {
  const a = from.split('\n'), b = to.split('\n');
  const map = alignLines(a, b);
  const i = Math.max(0, Math.min(a.length - 1, line - 1));
  return (map[i] >= 0 ? map[i] : 0) + 1;
}
