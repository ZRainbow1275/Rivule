export function validOrigin(value) {
  return ['https://rivule-bridge.hybridrevis.workers.dev','http://127.0.0.1:8791'].includes(value);
}
export function conversationUrl(value,platform) {
  try {const u=new URL(value);if(u.username||u.password||u.search||u.hash)return false;
    return platform==='chatgpt'?u.origin==='https://chatgpt.com'&&/^\/c\/[a-zA-Z0-9-]+$/.test(u.pathname):platform==='gemini'?u.origin==='https://gemini.google.com'&&/^\/app\/[a-zA-Z0-9_-]+$/.test(u.pathname):false;
  }catch{return false;}
}
export function sameBinding(config,sender) {return config?.armed===true && conversationUrl(config.url,config.platform) && sender.url===config.url;}
export function modeAllowed(platform,label) {return platform==='chatgpt'?/\bpro\b/i.test(label):platform==='gemini'?/\btasks?\b|任务/.test(label):false;}
export function safeSendLabel(label) {return /^(send|send prompt|send message|发送|发送消息|发送提示|wyślij)$/i.test(label.trim());}
