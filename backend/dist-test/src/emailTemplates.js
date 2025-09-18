"use strict";
// backend/src/emailTemplates.ts
Object.defineProperty(exports, "__esModule", { value: true });
exports.subjectFor = subjectFor;
exports.htmlFor = htmlFor;
exports.textFor = textFor;
function subjectFor(signal) {
    var tag = signal.category === 'BEST_ENTRY' ? '⭐ Best Entry' : '✅ Ready to BUY';
    var tf = pickTF(signal); // falls back to '5m'
    return "".concat(tag, " \u2022 ").concat(signal.symbol, " @ ").concat(fmtPrice(signal.price), " (").concat(tf, ")");
}
function htmlFor(signal) {
    var _a;
    var tag = signal.category === 'BEST_ENTRY' ? '⭐ Best Entry' : '✅ Ready to BUY';
    var rows = [
        ['Symbol', signal.symbol],
        ['Category', tag],
        ['Price', fmtPrice(signal.price)],
        ['Timeframe', pickTF(signal)],
        ['RSI-9', pickRSI(signal)],
        ['VWAP Dist %', pct(signal.vwapDistancePct)],
        ['EMA200', fmtPrice(signal.ema200)],
        ['Volume (last)', signal.volume],
        ['When', new Date().toLocaleString('en-GB', { hour12: false })],
    ];
    var table = rows.map(function (_a) {
        var k = _a[0], v = _a[1];
        return "\n    <tr>\n      <td style=\"padding:6px 10px;color:#666;\">".concat(k, "</td>\n      <td style=\"padding:6px 10px;font-weight:600;color:#111;\">").concat(v !== null && v !== void 0 ? v : '-', "</td>\n    </tr>\n  ");
    }).join('');
    return "\n  <div style=\"font-family:Inter,Segoe UI,Arial,sans-serif;max-width:560px;margin:auto;border:1px solid #eee;border-radius:12px;overflow:hidden\">\n    <div style=\"background:#111;color:#fff;padding:14px 16px;font-size:16px\">\n      <strong>Pro Scalp Scanner</strong>\n    </div>\n    <div style=\"padding:16px\">\n      <h2 style=\"margin:0 0 8px 0;font-size:18px\">".concat(tag, ": ").concat(signal.symbol, "</h2>\n      <p style=\"margin:0 0 12px 0;color:#333\">Triggered at <b>").concat(fmtPrice(signal.price), "</b>. This email is informational, not financial advice.</p>\n      <table style=\"border-collapse:collapse;width:100%;font-size:14px\">").concat(table, "</table>\n      <div style=\"margin-top:16px\">\n        <a href=\"").concat((_a = signal.chartUrl) !== null && _a !== void 0 ? _a : '#', "\" style=\"display:inline-block;padding:10px 14px;background:#0ea5e9;color:#fff;text-decoration:none;border-radius:8px\">\n          Open Chart\n        </a>\n      </div>\n    </div>\n    <div style=\"background:#fafafa;color:#888;padding:10px 16px;font-size:12px\">\n      You\u2019re receiving this because you enabled email alerts for Ready to Buy / Best Entry.\n    </div>\n  </div>");
}
function textFor(signal) {
    var _a;
    var tag = signal.category === 'BEST_ENTRY' ? 'Best Entry' : 'Ready to BUY';
    return [
        "Pro Scalp Scanner \u2014 ".concat(tag),
        "Symbol: ".concat(signal.symbol),
        "Price: ".concat(fmtPrice(signal.price)),
        "TF: ".concat(pickTF(signal)),
        "RSI-9: ".concat((_a = pickRSI(signal)) !== null && _a !== void 0 ? _a : '-'),
        "VWAP Dist %: ".concat(pct(signal.vwapDistancePct)),
        "EMA200: ".concat(fmtPrice(signal.ema200)),
        "When: ".concat(new Date().toISOString()),
        signal.chartUrl ? "Chart: ".concat(signal.chartUrl) : '',
    ].filter(Boolean).join('\n');
}
/* ---------------- helpers ---------------- */
function fmtPrice(v) {
    if (v == null || Number.isNaN(v))
        return '-';
    return v >= 100 ? v.toFixed(2) : v >= 1 ? v.toFixed(4) : v.toFixed(6);
}
function pct(v) {
    if (v == null || Number.isNaN(v))
        return '-';
    return (v * 100).toFixed(2) + '%';
}
function pickTF(s) {
    // Prefer s.tf, but gracefully accept other common fields, else default '5m'
    return s.tf || s.timeframe || s.TF || s.interval || '5m';
}
function pickRSI(s) {
    var _a, _b, _c;
    // Accept rsi9, rsi_9, rsiFast, or plain rsi; return fixed 2 decimals if numeric
    var r = (_c = (_b = (_a = s.rsi9) !== null && _a !== void 0 ? _a : s.rsi_9) !== null && _b !== void 0 ? _b : s.rsiFast) !== null && _c !== void 0 ? _c : s.rsi;
    if (r == null)
        return undefined;
    var n = Number(r);
    return Number.isFinite(n) ? n.toFixed(2) : String(r);
}
