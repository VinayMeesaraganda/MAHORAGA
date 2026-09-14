/** Bounded reads; errors deliberately exclude request URLs, tokens and provider bodies. */
export async function fetchText(
  url: string,
  headers: Record<string, string> = {},
  maxBytes = 1_000_000
): Promise<string> {
  // Workers support manual/follow, not redirect:error. A 3xx fails the status check below.
  const response = await fetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw Error(`Source returned HTTP ${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw Error("Empty source response");
  const parts: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > maxBytes) {
      await reader.cancel();
      throw Error("Source response too large");
    }
    parts.push(value);
  }
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const p of parts) {
    joined.set(p, offset);
    offset += p.length;
  }
  return new TextDecoder().decode(joined);
}
export async function readBody(request: Request, maxBytes = 1_000_000): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) return {};
  const decoder = new TextDecoder();
  let text = "",
    length = 0;
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    length += r.value.length;
    if (length > maxBytes) {
      await reader.cancel();
      throw Error("Request too large");
    }
    text += decoder.decode(r.value, { stream: true });
  }
  return JSON.parse(text + decoder.decode() || "{}");
}
export async function authorized(request: Request, secret: string | undefined): Promise<boolean> {
  if (!secret) return false;
  const supplied = request.headers.get("Authorization");
  if (!supplied?.startsWith("Bearer ")) return false;
  const enc = new TextEncoder(),
    key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
      "verify",
    ]);
  const expected = await crypto.subtle.sign("HMAC", key, enc.encode(secret));
  return crypto.subtle.verify("HMAC", key, expected, enc.encode(supplied.slice(7)));
}
