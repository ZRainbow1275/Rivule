/** Build-time type boundary only. Runtime uses exact production safeUrl. */
export function safeUrl(_value:unknown):string|null {throw Error("production_bridge_required");}
