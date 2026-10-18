async function verifyDiscordInteraction(request, b, publicKey, guildId, now = Date.now()) {
  if (request.method !== "POST" || new URL(request.url).origin !== b.publicOrigin || new URL(request.url).search || request.headers.has("authorization")) throw new Rejected("invalid_interaction", 403);
  if (!/^[a-fA-F0-9]{64}$/.test(publicKey)) throw new Rejected("interaction_key_not_configured", 503);
  const stamp = request.headers.get("x-signature-timestamp") ?? "", sig = request.headers.get("x-signature-ed25519") ?? "";
  if (!/^\d{1,14}$/.test(stamp) || Math.abs(now / 1e3 - Number(stamp)) > 300 || !/^[a-fA-F0-9]{128}$/.test(sig)) throw new Rejected("invalid_interaction_signature", 401);
  const reader = request.body?.getReader();
  const chunks = [];
  let size = 0;
  if (!reader) throw new Rejected("invalid_interaction", 400);
  while (true) {
    const r = await reader.read();
    if (r.done) break;
    size += r.value.length;
    if (size > 65536) {
      await reader.cancel();
      throw new Rejected("body_too_large", 413);
    }
    chunks.push(r.value);
  }
  const prefix = new TextEncoder().encode(stamp), bytes = new Uint8Array(size + prefix.length);
  bytes.set(prefix);
  let offset = prefix.length;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  const hex2 = /* @__PURE__ */ __name((s) => new Uint8Array(s.match(/.{2}/g).map((x) => parseInt(x, 16))), "hex");
  const key = await crypto.subtle.importKey("raw", hex2(publicKey), { name: "Ed25519" }, false, ["verify"]);
  if (!await crypto.subtle.verify("Ed25519", key, hex2(sig), bytes)) throw new Rejected("invalid_interaction_signature", 401);
  let p;
  try {
    p = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes.subarray(prefix.length)));
  } catch {
    throw new Rejected("invalid_interaction", 400);
  }
  if (p.application_id !== b.appId || !/^\d{1,25}$/.test(p.id ?? "")) throw new Rejected("invalid_interaction_identity", 403);
  if (p.type === 1) return p;
  const actor = p.user ?? p.member?.user;
  if (!actor || actor.id !== b.userId || actor.bot === true || p.context !== 1 || p.channel_id !== b.dmId || p.guild_id) throw new Rejected("owner_dm_required", 403);
  if (p.user && p.member?.user && p.user.id !== p.member.user.id) throw new Rejected("actor_mismatch", 403);
  const install = p.authorizing_integration_owners;
  if (!install || !(install["0"] === "0" || install["1"] === b.userId) || Object.keys(install).some((k) => !["0", "1"].includes(k))) throw new Rejected("installation_not_bound", 403);
  if (p.type !== 3 || p.message?.channel_id && p.message.channel_id !== b.dmId || p.message?.author?.id !== b.appId) throw new Rejected("unsupported_interaction", 403);
  return p;
}
