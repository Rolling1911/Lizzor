export interface EuropeanCountry {
  code: string;
  name: string;
  dialingCode: string;
  flag: string;
}

export const EUROPEAN_COUNTRIES: readonly EuropeanCountry[] = [
  { code: "AL", name: "Albania", dialingCode: "355", flag: "🇦🇱" },
  { code: "AD", name: "Andorra", dialingCode: "376", flag: "🇦🇩" },
  { code: "AT", name: "Austria", dialingCode: "43", flag: "🇦🇹" },
  { code: "BE", name: "Belgium", dialingCode: "32", flag: "🇧🇪" },
  { code: "BA", name: "Bosnia and Herzegovina", dialingCode: "387", flag: "🇧🇦" },
  { code: "BG", name: "Bulgaria", dialingCode: "359", flag: "🇧🇬" },
  { code: "HR", name: "Croatia", dialingCode: "385", flag: "🇭🇷" },
  { code: "CY", name: "Cyprus", dialingCode: "357", flag: "🇨🇾" },
  { code: "CZ", name: "Czechia", dialingCode: "420", flag: "🇨🇿" },
  { code: "DK", name: "Denmark", dialingCode: "45", flag: "🇩🇰" },
  { code: "EE", name: "Estonia", dialingCode: "372", flag: "🇪🇪" },
  { code: "FI", name: "Finland", dialingCode: "358", flag: "🇫🇮" },
  { code: "FR", name: "France", dialingCode: "33", flag: "🇫🇷" },
  { code: "DE", name: "Germany", dialingCode: "49", flag: "🇩🇪" },
  { code: "GR", name: "Greece", dialingCode: "30", flag: "🇬🇷" },
  { code: "HU", name: "Hungary", dialingCode: "36", flag: "🇭🇺" },
  { code: "IS", name: "Iceland", dialingCode: "354", flag: "🇮🇸" },
  { code: "IE", name: "Ireland", dialingCode: "353", flag: "🇮🇪" },
  { code: "IT", name: "Italy", dialingCode: "39", flag: "🇮🇹" },
  { code: "XK", name: "Kosovo", dialingCode: "383", flag: "🇽🇰" },
  { code: "LV", name: "Latvia", dialingCode: "371", flag: "🇱🇻" },
  { code: "LI", name: "Liechtenstein", dialingCode: "423", flag: "🇱🇮" },
  { code: "LT", name: "Lithuania", dialingCode: "370", flag: "🇱🇹" },
  { code: "LU", name: "Luxembourg", dialingCode: "352", flag: "🇱🇺" },
  { code: "MT", name: "Malta", dialingCode: "356", flag: "🇲🇹" },
  { code: "MD", name: "Moldova", dialingCode: "373", flag: "🇲🇩" },
  { code: "MC", name: "Monaco", dialingCode: "377", flag: "🇲🇨" },
  { code: "ME", name: "Montenegro", dialingCode: "382", flag: "🇲🇪" },
  { code: "NL", name: "Netherlands", dialingCode: "31", flag: "🇳🇱" },
  { code: "MK", name: "North Macedonia", dialingCode: "389", flag: "🇲🇰" },
  { code: "NO", name: "Norway", dialingCode: "47", flag: "🇳🇴" },
  { code: "PL", name: "Poland", dialingCode: "48", flag: "🇵🇱" },
  { code: "PT", name: "Portugal", dialingCode: "351", flag: "🇵🇹" },
  { code: "RO", name: "Romania", dialingCode: "40", flag: "🇷🇴" },
  { code: "SM", name: "San Marino", dialingCode: "378", flag: "🇸🇲" },
  { code: "RS", name: "Serbia", dialingCode: "381", flag: "🇷🇸" },
  { code: "SK", name: "Slovakia", dialingCode: "421", flag: "🇸🇰" },
  { code: "SI", name: "Slovenia", dialingCode: "386", flag: "🇸🇮" },
  { code: "ES", name: "Spain", dialingCode: "34", flag: "🇪🇸" },
  { code: "SE", name: "Sweden", dialingCode: "46", flag: "🇸🇪" },
  { code: "CH", name: "Switzerland", dialingCode: "41", flag: "🇨🇭" },
  { code: "TR", name: "Turkey", dialingCode: "90", flag: "🇹🇷" },
  { code: "UA", name: "Ukraine", dialingCode: "380", flag: "🇺🇦" },
  { code: "GB", name: "United Kingdom", dialingCode: "44", flag: "🇬🇧" },
];

export function getEuropeanCountry(code: string): EuropeanCountry | undefined {
  return EUROPEAN_COUNTRIES.find((country) => country.code === code.trim().toUpperCase());
}

export const EUROPEAN_COUNTRY_NAMES = EUROPEAN_COUNTRIES.map((country) => country.name);