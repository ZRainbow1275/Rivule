/** Original neutral letter badges for this public variant.
 * M and S identify Muse and Gemini Spark in text; these are not product logos.
 * The Zot badge is original project artwork. Never accept source-event image data.
 */
export const MUSE_ICON_DATA="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0OCIgaGVpZ2h0PSI0OCIgdmlld0JveD0iMCAwIDQ4IDQ4Ij48cmVjdCB3aWR0aD0iNDgiIGhlaWdodD0iNDgiIHJ4PSIxMSIgZmlsbD0iI0RCRUFGRSIvPjxwYXRoIGQ9Ik0xMCAzNVYxM0gxNkwyNCAyNUwzMiAxM0gzOFYzNUgzMlYyM0wyNCAzNUwxNiAyM1YzNVoiIGZpbGw9IiMyNTYzRUIiLz48L3N2Zz4=";
const SPARK_PATHS="<rect width=\"66\" height=\"66\" rx=\"15\" fill=\"#DBEAFE\"/><path d=\"M48 18H26C17 18 14 23 14 29C14 36 20 39 28 39H38C42 39 43 41 43 43C43 46 41 48 37 48H16V56H38C48 56 53 51 53 43C53 35 47 31 39 31H28C24 31 23 29 23 27C23 25 25 24 28 24H48Z\" fill=\"#2563EB\"/>";
export function sourceIcon(provider:string,x:number,y:number):string {
 if(provider==='muse')return `<image x="${x}" y="${y}" width="24" height="24" href="${MUSE_ICON_DATA}"/>`;
 if(provider==='spark')return `<g transform="translate(${x} ${y}) scale(${24/66})">${SPARK_PATHS}</g>`;
 if(provider!=='dot')return `<circle cx="${x+12}" cy="${y+12}" r="10" fill="#DDE4EA"/>`;
 return `<rect x="${x}" y="${y}" width="24" height="24" rx="7" fill="#F5E6DB"/><text x="${x+6}" y="${y+18}" fill="#9B582F" font-size="17" font-family="Noto Sans CJK SC">Z</text>`;
}
