export type CurrencyCode = "GHS" | "ZMW" | "USD";

export const CURRENCIES: Record<
  CurrencyCode,
  { code: CurrencyCode; minorUnits: number }
> = {
  GHS: { code: "GHS", minorUnits: 2 },
  ZMW: { code: "ZMW", minorUnits: 2 },
  USD: { code: "USD", minorUnits: 2 }
};

const INTEGER_GROUP_FORMATTER = new Map<string, Intl.NumberFormat>();
const CURRENCY_FORMATTER = new Map<string, Intl.NumberFormat>();

function assertCurrency(currency: string): asserts currency is CurrencyCode {
  if (!(currency in CURRENCIES)) {
    throw new Error(`Unsupported currency: ${currency}`);
  }
}

export function toMinor(value: string | bigint, currency: CurrencyCode): bigint {
  const { minorUnits } = CURRENCIES[currency];

  if (typeof value === "bigint") {
    return value;
  }

  const normalized = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) {
    throw new Error(`Invalid money value: ${value}`);
  }

  const sign = normalized.startsWith("-") ? -1n : 1n;
  const unsigned = normalized.replace(/^-/, "");
  const [whole = "0", fraction = ""] = unsigned.split(".");

  if (fraction.length > minorUnits) {
    throw new Error(
      `Too many fractional digits for ${currency}: expected at most ${minorUnits}`
    );
  }

  const paddedFraction = fraction.padEnd(minorUnits, "0");
  const wholePart = whole.replace(/^0+(?=\d)/, "") || "0";
  const minorString =
    minorUnits === 0 ? wholePart : `${wholePart}${paddedFraction}`;

  return sign * BigInt(minorString);
}

export function fromMinor(amountMinor: bigint, currency: CurrencyCode): string {
  const { minorUnits } = CURRENCIES[currency];
  const sign = amountMinor < 0 ? "-" : "";
  const absolute = amountMinor < 0 ? -amountMinor : amountMinor;

  if (minorUnits === 0) {
    return `${sign}${absolute.toString()}`;
  }

  const raw = absolute.toString().padStart(minorUnits + 1, "0");
  const integerPart = raw.slice(0, -minorUnits);
  const fractionPart = raw.slice(-minorUnits);

  return `${sign}${integerPart}.${fractionPart}`;
}

function getIntegerGroupFormatter(locale: string): Intl.NumberFormat {
  const cacheKey = locale;

  let formatter = INTEGER_GROUP_FORMATTER.get(cacheKey);
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, {
      maximumFractionDigits: 0,
      minimumFractionDigits: 0,
      useGrouping: true
    });
    INTEGER_GROUP_FORMATTER.set(cacheKey, formatter);
  }

  return formatter;
}

function getCurrencyFormatter(
  locale: string,
  currency: CurrencyCode
): Intl.NumberFormat {
  const cacheKey = `${locale}:${currency}`;

  let formatter = CURRENCY_FORMATTER.get(cacheKey);
  if (!formatter) {
    const { minorUnits } = CURRENCIES[currency];
    formatter = new Intl.NumberFormat(locale, {
      currency,
      currencyDisplay: "symbol",
      maximumFractionDigits: minorUnits,
      minimumFractionDigits: minorUnits,
      style: "currency"
    });
    CURRENCY_FORMATTER.set(cacheKey, formatter);
  }

  return formatter;
}

export function formatMoney(
  amountMinor: bigint,
  currencyInput: CurrencyCode,
  locale: string
): string {
  assertCurrency(currencyInput);

  const currency = currencyInput;
  const formatter = getCurrencyFormatter(locale, currency);
  const integerFormatter = getIntegerGroupFormatter(locale);
  const decimalString = fromMinor(amountMinor, currency);
  const negative = decimalString.startsWith("-");
  const [integerRaw = "0", fractionRaw = ""] = decimalString
    .replace(/^-/, "")
    .split(".");
  const parts = formatter.formatToParts(negative ? -1234.56 : 1234.56);
  const formattedInteger = integerFormatter.format(BigInt(integerRaw));

  let integerInserted = false;
  let fractionInserted = false;

  return parts
    .map((part) => {
      if (part.type === "integer") {
        if (integerInserted) {
          return "";
        }

        integerInserted = true;
        return formattedInteger;
      }

      if (part.type === "group") {
        return "";
      }

      if (part.type === "fraction") {
        if (fractionInserted) {
          return "";
        }

        fractionInserted = true;
        return fractionRaw;
      }

      return part.value;
    })
    .join("");
}
