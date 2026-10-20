// ─────────────────────────────────────────────
//  SHARE CARD (image of the copy-test result)
// ─────────────────────────────────────────────
async function shareCopy() {
  if (!lastCopy) return;
  const W = 1080, H = 1080, c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d'), font = getComputedStyle(document.body).fontFamily;
  const bg = g.createLinearGradient(0, 0, 0, H); bg.addColorStop(0, '#071228'); bg.addColorStop(0.6, '#12306A'); bg.addColorStop(1, '#1F4E8F');
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  g.fillStyle = '#9FB1CE'; g.font = `500 40px ${font}`; g.fillText(`$10,000 copying ${lastCopy.who}`, 80, 140);
  g.fillStyle = '#FFFFFF'; g.font = `600 150px ${font}`; g.fillText(usd(lastCopy.end, 0), 80, 300);
  g.font = `600 52px ${font}`; g.fillStyle = lastCopy.r >= 0 ? '#30D158' : '#FF453A'; g.fillText(pct(lastCopy.r), 80, 380);
  g.fillStyle = '#C7D2E3'; g.font = `500 44px ${font}`; g.fillText(`vs VOO ${pct(lastCopy.vr)}`, 80 + g.measureText(pct(lastCopy.r) + '   ').width * 1.15, 380);
  // chart
  const x0 = 80, x1 = W - 80, y0 = 470, y1 = 900, all = [...lastCopy.copySeries, ...lastCopy.vooSeries].map(p => p.value);
  const lo = Math.min(...all), hi = Math.max(...all), n = lastCopy.copySeries.length;
  const X = i => x0 + (x1 - x0) * i / Math.max(1, n - 1), Y = v => y1 - (y1 - y0) * (v - lo) / Math.max(1, hi - lo);
  const line = (pts, col, w, dash) => { g.beginPath(); g.setLineDash(dash || []); pts.forEach((p, i) => i ? g.lineTo(X(i), Y(p.value)) : g.moveTo(X(i), Y(p.value))); g.strokeStyle = col; g.lineWidth = w; g.lineJoin = 'round'; g.stroke(); g.setLineDash([]); };
  line(lastCopy.vooSeries, '#8E9BB3', 5, [14, 12]); line(lastCopy.copySeries, '#0A84FF', 8);
  g.fillStyle = '#9FB1CE'; g.font = `500 32px ${font}`;
  g.fillText(`Since ${new Date(lastCopy.start + 'T12:00:00').toLocaleDateString('en-US', {month: 'short', day: 'numeric', year: 'numeric'})} · following filings`, 80, 980);
  g.fillText('Portfolio Intel · not investment advice', 80, 1030);
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  const file = new File([blob], 'portfolio-intel-copy-test.png', {type: 'image/png'});
  try {
    if (navigator.canShare && navigator.canShare({files: [file]})) { await navigator.share({files: [file], title: 'Portfolio Intel'}); return; }
  } catch (e) { if (e.name === 'AbortError') return; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = file.name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
