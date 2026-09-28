const a4Width = 595;
const a4Height = 842;
const left = 50;
const top = 792;
const bodySize = 10;
const codeSize = 8;
const titleSize = 16;
const headingSize = 12;
const lineHeight = 13;
const codeLineHeight = 10;
const maxBodyWidth = 88;
const maxCodeWidth = 96;

interface PdfBlock {
  kind: "title" | "heading" | "body" | "code";
  text: string;
}

/**
 * Public merchant guide. One job per section, one snippet.
 * Provider and MNO integration details stay out of this PDF.
 */
const publicGuide: PdfBlock[] = [
  { kind: "title", text: "RichesPay API" },
  {
    kind: "body",
    text: "Call https://api.richespay.com/v1 with JSON. Authenticate with Authorization: Bearer rp_test_sk_... or rp_live_sk_.... New merchants start in test mode. Live keys unlock after KYB approval."
  },
  {
    kind: "body",
    text: "Amounts are integers in minor units. POST requests that move money or send SMS or airtime require an Idempotency-Key header. Success is { data }. Errors are { error: { code, message, field, request_id } }."
  },

  { kind: "heading", text: "Collect a payment" },
  {
    kind: "body",
    text: "Phone implies mobile money. Keep your reference stable so webhooks match your order."
  },
  {
    kind: "code",
    text: `curl https://api.richespay.com/v1/collections \\
  -H "Authorization: Bearer rp_test_sk_..." \\
  -H "Idempotency-Key: order-1001" \\
  -d '{"amount":5000,"currency":"ZMW","phone":"+260970000001","reference":"ORDER-1001"}'`
  },
  {
    kind: "body",
    text: "Response data includes id (col_...), status, amount, currency, phone, network, and reference. Status becomes successful or failed on the webhook."
  },

  { kind: "heading", text: "Send a payout" },
  {
    kind: "code",
    text: `curl https://api.richespay.com/v1/payouts \\
  -H "Authorization: Bearer rp_test_sk_..." \\
  -H "Idempotency-Key: payout-1001" \\
  -d '{"amount":2000,"currency":"GHS","phone":"+233241230001","reference":"PAY-1001"}'`
  },

  { kind: "heading", text: "Send SMS" },
  {
    kind: "code",
    text: `curl https://api.richespay.com/v1/sms \\
  -H "Authorization: Bearer rp_test_sk_..." \\
  -H "Idempotency-Key: sms-1001" \\
  -d '{"to":"+233241230001","message":"Payment received.","type":"transactional"}'`
  },

  { kind: "heading", text: "Send airtime" },
  {
    kind: "body",
    text: "Face value is in the recipient currency. You are charged in your settlement currency after the network discount."
  },
  {
    kind: "code",
    text: `curl https://api.richespay.com/v1/airtime \\
  -H "Authorization: Bearer rp_test_sk_..." \\
  -H "Idempotency-Key: reward-221" \\
  -d '{"phone":"+260970000001","amount":1000,"currency":"ZMW","reference":"REWARD-221"}'`
  },
  {
    kind: "code",
    text: `{
  "data": {
    "id": "air_...",
    "status": "pending",
    "phone": "+260970000001",
    "network": "MTN",
    "amount": 1000,
    "currency": "ZMW",
    "charge_amount": 970,
    "charge_currency": "ZMW",
    "reference": "REWARD-221"
  }
}`
  },

  { kind: "heading", text: "Webhooks" },
  {
    kind: "body",
    text: "When a collection, payout, SMS, or airtime order finishes, RichesPay POSTs JSON to your webhook URL. Your endpoint must be publicly reachable, accept POST, and respond with HTTP 200."
  },
  {
    kind: "code",
    text: `{
  "id": "evt_...",
  "type": "airtime.successful",
  "created_at": "2026-09-28T06:11:39.000Z",
  "mode": "live",
  "data": {
    "airtime_id": "air_...",
    "status": "successful",
    "phone": "+260970000001",
    "network": "MTN",
    "amount": 1000,
    "currency": "ZMW",
    "reference": "REWARD-221"
  }
}`
  },
  {
    kind: "body",
    text: "Header: RichesPay-Signature: t=<unix>,v1=<hex HMAC-SHA256 of \"t.body\">. Verify the signature on the raw body before you parse JSON. Use data.id or your reference to match the event to the original request."
  },
  {
    kind: "body",
    text: "collection.successful / payout.successful / airtime.successful: fulfil the order. *.failed: stop and notify the customer. airtime_batch.completed: the bulk run finished; read accepted, rejected, successful, and failed."
  },
  {
    kind: "body",
    text: "If a webhook is missed, GET the resource (/v1/collections/:id, /v1/payouts/:id, /v1/airtime/:id) and treat that status the same way."
  },

  { kind: "heading", text: "Errors" },
  {
    kind: "body",
    text: "product_not_enabled 403. invalid_phone_number 400. network_not_supported 400. amount_not_allowed 400. insufficient_funds 409. airtime_unavailable 503. idempotency_conflict 409."
  }
];

export function renderApiPdf(): Buffer {
  const commandsByPage: string[][] = [];
  let commands = startPageCommands();
  let y = top;

  const flushPage = () => {
    commands.push("ET");
    commandsByPage.push(commands);
    commands = startPageCommands();
    y = top;
  };

  const ensureSpace = (needed: number) => {
    if (y - needed < 50) {
      flushPage();
    }
  };

  for (const block of publicGuide) {
    if (block.kind === "title") {
      ensureSpace(titleSize + 18);
      writeLine(commands, titleSize, y, block.text);
      y -= titleSize + 8;
      continue;
    }

    if (block.kind === "heading") {
      ensureSpace(headingSize + 20);
      y -= 6;
      writeLine(commands, headingSize, y, block.text);
      y -= headingSize + 6;
      continue;
    }

    const size = block.kind === "code" ? codeSize : bodySize;
    const leading = block.kind === "code" ? codeLineHeight : lineHeight;
    const width = block.kind === "code" ? maxCodeWidth : maxBodyWidth;
    const lines =
      block.kind === "code" ? wrapCode(block.text, width) : wrapBody(block.text, width);

    for (const line of lines) {
      ensureSpace(leading + 2);
      writeLine(commands, size, y, line.length === 0 ? " " : line);
      y -= leading;
    }

    y -= 4;
  }

  flushPage();

  return buildPdf(commandsByPage);
}

function startPageCommands() {
  return ["BT"];
}

function writeLine(commands: string[], size: number, y: number, text: string) {
  commands.push(`/F1 ${size} Tf`);
  commands.push(`1 0 0 1 ${left} ${y} Tm`);
  commands.push(`(${escapePdfText(text)}) Tj`);
}

function wrapBody(text: string, width: number) {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > width) {
      if (current) lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }

  if (current) {
    lines.push(current);
  }

  return lines;
}

function wrapCode(text: string, width: number) {
  return text.split("\n").flatMap((line) => {
    if (line.length <= width) {
      return [line];
    }

    const parts: string[] = [];
    for (let index = 0; index < line.length; index += width) {
      parts.push(line.slice(index, index + width));
    }
    return parts;
  });
}

function buildPdf(pages: string[][]): Buffer {
  const objects: string[] = [];
  const pageObjectIds: number[] = [];
  let nextId = 4;

  for (const commands of pages) {
    const contentId = nextId;
    const pageId = nextId + 1;
    nextId += 2;
    pageObjectIds.push(pageId);
    const stream = commands.join("\n");
    objects.push(
      `${contentId} 0 obj\n<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream\nendobj\n`
    );
    objects.push(
      `${pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${a4Width} ${a4Height}] /Contents ${contentId} 0 R /Resources << /Font << /F1 3 0 R >> >> >>\nendobj\n`
    );
  }

  const kids = pageObjectIds.map((id) => `${id} 0 R`).join(" ");
  const catalog = "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n";
  const pageTree = `2 0 obj\n<< /Type /Pages /Count ${pages.length} /Kids [${kids}] >>\nendobj\n`;
  const font = "3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n";
  const objectPieces = [catalog, pageTree, font, ...objects];
  let cursor = Buffer.byteLength("%PDF-1.4\n");
  const offsets = objectPieces.map((piece) => {
    const offset = cursor;
    cursor += Buffer.byteLength(piece);
    return offset;
  });
  const xrefStart = cursor;
  let xref = `xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n`;

  for (const offset of offsets) {
    xref += `${offset.toString().padStart(10, "0")} 00000 n \n`;
  }

  const trailer = `trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  return Buffer.from(`%PDF-1.4\n${objectPieces.join("")}${xref}${trailer}`, "utf8");
}

function escapePdfText(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}
