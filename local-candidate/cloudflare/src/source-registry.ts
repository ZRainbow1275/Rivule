/** Labels describe configuration, never account access or automatic task discovery. */
export const SOURCE_PROVIDERS = ['dot','spark','muse','grok','manus','kimi','deepseek','qwen','doubao','coze','dify','glm','qianfan','custom'] as const;
export type SourceProvider = typeof SOURCE_PROVIDERS[number];
// Discord's selector also needs an all-sources option, below the 25-option limit.
export const MAX_SOURCES = 16;
export function isSourceProvider(value:unknown):value is SourceProvider {
 return typeof value==='string'&&(SOURCE_PROVIDERS as readonly string[]).includes(value);
}
