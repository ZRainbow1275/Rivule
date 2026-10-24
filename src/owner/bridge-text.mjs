// Bridge text is bounded in UTF-16 code units, not bytes or grapheme clusters.
// Reject malformed Unicode and invisible direction/control characters rather
// than accepting a body that a renderer would silently replace or truncate.
export const BRIDGE_TEXT_MAX_UNITS = 1200;
export function validBridgeText(value) {
 return typeof value === 'string' && value.trim().length > 0 && value.length <= BRIDGE_TEXT_MAX_UNITS
  && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\ud800-\udfff]/u.test(value);
}
export function discordBridgeText(value) {
 if (!validBridgeText(value)) throw new Error('invalid_bridge_text');
 // Each accepted UTF-16 unit expands at most twice. 2400 is below Discord's
 // 4096 description budget. Non-whitespace edge sentinels preserve supported
 // leading/trailing whitespace against Discord embed-edge trimming.
 const escaped=value.replace(/@/g,'@\u200b').replace(/[\\`*_{}\[\]<>|~]/g,'\\$&');
 if (escaped.length > 2400) throw new Error('bridge_text_budget_exceeded');
 return '\u200b'+escaped+'\u200b';
}
