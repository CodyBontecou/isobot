import crypto from "node:crypto";

export function verifySignature(secret: string, body: Buffer, header: string | undefined): boolean {
  if (!header) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
