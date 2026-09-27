import { createHash, randomInt } from "node:crypto";

import { ApiRouteError } from "../lib/api-error";

import type { SmsMessageEncoding } from "./public-types";

const GSM7_BASIC_SET = new Set(
  [
    "@",
    "£",
    "$",
    "¥",
    "è",
    "é",
    "ù",
    "ì",
    "ò",
    "Ç",
    "\n",
    "Ø",
    "ø",
    "\r",
    "Å",
    "å",
    "Δ",
    "_",
    "Φ",
    "Γ",
    "Λ",
    "Ω",
    "Π",
    "Ψ",
    "Σ",
    "Θ",
    "Ξ",
    "\u001b",
    "Æ",
    "æ",
    "ß",
    "É",
    " ",
    "!",
    "\"",
    "#",
    "¤",
    "%",
    "&",
    "'",
    "(",
    ")",
    "*",
    "+",
    ",",
    "-",
    ".",
    "/",
    "0",
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
    ":",
    ";",
    "<",
    "=",
    ">",
    "?",
    "¡",
    "A",
    "B",
    "C",
    "D",
    "E",
    "F",
    "G",
    "H",
    "I",
    "J",
    "K",
    "L",
    "M",
    "N",
    "O",
    "P",
    "Q",
    "R",
    "S",
    "T",
    "U",
    "V",
    "W",
    "X",
    "Y",
    "Z",
    "Ä",
    "Ö",
    "Ñ",
    "Ü",
    "§",
    "¿",
    "a",
    "b",
    "c",
    "d",
    "e",
    "f",
    "g",
    "h",
    "i",
    "j",
    "k",
    "l",
    "m",
    "n",
    "o",
    "p",
    "q",
    "r",
    "s",
    "t",
    "u",
    "v",
    "w",
    "x",
    "y",
    "z",
    "ä",
    "ö",
    "ñ",
    "ü",
    "à"
  ]
);

const GSM7_EXTENSION_SET = new Set(["^", "{", "}", "\\", "[", "~", "]", "|", "€"]);

export function countSmsSegments(message: string): {
  encoding: SmsMessageEncoding;
  segments: number;
} {
  let septetLength = 0;

  for (const character of Array.from(message)) {
    if (GSM7_BASIC_SET.has(character)) {
      septetLength += 1;
      continue;
    }

    if (GSM7_EXTENSION_SET.has(character)) {
      septetLength += 2;
      continue;
    }

    const characters = Array.from(message).length;
    return {
      encoding: "ucs2",
      segments: characters <= 70 ? 1 : Math.ceil(characters / 67)
    };
  }

  return {
    encoding: "gsm7",
    segments: septetLength <= 160 ? 1 : Math.ceil(septetLength / 153)
  };
}

export function generateOtpCode(length: number): string {
  let code = "";
  for (let index = 0; index < length; index += 1) {
    code += String(randomInt(0, 10));
  }

  return code;
}

export function hashOtpCode(otpId: string, code: string): string {
  return createHash("sha256").update(`${otpId}:${code}`).digest("hex");
}

export function renderTemplate(
  template: string,
  variables: Record<string, string | number | boolean | null | undefined>
) {
  const missing = new Set<string>();
  const rendered = template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key) => {
    if (!(key in variables) || variables[key] === undefined || variables[key] === null) {
      missing.add(key);
      return "";
    }

    return String(variables[key]);
  });

  if (missing.size > 0) {
    throw new ApiRouteError({
      code: "validation_error",
      field: "variables",
      message: `Missing template variables: ${[...missing].sort().join(", ")}`,
      statusCode: 400
    });
  }

  return rendered;
}
