import { AUTHORIZED_SENDER } from "./address";

export type MimeAttachment = {
  filename: string;
  mime: string;
  contentBase64: string;
  contentId: string;
};

function b64lines(b64: string): string {
  return b64.replace(/(.{76})/g, "$1\r\n");
}

function encodedSubject(subject: string): string {
  const ascii = [...subject].every((c) => c.charCodeAt(0) < 128);
  return ascii ? subject : `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
}

export function buildRawMessage(input: {
  from: string;
  to: string;
  subject: string;
  body: string;
  attachments?: MimeAttachment[];
}): string {
  const from = input.from.trim().toLowerCase();
  if (from !== AUTHORIZED_SENDER) throw new Error(`From must be ${AUTHORIZED_SENDER}`);
  const attachments = input.attachments ?? [];
  const mix = `bmsm-mix-${Date.now().toString(36)}`;
  const rel = `bmsm-rel-${Date.now().toString(36)}`;
  const lines = [
    `From: ${AUTHORIZED_SENDER}`,
    `To: ${input.to}`,
    `Subject: ${encodedSubject(input.subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${mix}"`,
    "",
    `--${mix}`,
    `Content-Type: multipart/related; boundary="${rel}"`,
    "",
    `--${rel}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    b64lines(Buffer.from(input.body, "utf8").toString("base64")),
  ];
  for (const a of attachments) {
    lines.push(
      `--${rel}`,
      `Content-Type: ${a.mime}; name="${a.filename}"`,
      "Content-Transfer-Encoding: base64",
      `Content-ID: <${a.contentId}>`,
      `Content-Disposition: inline; filename="${a.filename}"`,
      "",
      b64lines(a.contentBase64),
    );
  }
  lines.push(`--${rel}--`, `--${mix}--`, "");
  return Buffer.from(lines.join("\r\n")).toString("base64url");
}
