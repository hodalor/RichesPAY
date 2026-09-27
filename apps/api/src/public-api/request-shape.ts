import { getErrorDefinition } from "@richespay/shared";

import { ApiRouteError } from "../lib/api-error";

export function inferCollectionMethod(input: {
  method?: "card" | "mobile_money" | undefined;
  phone?: string | undefined;
}) {
  if (input.method) {
    return input.method;
  }

  if (input.phone) {
    return "mobile_money" as const;
  }

  throw validationError(
    "method",
    "Provide method or send a phone number to default to mobile money."
  );
}

export function inferPayoutMethod(input: {
  account_number?: string | undefined;
  bank_code?: string | undefined;
  method?: "bank" | "mobile_money" | undefined;
  phone?: string | undefined;
}) {
  if (input.method) {
    return input.method;
  }

  if (input.phone) {
    return "mobile_money" as const;
  }

  if (input.bank_code || input.account_number) {
    return "bank" as const;
  }

  throw validationError(
    "method",
    "Provide method, send a phone number for mobile money, or send bank details for a bank payout."
  );
}

export function inferCheckoutMethod(input: {
  method?: "card" | "mobile_money" | undefined;
  phone?: string | undefined;
}) {
  if (input.method) {
    return input.method;
  }

  if (input.phone) {
    return "mobile_money" as const;
  }

  throw validationError(
    "method",
    "Provide method or send a phone number to default to mobile money."
  );
}

function validationError(field: string, message: string) {
  return new ApiRouteError({
    code: "validation_error",
    field,
    message,
    statusCode: getErrorDefinition("validation_error").status
  });
}
