import {
  ParseError,
  parsePhoneNumberWithError
} from "libphonenumber-js";
import type { CountryCode } from "libphonenumber-js";

const COUNTRY_TO_REGION: Record<string, CountryCode> = {
  GH: "GH",
  ZM: "ZM"
};

export class InvalidMobileMoneyPhoneError extends Error {
  readonly code = "invalid_phone_number";

  constructor(message: string) {
    super(message);
    this.name = "InvalidMobileMoneyPhoneError";
  }
}

export function normalizeMobileMoneyPhoneNumber(
  msisdn: string,
  countryCode: string
): string {
  const region = COUNTRY_TO_REGION[countryCode];
  if (!region) {
    throw new InvalidMobileMoneyPhoneError(
      `Unsupported mobile money country: ${countryCode}`
    );
  }

  try {
    const parsed = parsePhoneNumberWithError(msisdn, region);
    if (!parsed.isValid()) {
      throw new InvalidMobileMoneyPhoneError("The phone number is invalid.");
    }

    if (parsed.country !== region) {
      throw new InvalidMobileMoneyPhoneError(
        "The phone number country does not match the channel country."
      );
    }

    return parsed.number;
  } catch (error) {
    if (error instanceof InvalidMobileMoneyPhoneError) {
      throw error;
    }

    if (error instanceof ParseError) {
      throw new InvalidMobileMoneyPhoneError("The phone number is invalid.");
    }

    throw error;
  }
}
