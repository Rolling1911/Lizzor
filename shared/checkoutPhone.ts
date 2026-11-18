import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";
import { EUROPEAN_COUNTRIES, getEuropeanCountry } from "./europeanCountries.js";

export function splitCheckoutPhone(value: string | null | undefined, fallbackCountry = "CY") {
  const trimmed = value?.trim() ?? "";
  if (!trimmed.startsWith("+")) return { countryCode: fallbackCountry, local: trimmed };
  const parsed = parsePhoneNumberFromString(trimmed);
  if (parsed?.country && getEuropeanCountry(parsed.country)) {
    return { countryCode: parsed.country, local: parsed.nationalNumber };
  }
  const country = [...EUROPEAN_COUNTRIES].sort((a, b) => b.dialingCode.length - a.dialingCode.length)
    .find((item) => trimmed.slice(1).startsWith(item.dialingCode));
  return country ? { countryCode: country.code, local: trimmed.slice(country.dialingCode.length + 1) } : { countryCode: fallbackCountry, local: trimmed };
}

export function normalizeCheckoutPhone(value: string, countryCode: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const country = getEuropeanCountry(countryCode) ?? getEuropeanCountry("CY")!;
  const compact = trimmed.replace(/[^\d+]/g, "");
  const digits = compact.replace(/\D/g, "");
  const hasSelectedDialingCode = !compact.startsWith("+") && digits.startsWith(country.dialingCode);
  const internationalInput = compact.startsWith("+") || hasSelectedDialingCode ? `+${digits}` : null;

  if (country.code === "XK") {
    const international = internationalInput ?? `+383${digits.replace(/^0/, "")}`;
    return /^\+383\d{7,9}$/.test(international) ? international : undefined;
  }

  const parsed = internationalInput
    ? parsePhoneNumberFromString(internationalInput)
    : parsePhoneNumberFromString(trimmed, country.code as CountryCode);
  return parsed?.isPossible() && parsed.isValid() ? parsed.number : undefined;
}